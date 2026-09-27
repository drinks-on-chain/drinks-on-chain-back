import { Injectable } from '@nestjs/common';
import { OutboxEvent, Prisma } from '@prisma/client';
import { CorrelationIdMiddleware } from '@shared/middleware/correlation-id.middleware';
import { QUEUE_DEFAULT } from '@shared/queue/queue.constants';
import { OutboxEventInput } from './outbox.types';

/**
 * Outbox transaccional (OPS-04, ADR-005).
 *
 * Todo efecto externo (red, correo, banco) se registra como evento en la
 * misma transacción que la operación de negocio; el worker lo publica después
 * en BullMQ. Así, si la transacción se revierte, el evento no existe, y si se
 * confirma, el evento llegará a la cola aunque Redis esté caído en ese momento.
 */
@Injectable()
export class OutboxService {
  /**
   * Escribe un evento con el cliente de la transacción recibida. Rechaza el
   * cliente raíz de Prisma: un evento fuera de transacción rompería la
   * garantía "todo o nada".
   */
  async add<TPayload extends Prisma.InputJsonObject>(
    tx: Prisma.TransactionClient,
    event: OutboxEventInput<TPayload>,
  ): Promise<OutboxEvent> {
    if (!tx || '$transaction' in tx) {
      throw new Error(
        'OutboxService.add solo acepta el cliente de una transacción: úsalo dentro de prisma.$transaction(async (tx) => …)',
      );
    }
    if (!event.type || !event.aggregateType || !event.aggregateId) {
      throw new Error(
        'Un evento del outbox necesita type, aggregateType y aggregateId',
      );
    }

    return tx.outboxEvent.create({
      data: {
        eventType: event.type,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        queue: event.queue ?? QUEUE_DEFAULT,
        payload: event.payload,
        correlationId:
          event.correlationId ??
          CorrelationIdMiddleware.getCorrelationId() ??
          null,
      },
    });
  }
}
