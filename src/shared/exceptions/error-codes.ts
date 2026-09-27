/**
 * Catálogo de códigos de error de la API (OPS-02, contrato O0 §1).
 *
 * - Genéricos: el nombre del estado HTTP (`NOT_FOUND`, `CONFLICT`…). Los usa el
 *   filtro global cuando una excepción no trae código propio.
 * - De dominio: `UPPER_SNAKE_CASE` con el prefijo de su dominio (`AUTH_…`,
 *   `ORG_…`, `IDEMPOTENCY_…`, `HARVEST_BATCH_…`…). Las fábricas de
 *   `domain-errors.ts` son la forma de lanzarlos.
 *
 * La tabla completa, con su estado HTTP, está en `docs/rules/03-formato-respuestas.md`.
 */
export const ErrorCode = {
  // ── Genéricos ─────────────────────────────────────────────
  /** 422 · Falló la validación del DTO, la query o una cabecera (ver `details`). */
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  /** 400 · Petición mal formada (JSON inválido, parámetro de ruta no UUID…). */
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  /** 404 · Incluye los recursos de otra organización (nunca 403). */
  NOT_FOUND: 'NOT_FOUND',
  /** 409 · Conflicto de estado genérico. */
  CONFLICT: 'CONFLICT',
  /** 422 · Regla de negocio sin código propio. */
  UNPROCESSABLE_ENTITY: 'UNPROCESSABLE_ENTITY',
  /** 429 · Límite de peticiones; la respuesta lleva `Retry-After`. */
  TOO_MANY_REQUESTS: 'TOO_MANY_REQUESTS',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  BAD_GATEWAY: 'BAD_GATEWAY',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',

  // ── Idempotencia (contrato O0 §3) ─────────────────────────
  /** 422 · `Idempotency-Key` no es un UUID. */
  IDEMPOTENCY_KEY_INVALID: 'IDEMPOTENCY_KEY_INVALID',
  /** 422 · La operación exige `Idempotency-Key` y no llegó. */
  IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',
  /** 409 · Misma clave con otro cuerpo. */
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  /** 409 · Otra petición con la misma clave aún se está procesando. */
  IDEMPOTENCY_IN_PROGRESS: 'IDEMPOTENCY_IN_PROGRESS',
  /** 503 · No se pudo consultar el almacén de idempotencia (Redis). */
  IDEMPOTENCY_STORE_UNAVAILABLE: 'IDEMPOTENCY_STORE_UNAVAILABLE',

  // ── Bodegas ───────────────────────────────────────────────
  /** 409 · La bodega ya no está en PENDING (aprobar o rechazar dos veces). */
  WINERY_NOT_PENDING: 'WINERY_NOT_PENDING',

  // ── Trazabilidad ──────────────────────────────────────────
  /** 409 · La cuba ya pasó a un lote de crianza. */
  FERMENTATION_TANK_ALREADY_TRANSFERRED:
    'FERMENTATION_TANK_ALREADY_TRANSFERRED',
  /** 422 · No hay estrategia de trazabilidad para el tipo de bebida. */
  TRACEABILITY_STRATEGY_NOT_FOUND: 'TRACEABILITY_STRATEGY_NOT_FOUND',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Código genérico para un estado HTTP sin código propio. */
export function errorCodeForStatus(status: number): string {
  const map: Record<number, string> = {
    400: ErrorCode.BAD_REQUEST,
    401: ErrorCode.UNAUTHORIZED,
    403: ErrorCode.FORBIDDEN,
    404: ErrorCode.NOT_FOUND,
    409: ErrorCode.CONFLICT,
    422: ErrorCode.UNPROCESSABLE_ENTITY,
    429: ErrorCode.TOO_MANY_REQUESTS,
    500: ErrorCode.INTERNAL_ERROR,
    502: ErrorCode.BAD_GATEWAY,
    503: ErrorCode.SERVICE_UNAVAILABLE,
  };
  return map[status] ?? ErrorCode.UNKNOWN_ERROR;
}
