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

  // ── Sesión (contrato O0 §5) ───────────────────────────────
  /** 401 · Correo o contraseña incorrectos (o cuenta bloqueada: no se distingue). */
  AUTH_INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS',
  /** 401 · Falta el token de acceso, está mal formado o su firma no vale. */
  AUTH_TOKEN_INVALID: 'AUTH_TOKEN_INVALID',
  /** 401 · El token de acceso caducó (15 min): renovar con /auth/refresh. */
  AUTH_TOKEN_EXPIRED: 'AUTH_TOKEN_EXPIRED',
  /** 401 · Falta el refresco o no es de ninguna sesión. */
  AUTH_REFRESH_INVALID: 'AUTH_REFRESH_INVALID',
  /** 401 · Refresco ya rotado presentado otra vez: se revoca la sesión. */
  AUTH_REFRESH_REUSED: 'AUTH_REFRESH_REUSED',
  /** 401 · Sesión revocada, o persona o membresía activa bloqueada. */
  AUTH_SESSION_REVOKED: 'AUTH_SESSION_REVOKED',
  /** 401 · La sesión caducó (7 días sin uso el personal, 30 los consumidores). */
  AUTH_SESSION_EXPIRED: 'AUTH_SESSION_EXPIRED',
  /** 429 · Bloqueo progresivo por intentos fallidos (IAM-07), con `Retry-After`. */
  AUTH_TOO_MANY_ATTEMPTS: 'AUTH_TOO_MANY_ATTEMPTS',
  /** 403 · Audiencia, tipo de organización activa o rol insuficientes. */
  AUTH_INSUFFICIENT_PERMISSIONS: 'AUTH_INSUFFICIENT_PERMISSIONS',

  // ── Organizaciones y membresías (contrato O0 §4–§6) ───────
  /** 404 · Organización inexistente o sin membresía de la persona. */
  ORG_NOT_FOUND: 'ORG_NOT_FOUND',
  /** 403 · La membresía en esa organización está bloqueada. */
  ORG_MEMBERSHIP_BLOCKED: 'ORG_MEMBERSHIP_BLOCKED',
  /** 403 · La organización está revocada. */
  ORG_REVOKED: 'ORG_REVOKED',
  /** 403 · Ruta del ERP con la bodega activa no ACTIVE (SE-05; con FEATURE_ENFORCE_ACTIVE_ORG). */
  ORG_NOT_ACTIVE: 'ORG_NOT_ACTIVE',
  /** 403 · La plataforma bloqueó esa membresía: el dueño no puede reactivarla. */
  ORG_BLOCKED_BY_PLATFORM: 'ORG_BLOCKED_BY_PLATFORM',
  /** 409 · La persona ya es miembro activo de la organización. */
  ORG_ALREADY_MEMBER: 'ORG_ALREADY_MEMBER',

  // ── Bodegas ───────────────────────────────────────────────
  /** 409 · La bodega ya no está en INVITED (aprobar o rechazar dos veces). */
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
