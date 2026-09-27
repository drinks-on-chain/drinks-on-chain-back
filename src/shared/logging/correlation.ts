import { correlationLocalStorage } from '@shared/middleware/correlation-id.middleware';

/**
 * Ejecuta `fn` con `correlationId` en el contexto asíncrono, igual que hace el
 * middleware HTTP. Lo usa el worker para que los logs y los eventos del outbox
 * escritos durante un trabajo conserven el identificador de origen.
 */
export function runWithCorrelationId<T>(correlationId: string, fn: () => T): T {
  const store = new Map<string, string>();
  store.set('correlationId', correlationId);
  return correlationLocalStorage.run(store, fn);
}
