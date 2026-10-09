import { Injectable, Logger } from '@nestjs/common';
import { HandlesJob, JobHandler } from '@shared/queue/job-handler';
import type { OutboxJobData } from '@shared/outbox/outbox.types';
import { QUEUE_CHAIN, QUEUE_DEFAULT } from '@shared/queue/queue.constants';
import {
  COLLECTION_CLOSED,
  COLLECTION_PAUSED,
  COLLECTION_PUBLISHED,
  COLLECTION_RESUMED,
  TOKENIZATION_REQUEST_APPROVED,
  TOKENIZATION_REQUEST_CHANGES_REQUESTED,
  TOKENIZATION_REQUEST_REJECTED,
  TOKENIZATION_REQUEST_SUBMITTED,
  type CollectionEventPayload,
  type TokenizationRequestApprovedPayload,
  type TokenizationRequestEventPayload,
} from '../tokenization.events';

/**
 * Procesadores de los eventos de la tokenización (contrato O3 §11). En el
 * paso 3.3 solo dejan constancia, para que ningún evento quede sin
 * procesador: los correos ya salen por la cola `email` dentro de la misma
 * transacción. Quien consuma de verdad un evento (la emisión en el paso 3.4,
 * el catálogo en la Ola 4) sustituye aquí su procesador: solo puede haber uno
 * por cola y nombre.
 */
abstract class LogOnlyHandler<TPayload> implements JobHandler<
  OutboxJobData<TPayload>
> {
  private readonly logger = new Logger(this.constructor.name);

  protected abstract describe(payload: TPayload): string;

  handle(data: OutboxJobData<TPayload>): Promise<void> {
    this.logger.log({
      message: this.describe(data.payload),
      eventType: data.eventType,
      aggregateId: data.aggregateId,
    });
    return Promise.resolve();
  }
}

/**
 * `tokenization.request_approved`: hay una emisión `PENDING`. **Provisional**:
 * el paso 3.4 registra aquí (o en el puerto, dentro de la transacción de la
 * aprobación) las intenciones `MINT_BATCH` de `payload.chunks`.
 */
@Injectable()
@HandlesJob(QUEUE_CHAIN, TOKENIZATION_REQUEST_APPROVED)
export class TokenizationRequestApprovedHandler extends LogOnlyHandler<TokenizationRequestApprovedPayload> {
  protected describe(payload: TokenizationRequestApprovedPayload): string {
    return `Solicitud ${payload.requestId} aprobada: emisión ${payload.mintId} de ${payload.quantity} NFT en ${payload.chunks.length} trozo(s), pendiente de enviarse (paso 3.4)`;
  }
}

@Injectable()
@HandlesJob(QUEUE_DEFAULT, TOKENIZATION_REQUEST_SUBMITTED)
export class TokenizationRequestSubmittedHandler extends LogOnlyHandler<TokenizationRequestEventPayload> {
  protected describe(payload: TokenizationRequestEventPayload): string {
    return `Solicitud de tokenización ${payload.requestId} ${payload.resubmitted ? 'reenviada' : 'enviada'} (${payload.quantity} botellas)`;
  }
}

@Injectable()
@HandlesJob(QUEUE_DEFAULT, TOKENIZATION_REQUEST_CHANGES_REQUESTED)
export class TokenizationRequestChangesRequestedHandler extends LogOnlyHandler<TokenizationRequestEventPayload> {
  protected describe(payload: TokenizationRequestEventPayload): string {
    return `Cambios pedidos en la solicitud de tokenización ${payload.requestId}`;
  }
}

@Injectable()
@HandlesJob(QUEUE_DEFAULT, TOKENIZATION_REQUEST_REJECTED)
export class TokenizationRequestRejectedHandler extends LogOnlyHandler<TokenizationRequestEventPayload> {
  protected describe(payload: TokenizationRequestEventPayload): string {
    return `Solicitud de tokenización ${payload.requestId} rechazada`;
  }
}

const collectionMessage = (payload: CollectionEventPayload): string =>
  `Colección ${payload.slug} (${payload.collectionId}) → ${payload.status}${payload.system ? ' por el sistema' : ''}`;

@Injectable()
@HandlesJob(QUEUE_DEFAULT, COLLECTION_PUBLISHED)
export class CollectionPublishedHandler extends LogOnlyHandler<CollectionEventPayload> {
  protected describe(payload: CollectionEventPayload): string {
    return collectionMessage(payload);
  }
}

@Injectable()
@HandlesJob(QUEUE_DEFAULT, COLLECTION_PAUSED)
export class CollectionPausedHandler extends LogOnlyHandler<CollectionEventPayload> {
  protected describe(payload: CollectionEventPayload): string {
    return collectionMessage(payload);
  }
}

@Injectable()
@HandlesJob(QUEUE_DEFAULT, COLLECTION_RESUMED)
export class CollectionResumedHandler extends LogOnlyHandler<CollectionEventPayload> {
  protected describe(payload: CollectionEventPayload): string {
    return collectionMessage(payload);
  }
}

@Injectable()
@HandlesJob(QUEUE_DEFAULT, COLLECTION_CLOSED)
export class CollectionClosedHandler extends LogOnlyHandler<CollectionEventPayload> {
  protected describe(payload: CollectionEventPayload): string {
    return collectionMessage(payload);
  }
}

export const TOKENIZATION_EVENT_HANDLERS = [
  TokenizationRequestApprovedHandler,
  TokenizationRequestSubmittedHandler,
  TokenizationRequestChangesRequestedHandler,
  TokenizationRequestRejectedHandler,
  CollectionPublishedHandler,
  CollectionPausedHandler,
  CollectionResumedHandler,
  CollectionClosedHandler,
];
