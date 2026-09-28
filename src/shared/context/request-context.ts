import { AsyncLocalStorage } from 'async_hooks';

/**
 * Contexto de la petición en curso (o del trabajo de la cola) en
 * `AsyncLocalStorage`: quién actúa, desde qué organización y aplicación, y el
 * identificador de correlación. Lo leen la bitácora (actor y origen de cada
 * entrada), los logs JSON (`correlationId`, `sid`, `org`) y el outbox, sin
 * tener que pasar la petición de mano en mano.
 *
 * - El middleware de correlación lo abre con `correlationId`, `ip` y
 *   `clientApp` (cabecera `X-Client-App`).
 * - La identidad (`userId`, `organizationId`, `organizationType`, `role`,
 *   `sessionId`, `audience`) la completa quien valida el token: hoy
 *   `RequestContextInterceptor` a partir de `request.user`.
 * - El worker lo abre por trabajo con `runWithCorrelationId` (app `WORKER`).
 */

/** Aplicación de origen (cabecera `X-Client-App`, contrato O1 §7). */
export const CLIENT_APPS = [
  'ERP',
  'MARKETPLACE',
  'BACKOFFICE',
  'POS',
  'PUBLIC',
  'API',
  'WORKER',
] as const;
export type ClientApp = (typeof CLIENT_APPS)[number];

/** Cabecera con la que cada app se identifica. */
export const CLIENT_APP_HEADER = 'x-client-app';

export type OrganizationType = 'PLATFORM' | 'WINERY' | 'PICKUP_POINT';
export type Audience = 'STAFF' | 'CONSUMER';

export interface RequestContext {
  correlationId: string | null;
  ip: string | null;
  /** App de origen normalizada (`parseClientApp`); `null` = sin cabecera. */
  clientApp: ClientApp | null;
  /** Persona autenticada (`sub`); `null` en rutas públicas o en el sistema. */
  userId: string | null;
  /** Organización activa desde la que actúa. */
  organizationId: string | null;
  organizationType: OrganizationType | null;
  /** Rol en la organización activa (o el rol global mientras exista). */
  role: string | null;
  /** Sesión (`sid`), cuando el token la trae (contrato O0 §5). */
  sessionId: string | null;
  audience: Audience | null;
  /** Nombre de la persona, para la bitácora (se guarda desnormalizado). */
  userFullName?: string | null;
  /** Dispositivo (POS), cuando exista. */
  deviceId?: string | null;
}

export const requestContextStorage = new AsyncLocalStorage<RequestContext>();

export function emptyRequestContext(
  initial: Partial<RequestContext> = {},
): RequestContext {
  return {
    correlationId: null,
    ip: null,
    clientApp: null,
    userId: null,
    organizationId: null,
    organizationType: null,
    role: null,
    sessionId: null,
    audience: null,
    userFullName: null,
    deviceId: null,
    ...initial,
  };
}

/** Ejecuta `fn` con un contexto nuevo. */
export function runWithRequestContext<T>(
  initial: Partial<RequestContext>,
  fn: () => T,
): T {
  return requestContextStorage.run(emptyRequestContext(initial), fn);
}

/** Contexto de la petición en curso (`undefined` fuera de una petición). */
export function getRequestContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}

/** Completa el contexto en curso (sin efecto fuera de una petición). */
export function setRequestContext(patch: Partial<RequestContext>): void {
  const store = requestContextStorage.getStore();
  if (store) {
    Object.assign(store, patch);
  }
}

/** Normaliza la cabecera `X-Client-App`; desconocida → `API`, ausente → `null`. */
export function parseClientApp(raw: unknown): ClientApp | null {
  const value = (Array.isArray(raw) ? raw[0] : raw) as unknown;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const upper = value.trim().toUpperCase();
  // WORKER no puede llegar desde fuera
  if (upper === 'WORKER') return 'API';
  return (CLIENT_APPS as readonly string[]).includes(upper)
    ? (upper as ClientApp)
    : 'API';
}

const ORGANIZATION_TYPES: readonly string[] = [
  'PLATFORM',
  'WINERY',
  'PICKUP_POINT',
];

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Identidad a partir de `request.user` (lo que deja la validación del token).
 *
 * Acepta los claims del contrato O0 §5 (`org`, `orgType`, `role`, `sid`,
 * `aud`, o sus nombres largos); los de compatibilidad de 0.1 (`wineryId`,
 * `memberRole`, `userRole`) se retiraron en H1. Solo devuelve los campos que
 * puede deducir: no pisa lo que otro ya haya puesto en el contexto.
 */
export function identityFromUser(
  user: unknown,
): Partial<RequestContext> | null {
  if (typeof user !== 'object' || user === null) return null;
  const u = user as Record<string, unknown>;
  const userId = str(u.id) ?? str(u.userId) ?? str(u.sub);
  if (!userId) return null;

  const organizationId = str(u.organizationId) ?? str(u.org) ?? null;
  const rawOrgType = str(u.organizationType) ?? str(u.orgType);
  const organizationType: OrganizationType | null =
    rawOrgType && ORGANIZATION_TYPES.includes(rawOrgType)
      ? (rawOrgType as OrganizationType)
      : null;

  const rawAudience = str(u.audience) ?? str(u.aud);
  const audience: Audience =
    rawAudience === 'STAFF' || rawAudience === 'CONSUMER'
      ? rawAudience
      : organizationId
        ? 'STAFF'
        : 'CONSUMER';

  return {
    userId,
    userFullName: str(u.fullName),
    organizationId,
    organizationType,
    role: str(u.role),
    sessionId: str(u.sessionId) ?? str(u.sid),
    audience,
  };
}
