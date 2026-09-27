import type { Prisma } from '@prisma/client';
import type { QueueName } from '@shared/queue/queue.constants';

/** Evento que un módulo escribe en el outbox dentro de su transacción. */
export interface OutboxEventInput<
  TPayload extends Prisma.InputJsonObject = Prisma.InputJsonObject,
> {
  /** Tipo de evento en `dominio.hecho_en_pasado`, p. ej. `winery.created`. */
  type: string;
  /** Agregado al que pertenece (p. ej. `winery`) y su identificador. */
  aggregateType: string;
  aggregateId: string;
  /** Datos mínimos para procesarlo: identificadores, nunca secretos ni PII innecesaria. */
  payload: TPayload;
  /** Cola en la que se publicará. Por defecto `default`. */
  queue?: QueueName;
  /** Por defecto, el de la petición HTTP en curso (X-Correlation-ID). */
  correlationId?: string;
}

/** Datos del trabajo de BullMQ publicado por el relay a partir de un evento. */
export interface OutboxJobData<TPayload = Record<string, unknown>> {
  outboxEventId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: TPayload;
  correlationId: string | null;
  /** Fecha de escritura del evento (ISO 8601, UTC). */
  occurredAt: string;
}
