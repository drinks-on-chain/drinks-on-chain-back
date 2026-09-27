import { runWithRequestContext } from '@shared/context/request-context';

/**
 * Ejecuta `fn` con `correlationId` en el contexto asíncrono, igual que hace el
 * middleware HTTP. Lo usa el worker para que los logs, los eventos del outbox
 * y las entradas de la bitácora escritos durante un trabajo conserven el
 * identificador de origen (app `WORKER`, sin persona).
 */
export function runWithCorrelationId<T>(correlationId: string, fn: () => T): T {
  return runWithRequestContext({ correlationId, clientApp: 'WORKER' }, fn);
}
