/**
 * Colas de BullMQ del backend (OPS-05, docs-back/03 §4).
 *
 * - `chain`: todo lo que habla con la red (emisión, transferencia, quema,
 *   anclaje): una transacción en vuelo por cuenta de origen (contrato O3 §2.3).
 * - `chain-poll`: confirmaciones de las transacciones enviadas (O3 §11).
 * - `email`: correo transaccional y campañas (O0-BE-5).
 * - `scheduled`: tareas programadas (repeatable jobs / job schedulers).
 * - `default`: el resto.
 */
export const QUEUE_NAMES = [
  'chain',
  'chain-poll',
  'email',
  'scheduled',
  'default',
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

export const QUEUE_CHAIN: QueueName = 'chain';
export const QUEUE_CHAIN_POLL: QueueName = 'chain-poll';
export const QUEUE_EMAIL: QueueName = 'email';
export const QUEUE_SCHEDULED: QueueName = 'scheduled';
export const QUEUE_DEFAULT: QueueName = 'default';

/**
 * Clave del latido del worker en Redis (`<QUEUE_PREFIX>:worker:heartbeat`):
 * el worker la reescribe con caducidad `WORKER_HEARTBEAT_MAX_AGE_MS` mientras
 * está sano y la API la lee en `/v1/health/ready` (`worker: up | down`).
 */
export function workerHeartbeatKey(queuePrefix: string): string {
  return `${queuePrefix}:worker:heartbeat`;
}

/** Prefijo por defecto de las claves de BullMQ (`QUEUE_PREFIX`). */
export const DEFAULT_QUEUE_PREFIX = 'doc';

export function isQueueName(value: string): value is QueueName {
  return (QUEUE_NAMES as readonly string[]).includes(value);
}
