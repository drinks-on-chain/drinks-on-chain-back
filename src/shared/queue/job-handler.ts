import { SetMetadata, applyDecorators } from '@nestjs/common';
import { QUEUE_SCHEDULED, QueueName } from './queue.constants';

export const JOB_HANDLER_METADATA = 'doc:job-handler';
export const SCHEDULED_TASK_METADATA = 'doc:scheduled-task';

/** Contexto que recibe cada procesador junto con los datos del trabajo. */
export interface JobContext {
  jobId: string;
  /** Nombre del trabajo: tipo de evento del outbox o nombre de la tarea. */
  name: string;
  queue: QueueName;
  /** Intento actual, empezando en 1. */
  attempt: number;
  correlationId: string;
}

/**
 * Procesador de un trabajo. Debe ser idempotente: BullMQ reintenta los
 * trabajos que fallan y el outbox garantiza entrega "al menos una vez".
 */
export interface JobHandler<TData = unknown> {
  handle(data: TData, context: JobContext): Promise<void>;
}

export interface JobHandlerMetadata {
  queue: QueueName;
  name: string;
}

/**
 * Marca un proveedor como procesador de los trabajos `name` de la cola
 * `queue`. El worker los descubre al arrancar (un solo procesador por par
 * cola + nombre). El proveedor debe estar en un módulo que importe
 * `src/worker/worker.module.ts` (ver README · "Añadir un procesador").
 */
export function HandlesJob(queue: QueueName, name: string): ClassDecorator {
  return SetMetadata<string, JobHandlerMetadata>(JOB_HANDLER_METADATA, {
    queue,
    name,
  });
}

export type ScheduledTaskMetadata =
  | { name: string; every: number; pattern?: undefined; description?: string }
  | { name: string; pattern: string; every?: undefined; description?: string };

/**
 * Tarea programada (BullMQ job scheduler en la cola `scheduled`): `every` en
 * milisegundos o `pattern` cron (UTC). El worker registra el programador al
 * arrancar y elimina los que ya no existen en el código.
 */
export function ScheduledTask(options: ScheduledTaskMetadata): ClassDecorator {
  return applyDecorators(
    HandlesJob(QUEUE_SCHEDULED, options.name),
    SetMetadata<string, ScheduledTaskMetadata>(
      SCHEDULED_TASK_METADATA,
      options,
    ),
  );
}
