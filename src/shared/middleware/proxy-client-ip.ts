import { Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { isIP } from 'net';

/**
 * IP real del cliente detrás del proxy de las apps (O1-OPS-1, contrato O1
 * §11 bis). Las apps Next llaman a `/api/v1/*` de su propio origen y lo
 * reenvían al backend desde Vercel: sin esto, el límite de peticiones, el
 * bloqueo progresivo del login, la bitácora y las sesiones verían la IP de
 * Vercel para todos los usuarios.
 *
 * El proxy de cada app añade:
 * - `X-DOC-Client-IP`: IP del cliente según la plataforma;
 * - `X-DOC-Proxy-Timestamp`: segundos Unix del momento de la firma;
 * - `X-DOC-Proxy-Signature`: HMAC-SHA256 en hexadecimal, con
 *   `PROXY_SHARED_SECRET`, de `MÉTODO|RUTA_CON_QUERY|IP|TIMESTAMP` (la ruta
 *   tal como llega al backend, p. ej. `/v1/auth/login?x=1`, con la query en
 *   forma canónica: ver `canonicalPathWithQuery`).
 *
 * Solo si la firma es válida (con cualquiera de los secretos, para rotar sin
 * corte) y la marca de tiempo está a ±60 s, `request.ip` pasa a ser esa IP.
 * Si no, se queda la de la conexión según `trust proxy`. Sin secreto
 * configurado, la función está desactivada y las cabeceras se ignoran.
 */

export const PROXY_CLIENT_IP_HEADER = 'x-doc-client-ip';
export const PROXY_TIMESTAMP_HEADER = 'x-doc-proxy-timestamp';
export const PROXY_SIGNATURE_HEADER = 'x-doc-proxy-signature';

/** Validez de la firma: diferencia máxima con el reloj del backend. */
export const PROXY_SIGNATURE_MAX_SKEW_SECONDS = 60;

/** Longitud mínima de cada secreto (`openssl rand -hex 32`). */
export const PROXY_SECRET_MIN_LENGTH = 32;

/** `PROXY_SHARED_SECRET` → lista de secretos (separados por comas). */
export function parseProxySecrets(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((secret) => secret.trim())
    .filter((secret) => secret.length > 0);
}

/**
 * Ruta con la query en forma canónica: la ruta tal cual y la query
 * reserializada con `URLSearchParams` (mismo orden; espacio → `+`). Los
 * proxies (Next, Vercel) pueden volver a codificar la query al reenviarla
 * (`%20` ↔ `+`); así la firma no depende de ello. Las apps hacen lo mismo.
 */
export function canonicalPathWithQuery(pathWithQuery: string): string {
  const index = pathWithQuery.indexOf('?');
  if (index === -1) {
    return pathWithQuery;
  }
  const query = new URLSearchParams(pathWithQuery.slice(index + 1)).toString();
  const path = pathWithQuery.slice(0, index);
  return query === '' ? path : `${path}?${query}`;
}

/** Texto firmado: `MÉTODO|RUTA_CON_QUERY|IP|TIMESTAMP` (ruta canónica). */
export function proxySignaturePayload(
  method: string,
  pathWithQuery: string,
  ip: string,
  timestamp: string,
): string {
  return `${method.toUpperCase()}|${canonicalPathWithQuery(pathWithQuery)}|${ip}|${timestamp}`;
}

/** Firma del proxy (HMAC-SHA256 en hexadecimal). La usan las pruebas. */
export function signProxyRequest(
  secret: string,
  method: string,
  pathWithQuery: string,
  ip: string,
  timestamp: string,
): string {
  return createHmac('sha256', secret)
    .update(proxySignaturePayload(method, pathWithQuery, ip, timestamp))
    .digest('hex');
}

export type ProxyClientIpResult =
  | { ok: true; ip: string }
  | {
      ok: false;
      reason:
        | 'disabled'
        | 'absent'
        | 'incomplete'
        | 'invalid-ip'
        | 'invalid-timestamp'
        | 'expired'
        | 'invalid-signature';
    };

export interface ProxyClientIpInput {
  method: string;
  pathWithQuery: string;
  headers: Record<string, string | string[] | undefined>;
  secrets: readonly string[];
  /** Milisegundos Unix (inyectable en las pruebas). */
  now: number;
}

function singleHeader(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

const TIMESTAMP_PATTERN = /^\d{1,12}$/;
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/i;

/** Comprueba las cabeceras firmadas y devuelve la IP del cliente si valen. */
export function resolveProxyClientIp(
  input: ProxyClientIpInput,
): ProxyClientIpResult {
  if (input.secrets.length === 0) {
    return { ok: false, reason: 'disabled' };
  }
  const ip = singleHeader(input.headers[PROXY_CLIENT_IP_HEADER]);
  const timestamp = singleHeader(input.headers[PROXY_TIMESTAMP_HEADER]);
  const signature = singleHeader(input.headers[PROXY_SIGNATURE_HEADER]);
  if (ip === null && timestamp === null && signature === null) {
    return { ok: false, reason: 'absent' };
  }
  if (ip === null || timestamp === null || signature === null) {
    return { ok: false, reason: 'incomplete' };
  }
  if (ip.length > 45 || isIP(ip) === 0) {
    return { ok: false, reason: 'invalid-ip' };
  }
  if (!TIMESTAMP_PATTERN.test(timestamp)) {
    return { ok: false, reason: 'invalid-timestamp' };
  }
  const skew = Math.abs(input.now / 1000 - Number(timestamp));
  if (skew > PROXY_SIGNATURE_MAX_SKEW_SECONDS) {
    return { ok: false, reason: 'expired' };
  }
  if (!SIGNATURE_PATTERN.test(signature)) {
    return { ok: false, reason: 'invalid-signature' };
  }
  const received = Buffer.from(signature.toLowerCase(), 'hex');
  // Se prueban todos los secretos (sin salir antes) en tiempo constante
  let valid = false;
  for (const secret of input.secrets) {
    const expected = Buffer.from(
      signProxyRequest(
        secret,
        input.method,
        input.pathWithQuery,
        ip,
        timestamp,
      ),
      'hex',
    );
    if (timingSafeEqual(expected, received)) {
      valid = true;
    }
  }
  return valid ? { ok: true, ip } : { ok: false, reason: 'invalid-signature' };
}

/**
 * Middleware de Express (se registra en `configureApp`, antes que el de
 * correlación, para que el contexto, la bitácora, las sesiones y los límites
 * vean ya la IP resuelta). Con firma válida sustituye `request.ip` y
 * `request.ips`; en cualquier otro caso no toca nada.
 */
export function createProxyClientIpMiddleware(
  secrets: readonly string[],
  clock: () => number = Date.now,
): (req: Request, res: Response, next: NextFunction) => void {
  const logger = new Logger('ProxyClientIp');
  return (req, _res, next) => {
    const result = resolveProxyClientIp({
      method: req.method,
      pathWithQuery: req.originalUrl,
      headers: req.headers,
      secrets,
      now: clock(),
    });
    if (result.ok) {
      Object.defineProperty(req, 'ip', {
        value: result.ip,
        configurable: true,
        enumerable: true,
      });
      Object.defineProperty(req, 'ips', {
        value: [result.ip],
        configurable: true,
        enumerable: true,
      });
    } else if (result.reason !== 'disabled' && result.reason !== 'absent') {
      // Nunca se registran los valores: solo el motivo
      logger.warn(
        `Cabeceras del proxy ignoradas (${result.reason}): se usa la IP de la conexión`,
      );
    }
    next();
  };
}
