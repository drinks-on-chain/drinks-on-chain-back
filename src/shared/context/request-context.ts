import { AsyncLocalStorage } from 'async_hooks';

/**
 * Contexto de la petición en curso (AsyncLocalStorage). Lo abre el
 * middleware de correlación con `correlationId`, `ip` y `clientApp`; el guard
 * de acceso lo completa con la sesión (`userId`, `organizationId`,
 * `organizationType`, `role`, `sessionId`, `audience`). Lo leen la bitácora,
 * los logs y el outbox sin tener que pasar la petición de mano en mano.
 */
export interface RequestContext {
  correlationId: string | null;
  ip: string | null;
  /** Cabecera `X-Client-App` (erp, backoffice, marketplace…), si llega. */
  clientApp: string | null;
  userId: string | null;
  organizationId: string | null;
  organizationType: 'PLATFORM' | 'WINERY' | 'PICKUP_POINT' | null;
  role: string | null;
  sessionId: string | null;
  audience: 'STAFF' | 'CONSUMER' | null;
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
