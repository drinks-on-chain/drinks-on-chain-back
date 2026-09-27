import type { CookieOptions, Request, Response } from 'express';

/** Cookie de la renovación (contrato O0 §5). */
export const REFRESH_COOKIE = 'doc_rt';

function isLocalhost(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  try {
    const host = value.includes('://') ? new URL(value).hostname : value;
    const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    return (
      name === 'localhost' ||
      name.endsWith('.localhost') ||
      name === '127.0.0.1' ||
      name === '::1'
    );
  } catch {
    return false;
  }
}

/**
 * `Secure` siempre, salvo en desarrollo local sin HTTPS: `NODE_ENV=development`
 * y la petición llega de un origen (o a un host) `localhost`.
 */
export function useSecureCookie(nodeEnv: string, req: Request): boolean {
  if (nodeEnv !== 'development') {
    return true;
  }
  const origin = req.headers.origin;
  const local = origin ? isLocalhost(origin) : isLocalhost(req.headers.host);
  return !local;
}

function baseOptions(secure: boolean): CookieOptions {
  return { httpOnly: true, secure, sameSite: 'lax', path: '/' };
}

/** `Set-Cookie: doc_rt=…; Max-Age=…; Path=/; HttpOnly; Secure; SameSite=Lax`. */
export function setRefreshCookie(
  res: Response,
  refreshToken: string,
  maxAgeSeconds: number,
  secure: boolean,
): void {
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...baseOptions(secure),
    maxAge: maxAgeSeconds * 1000,
  });
}

/** Borra la cookie (`Max-Age=0`). */
export function clearRefreshCookie(res: Response, secure: boolean): void {
  res.cookie(REFRESH_COOKIE, '', { ...baseOptions(secure), maxAge: 0 });
}

/** Lee una cookie de la cabecera `Cookie` (sin dependencias). */
export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) {
    return null;
  }
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) {
      continue;
    }
    if (part.slice(0, index).trim() === name) {
      const value = part.slice(index + 1).trim();
      try {
        return decodeURIComponent(value) || null;
      } catch {
        return value || null;
      }
    }
  }
  return null;
}

/**
 * Refresco de la petición: la cookie `doc_rt` y, por compatibilidad hasta H1,
 * el cuerpo `{ refreshToken }`.
 */
export function readRefreshToken(
  req: Request,
  bodyToken?: string | null,
): string | null {
  return readCookie(req, REFRESH_COOKIE) ?? (bodyToken?.trim() || null);
}
