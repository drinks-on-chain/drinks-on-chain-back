import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@shared/prisma/prisma.service';
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
import {
  TOKENIZATION_CHAIN_PORT,
  type TokenizationChainPort,
} from '../ports/tokenization-chain.port';

/**
 * Procesadores de los eventos de la tokenización (contrato O3 §11). Salvo el
 * de la aprobación (que registra la emisión), solo dejan constancia, para que
 * ningún evento quede sin procesador: los correos ya salen por la cola
 * `email` dentro de la misma transacción. Quien consuma de verdad un evento
 * (el catálogo en la Ola 4) sustituye aquí su procesador: solo puede haber
 * uno por cola y nombre.
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
 * `tokenization.request_approved` (contrato O3 §6.1): registra las
 * intenciones `MINT_BATCH` de la emisión, una por trozo y en orden. Es
 * idempotente por `intentKey` (`mint:{mintId}:{trozo}`): la aprobación ya las
 * deja registradas en su propia transacción, así que aquí solo se crean las
 * que falten (emisiones aprobadas antes del paso 3.4) y reprocesar el evento
 * no crea otra transacción. El firmante del worker las valida y las envía.
 */
@Injectable()
@HandlesJob(QUEUE_CHAIN, TOKENIZATION_REQUEST_APPROVED)
export class TokenizationRequestApprovedHandler implements JobHandler<
  OutboxJobData<TokenizationRequestApprovedPayload>
> {
  private readonly logger = new Logger(TokenizationRequestApprovedHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(TOKENIZATION_CHAIN_PORT)
    private readonly chainPort: TokenizationChainPort,
  ) {}

  async handle(
    data: OutboxJobData<TokenizationRequestApprovedPayload>,
  ): Promise<void> {
    const payload = data.payload;
    const registered = await this.prisma.$transaction(async (tx) => {
      // La emisión manda sobre el evento: si ya no existe o ya se confirmó,
      // no hay nada que registrar
      const mint = await tx.mint.findUnique({
        where: { id: payload.mintId },
        include: { collection: { select: { wineryId: true, lotId: true } } },
      });
      if (
        !mint ||
        mint.requestId !== payload.requestId ||
        mint.collectionId !== payload.collectionId ||
        mint.status === 'CONFIRMED'
      ) {
        return false;
      }
      await this.chainPort.registerMintIntents(tx, {
        mintId: mint.id,
        requestId: mint.requestId,
        collectionId: mint.collectionId,
        wineryId: mint.collection.wineryId,
        lotId: mint.collection.lotId,
        network: payload.network,
        contractId: payload.contractId,
        contractAddress: payload.contractAddress,
        toAddress: payload.toAddress,
        lotArg: mint.lotArg,
        quantity: mint.quantity,
        chunks: payload.chunks,
        requestedBy: {
          userId: payload.approvedByUserId,
          fullName: null,
          source: 'WORKER',
        },
      });
      return true;
    });
    this.logger.log({
      message: registered
        ? `Emisión ${payload.mintId}: ${payload.chunks.length} intención(es) MINT_BATCH registradas`
        : `Emisión ${payload.mintId}: nada que registrar`,
      eventType: data.eventType,
      requestId: payload.requestId,
      mintId: payload.mintId,
      quantity: payload.quantity,
    });
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
