import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

/**
 * Cabeceras que el frontend puede enviar (contrato O0 §3).
 * `Accept-Language` se conserva porque el ERP ya la envía.
 */
export const CORS_ALLOWED_HEADERS = [
  'Authorization',
  'Content-Type',
  'X-Correlation-ID',
  'Idempotency-Key',
  'Accept-Language',
  // App de origen para la bitácora (contrato O1 §7)
  'X-Client-App',
] as const;

/** Cabeceras de respuesta legibles desde el navegador (contrato O0 §3). */
export const CORS_EXPOSED_HEADERS = [
  'X-Correlation-ID',
  'Retry-After',
  // Nombre del archivo de las descargas (exportación CSV de la bitácora)
  'Content-Disposition',
] as const;

export const CORS_METHODS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
] as const;

/** Orígenes locales por defecto fuera de producción: ERP (3002) y plantilla (3009). */
export const DEFAULT_DEV_ORIGINS = [
  'http://localhost:3002',
  'http://localhost:3009',
] as const;

/**
 * Convierte `CORS_ALLOWED_ORIGINS` (lista separada por comas) en una lista de
 * orígenes exactos. Nunca devuelve un comodín ni refleja el origen recibido:
 * el paquete `cors` solo responde con `Access-Control-Allow-Origin` cuando el
 * origen de la petición coincide con uno de la lista.
 *
 * - `*` se rechaza siempre: con `credentials: true` equivaldría a reflejar
 *   cualquier origen.
 * - Cada entrada debe ser un origen (`esquema://host[:puerto]`), sin ruta.
 * - En producción la lista no puede quedar vacía.
 */
export function parseCorsAllowedOrigins(
  raw: string | undefined,
  nodeEnv: string | undefined,
): string[] {
  const isProduction = nodeEnv === 'production';
  const entries = (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (entries.length === 0) {
    if (isProduction) {
      throw new Error(
        'CORS_ALLOWED_ORIGINS es obligatorio en producción (lista de orígenes separada por comas)',
      );
    }
    return [...DEFAULT_DEV_ORIGINS];
  }

  const origins = entries.map((entry) => {
    if (entry.includes('*')) {
      throw new Error(
        `CORS_ALLOWED_ORIGINS no admite comodines ("${entry}"): indica cada origen exacto`,
      );
    }
    return normalizeOrigin(entry);
  });

  return [...new Set(origins)];
}

function normalizeOrigin(entry: string): string {
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    throw new Error(
      `CORS_ALLOWED_ORIGINS contiene un origen inválido: "${entry}"`,
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`CORS_ALLOWED_ORIGINS solo admite http(s): "${entry}"`);
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new Error(
      `CORS_ALLOWED_ORIGINS espera orígenes sin ruta ni parámetros: "${entry}"`,
    );
  }
  return url.origin;
}

export function buildCorsOptions(allowedOrigins: string[]): CorsOptions {
  return {
    origin: allowedOrigins,
    credentials: true,
    methods: [...CORS_METHODS],
    allowedHeaders: [...CORS_ALLOWED_HEADERS],
    exposedHeaders: [...CORS_EXPOSED_HEADERS],
    maxAge: 600,
  };
}
