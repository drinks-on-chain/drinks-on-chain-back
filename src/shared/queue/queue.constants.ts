/**
 * Colas de BullMQ del backend (OPS-05, docs-back/03 §4).
 *
 * - `chain`: todo lo que habla con la red (emisión, transferencia, quema,
 *   anclaje) y, mientras tanto, los efectos simulados que la sustituyen.
 * - `email`: correo transaccional y campañas (O0-BE-5).
 * - `scheduled`: tareas programadas (repeatable jobs / job schedulers).
 * - `default`: el resto.
 */
export const QUEUE_NAMES = ['chain', 'email', 'scheduled', 'default'] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

export const QUEUE_CHAIN: QueueName = 'chain';
export const QUEUE_EMAIL: QueueName = 'email';
export const QUEUE_SCHEDULED: QueueName = 'scheduled';
export const QUEUE_DEFAULT: QueueName = 'default';

export function isQueueName(value: string): value is QueueName {
  return (QUEUE_NAMES as readonly string[]).includes(value);
}
