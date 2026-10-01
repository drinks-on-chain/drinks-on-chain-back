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

  // ── Cuenta y segundo factor (contrato O1 §1) ──────────────
  /** 422 · Contraseña nueva corta o común (un detalle por problema). */
  AUTH_WEAK_PASSWORD: 'AUTH_WEAK_PASSWORD',
  /** 422 · La contraseña actual no es correcta (`POST /users/me/password`). */
  AUTH_INVALID_CURRENT_PASSWORD: 'AUTH_INVALID_CURRENT_PASSWORD',
  /** 422 · Enlace de recuperación desconocido, usado o caducado. */
  AUTH_RESET_TOKEN_INVALID: 'AUTH_RESET_TOKEN_INVALID',
  /** 422 · Enlace de verificación del correo desconocido, usado o caducado. */
  AUTH_EMAIL_TOKEN_INVALID: 'AUTH_EMAIL_TOKEN_INVALID',
  /** 403 · Organización de plataforma sin haber pasado el TOTP en la sesión. */
  AUTH_MFA_REQUIRED: 'AUTH_MFA_REQUIRED',
  /** 401 · Reto de segundo factor (`mfaToken`) desconocido, usado o caducado. */
  AUTH_MFA_TOKEN_INVALID: 'AUTH_MFA_TOKEN_INVALID',
  /** 401 · Código TOTP o de recuperación incorrecto. */
  AUTH_MFA_INVALID_CODE: 'AUTH_MFA_INVALID_CODE',
  /** 409 · `mfa/verify` sin segundo factor inscrito. */
  AUTH_MFA_NOT_ENROLLED: 'AUTH_MFA_NOT_ENROLLED',
  /** 409 · `mfa/enroll` con el segundo factor ya inscrito. */
  AUTH_MFA_ALREADY_ENROLLED: 'AUTH_MFA_ALREADY_ENROLLED',
  /** 409 · `mfa/enroll/confirm` sin haber pedido antes el secreto. */
  AUTH_MFA_ENROLLMENT_NOT_STARTED: 'AUTH_MFA_ENROLLMENT_NOT_STARTED',
  /** 401 · Aceptar una invitación de una cuenta existente sin su sesión. */
  AUTH_LOGIN_REQUIRED: 'AUTH_LOGIN_REQUIRED',
  /** 422 · El captcha (Turnstile) no es válido. */
  CAPTCHA_INVALID: 'CAPTCHA_INVALID',
  /** 503 · No se pudo comprobar el captcha con el proveedor. */
  CAPTCHA_UNAVAILABLE: 'CAPTCHA_UNAVAILABLE',
  /** 404 · Persona inexistente. */
  USER_NOT_FOUND: 'USER_NOT_FOUND',

  // ── Invitaciones (contrato O1 §2) ─────────────────────────
  /** 404 · Token o id de invitación desconocido (o de otra organización). */
  INVITATION_NOT_FOUND: 'INVITATION_NOT_FOUND',
  /** 422 · La invitación caducó: hay que reenviarla. */
  INVITATION_EXPIRED: 'INVITATION_EXPIRED',
  /** 409 · La invitación ya no está pendiente (aceptada o anulada). */
  INVITATION_NOT_PENDING: 'INVITATION_NOT_PENDING',
  /** 409 · Ya hay una invitación pendiente para ese correo en la organización. */
  INVITATION_ALREADY_PENDING: 'INVITATION_ALREADY_PENDING',
  /** 403 · La sesión es de otra persona que la invitada. */
  INVITATION_EMAIL_MISMATCH: 'INVITATION_EMAIL_MISMATCH',

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
  /** 409 · La persona ya es miembro (activo o bloqueado) de la organización. */
  ORG_ALREADY_MEMBER: 'ORG_ALREADY_MEMBER',
  /** 403 · El rol de dueño solo se asigna en el alta o la transferencia. */
  ORG_OWNER_ROLE_RESERVED: 'ORG_OWNER_ROLE_RESERVED',
  /** 422 · Límite de colaboradores (activos + invitaciones pendientes). */
  ORG_MEMBER_LIMIT_REACHED: 'ORG_MEMBER_LIMIT_REACHED',
  /** 403 · Nadie cambia, bloquea ni degrada su propia membresía o cuenta. */
  ORG_CANNOT_MODIFY_SELF: 'ORG_CANNOT_MODIFY_SELF',

  // ── Plataforma (contrato O1 §5) ───────────────────────────
  /** 403 · El superusuario no se bloquea ni se degrada. */
  PLATFORM_SUPERADMIN_PROTECTED: 'PLATFORM_SUPERADMIN_PROTECTED',

  // ── Bodegas ───────────────────────────────────────────────
  /** 409 · Ya hay una bodega o una solicitud abierta con ese NIT (contrato O1 §3). */
  ORG_TAX_ID_TAKEN: 'ORG_TAX_ID_TAKEN',
  /** 409 · Cambio de estado de la bodega no permitido (suspender, reactivar, revocar, transferir). */
  ORG_INVALID_TRANSITION: 'ORG_INVALID_TRANSITION',

  // ── Solicitudes de alta (contrato O1 §3) ──────────────────
  /** 409 · La solicitud no puede pasar a ese estado (tomar, reunión, aprobar, rechazar). */
  APPLICATION_INVALID_TRANSITION: 'APPLICATION_INVALID_TRANSITION',
  /** 422 · Enlace de verificación de la solicitud desconocido, usado o caducado. */
  APPLICATION_TOKEN_INVALID: 'APPLICATION_TOKEN_INVALID',

  // ── Configuración (contrato O1 §6) ────────────────────────
  /** 404 · El parámetro no existe en el catálogo. */
  SETTING_NOT_FOUND: 'SETTING_NOT_FOUND',
  /** 422 · Ajuste por bodega en un parámetro solo general (o al revés). */
  SETTING_LEVEL_NOT_ALLOWED: 'SETTING_LEVEL_NOT_ALLOWED',
  /** 422 · Valor más laxo que el mínimo legal sin excepción autorizada (A-31). */
  SETTING_BELOW_LEGAL_MINIMUM: 'SETTING_BELOW_LEGAL_MINIMUM',

  // ── Bitácora (contrato O1 §7) ─────────────────────────────
  /** 422 · La exportación CSV supera 50 000 filas: acotar fechas o filtros. */
  AUDIT_EXPORT_TOO_LARGE: 'AUDIT_EXPORT_TOO_LARGE',

  // ── Archivos (SE-04) ──────────────────────────────────────
  /** 422 · El contenido del archivo no corresponde a un tipo permitido. */
  FILE_TYPE_NOT_ALLOWED: 'FILE_TYPE_NOT_ALLOWED',
  /** 413 · El archivo supera el tamaño máximo de su tipo. */
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  /** 404 · El archivo no existe o no es de tu organización. */
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',

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
