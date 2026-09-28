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

  // ── Trazabilidad confiable (contrato O2 §13) ──────────────
  // Estado del recurso → 409; regla de negocio incumplida → 422. El detalle
  // de cada violación (regla, exigido, registrado, meta) va en `details`.
  /** 404 · Lote inexistente o de otra bodega. */
  TRC_LOT_NOT_FOUND: 'TRC_LOT_NOT_FOUND',
  /** 409 · Acción no permitida en la etapa del lote (`meta.stage`, `meta.allowed`). */
  TRC_INVALID_STAGE: 'TRC_INVALID_STAGE',
  /** 409 · Escritura en un lote `REJECTED`, `DISCARDED` o `CERTIFIED`. */
  TRC_LOT_TERMINAL: 'TRC_LOT_TERMINAL',
  /** 422 · Tipo de producto distinto de `WINE`/`SINGANI` (S-1). */
  TRC_PRODUCT_NOT_SUPPORTED: 'TRC_PRODUCT_NOT_SUPPORTED',
  /** 422 · Pesaje de otra añada que la del lote. */
  TRC_HARVEST_YEAR_MISMATCH: 'TRC_HARVEST_YEAR_MISMATCH',
  /** 422 · Parcela no apta D.O. para un lote singani (un detalle por regla). */
  TRC_DO_TERROIR_NOT_ELIGIBLE: 'TRC_DO_TERROIR_NOT_ELIGIBLE',
  /** 422 · Lote no apto D.O. al bifurcar o destilar (por pesaje y regla). */
  TRC_DO_NOT_ELIGIBLE: 'TRC_DO_NOT_ELIGIBLE',
  /** 409 · `PATCH` de un campo normativo en una parcela usada. */
  TRC_TERROIR_IN_USE: 'TRC_TERROIR_IN_USE',
  /** 422 · Dictamen fitosanitario en el alta del pesaje (EA-04). */
  TRC_PHYTO_IN_CREATE: 'TRC_PHYTO_IN_CREATE',
  /** 422 · Uva sin dictamen aprobado hacia un tanque (un detalle por pesaje). */
  TRC_PHYTO_NOT_APPROVED: 'TRC_PHYTO_NOT_APPROVED',
  /** 409 · Dictamen sobre uno final o sobre uva ya en un tanque. */
  TRC_PHYTO_DECISION_FINAL: 'TRC_PHYTO_DECISION_FINAL',
  /** 422 · Entradas de lotes distintos en un tanque (S-4). */
  TRC_MIXED_LOTS: 'TRC_MIXED_LOTS',
  /** 409 · Tanque físico ocupado (S-7). */
  TRC_TANK_CODE_IN_USE: 'TRC_TANK_CODE_IN_USE',
  /** 422 · Llenado mayor que la capacidad del tanque. */
  TRC_TANK_CAPACITY_EXCEEDED: 'TRC_TANK_CAPACITY_EXCEEDED',
  /** 409 · Transición de tanque no válida (`meta.from`, `meta.to`). */
  TRC_TANK_INVALID_TRANSITION: 'TRC_TANK_INVALID_TRANSITION',
  /** 409 · Lectura o tratamiento en un tanque cerrado. */
  TRC_TANK_NOT_ACTIVE: 'TRC_TANK_NOT_ACTIVE',
  /** 409 · Crianza o destilación desde un tanque sin completar. */
  TRC_TANK_NOT_COMPLETED: 'TRC_TANK_NOT_COMPLETED',
  /** 422 · Destino incoherente con el tipo del lote. */
  TRC_DESTINATION_MISMATCH: 'TRC_DESTINATION_MISMATCH',
  /** 422 · Kilos o litros por encima de lo disponible. */
  TRC_VOLUME_EXCEEDS_AVAILABLE: 'TRC_VOLUME_EXCEEDS_AVAILABLE',
  /** 422 · Volumen imprescindible sin registrar (también como incidencia). */
  TRC_VOLUME_MISSING: 'TRC_VOLUME_MISSING',
  /** 422 · Meses de crianza bajo el mínimo de la instantánea. */
  TRC_AGING_BELOW_MINIMUM: 'TRC_AGING_BELOW_MINIMUM',
  /** 422 · Cortes de destilación mayores que la entrada. */
  TRC_MASS_BALANCE_EXCEEDED: 'TRC_MASS_BALANCE_EXCEEDED',
  /** 409 · Cerrar una destilación dos veces. */
  TRC_DISTILLATION_ALREADY_CLOSED: 'TRC_DISTILLATION_ALREADY_CLOSED',
  /** 422 · Embotellar antes del candado (reloj de la base, EA-01). */
  TRC_LOCK_NOT_RELEASED: 'TRC_LOCK_NOT_RELEASED',
  /** 422 · `productType` enviado distinto del derivado del origen (ruta legada, EA-01). */
  TRC_PRODUCT_TYPE_MISMATCH: 'TRC_PRODUCT_TYPE_MISMATCH',
  /** 422 · Fuente de otro lote, de otro tipo o no lista. */
  TRC_BOTTLING_SOURCE_INVALID: 'TRC_BOTTLING_SOURCE_INVALID',
  /** 422 · Fuentes abiertas del lote sin incluir ni descartar. */
  TRC_BOTTLING_SOURCES_PENDING: 'TRC_BOTTLING_SOURCES_PENDING',
  /** 409 · Segundo embotellado del lote (S-10, EA-02). */
  TRC_LOT_ALREADY_BOTTLED: 'TRC_LOT_ALREADY_BOTTLED',
  /** 422 · Botellas × volumen > disponible (EA-02). */
  TRC_BOTTLING_EXCEEDS_VOLUME: 'TRC_BOTTLING_EXCEEDS_VOLUME',
  /** 422 · Merma por encima de la tolerada por la instantánea. */
  TRC_BOTTLING_LOSS_ABOVE_TOLERANCE: 'TRC_BOTTLING_LOSS_ABOVE_TOLERANCE',
  /** 422 · Alcohol puro embotellado > alcohol puro del corazón (S-11). */
  TRC_ALCOHOL_BALANCE_EXCEEDED: 'TRC_ALCOHOL_BALANCE_EXCEEDED',
  /** 422 · Agua en un vino (S-12). */
  TRC_DILUTION_NOT_ALLOWED: 'TRC_DILUTION_NOT_ALLOWED',
  /** 422 · Embotellar o cerrar con incidencias de cumplimiento abiertas. */
  TRC_COMPLIANCE_ISSUES_OPEN: 'TRC_COMPLIANCE_ISSUES_OPEN',
  /** 409 · Laboratorio o códigos antes del embotellado. */
  TRC_LOT_NOT_BOTTLED: 'TRC_LOT_NOT_BOTTLED',
  /** 404 · Código de botella de otra bodega o inexistente. */
  TRC_BOTTLE_CODE_NOT_FOUND: 'TRC_BOTTLE_CODE_NOT_FOUND',
  /** 409 · Anular dos veces un código de botella. */
  TRC_BOTTLE_CODE_ALREADY_VOIDED: 'TRC_BOTTLE_CODE_ALREADY_VOIDED',
  /** 409 · Descarga de una exportación pendiente. */
  TRC_EXPORT_NOT_READY: 'TRC_EXPORT_NOT_READY',
  /** 422 · Campo fuera de la lista de corregibles. */
  TRC_CORRECTION_FIELD_NOT_CORRECTABLE: 'TRC_CORRECTION_FIELD_NOT_CORRECTABLE',
  /** 422 · La corrección incumple una regla (detalles con su `code`). */
  TRC_CORRECTION_BREAKS_RULES: 'TRC_CORRECTION_BREAKS_RULES',
  /** 422 · Cierre del expediente sin requisitos (un detalle por requisito). */
  TRC_DOSSIER_NOT_READY: 'TRC_DOSSIER_NOT_READY',
  /** 409 · Escritura tras el cierre del expediente. */
  TRC_DOSSIER_CLOSED: 'TRC_DOSSIER_CLOSED',
  /** 422 · Fecha futura (5 min de tolerancia en los instantes). */
  TRC_DATE_IN_FUTURE: 'TRC_DATE_IN_FUTURE',
  /** 422 · Fecha anterior a la etapa previa. */
  TRC_DATE_BEFORE_PREVIOUS_STAGE: 'TRC_DATE_BEFORE_PREVIOUS_STAGE',
  /** 422 · `key` de archivo inexistente o de otra organización. */
  TRC_FILE_NOT_FOUND: 'TRC_FILE_NOT_FOUND',
  /** 422 · Reporte de producción con más de 10 000 filas. */
  TRC_REPORT_TOO_LARGE: 'TRC_REPORT_TOO_LARGE',
  /** 403 · Escritura de la plataforma en la trazabilidad (S-25: solo lee). */
  TRC_PLATFORM_READ_ONLY: 'TRC_PLATFORM_READ_ONLY',

  // ── Pasaporte público (contrato O2 §12) ───────────────────
  /** 404 · Pasaporte inexistente. */
  PUB_CODE_NOT_FOUND: 'PUB_CODE_NOT_FOUND',
  /** 422 · Código imposible o con control inválido. */
  PUB_CODE_MALFORMED: 'PUB_CODE_MALFORMED',
  /** 429 · Demasiados códigos inexistentes desde una IP (con `Retry-After`). */
  PUB_TOO_MANY_LOOKUPS: 'PUB_TOO_MANY_LOOKUPS',

  // ── Contrato publicado sin lógica todavía ─────────────────
  /** 501 · Ruta del contrato publicada en el OpenAPI cuya lógica llega en un paso posterior. */
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
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
    501: ErrorCode.NOT_IMPLEMENTED,
    502: ErrorCode.BAD_GATEWAY,
    503: ErrorCode.SERVICE_UNAVAILABLE,
  };
  return map[status] ?? ErrorCode.UNKNOWN_ERROR;
}
