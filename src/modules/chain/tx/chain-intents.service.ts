import { Inject, Injectable } from '@nestjs/common';
import { ChainTransaction, Prisma } from '@prisma/client';
import { OutboxService } from '@shared/outbox/outbox.service';
import { QUEUE_CHAIN } from '@shared/queue/queue.constants';
import { CHAIN_SETTINGS, type ChainSettings } from '../chain.config';
import type { ChainSubjectType, ChainTxKind } from '../chain.constants';
import {
  CHAIN_TX_AGGREGATE,
  CHAIN_TX_REQUESTED,
  type ChainTxEventPayload,
} from '../chain.events';

/**
 * Intención de dominio (contrato O3 §2.2): lo único que acepta el firmante.
 * `params` lleva solo identificadores de dominio; el firmante lee el resto de
 * la base. Nunca una transacción ya construida.
 */
export interface ChainIntentInput {
  kind: ChainTxKind;
  /** Único: volver a registrar la misma intención no crea otra transacción. */
  intentKey: string;
  subject: { type: ChainSubjectType; id: string };
  wineryId?: string | null;
  params?: Prisma.InputJsonObject;
  requestedBy?: {
    userId: string | null;
    fullName: string | null;
    source: 'API' | 'WORKER';
  };
  correlationId?: string | null;
}

export interface RegisteredIntent {
  transaction: ChainTransaction;
  /** `false`: ya existía una transacción con esa `intentKey`. */
  created: boolean;
}

/**
 * Registro de intenciones (ADR-005): **nada llega a la red sin pasar por el
 * outbox**. Escribe la transacción `PENDING` y su evento `chain.tx.requested`
 * en la transacción de base de datos de quien llama; el worker la valida, la
 * firma y la envía. Lo usan la API (acciones del back office) y el worker
 * (identidad de las bodegas, tareas programadas).
 */
@Injectable()
export class ChainIntentsService {
  constructor(
    private readonly outbox: OutboxService,
    @Inject(CHAIN_SETTINGS) private readonly settings: ChainSettings,
  ) {}

  /**
   * Idempotente por `intentKey` (§2.3, nivel 2): si ya hay una transacción
   * con esa clave la devuelve tal cual, sin evento nuevo.
   */
  async register(
    tx: Prisma.TransactionClient,
    intent: ChainIntentInput,
  ): Promise<RegisteredIntent> {
    // Dos registros simultáneos de la misma intención: el segundo espera y
    // encuentra la fila del primero (sin violar la clave única)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`chain-intent:${intent.intentKey}`}))`;
    const existing = await tx.chainTransaction.findUnique({
      where: { intentKey: intent.intentKey },
    });
    if (existing) return { transaction: existing, created: false };

    const transaction = await tx.chainTransaction.create({
      data: {
        kind: intent.kind,
        status: 'PENDING',
        network: this.settings.network,
        intentKey: intent.intentKey,
        subjectType: intent.subject.type,
        subjectId: intent.subject.id,
        wineryId: intent.wineryId ?? null,
        intent: intent.params ?? {},
        requestedByUserId: intent.requestedBy?.userId ?? null,
        requestedByName: intent.requestedBy?.fullName ?? null,
        requestedSource: intent.requestedBy?.source ?? 'WORKER',
        correlationId: intent.correlationId ?? null,
      },
    });
    await this.announce(tx, transaction);
    return { transaction, created: true };
  }

  /**
   * `FAILED → PENDING` (reintento manual, §2.3): el worker la reconstruye con
   * secuencia y comisión nuevas. Quien llama ya comprobó el estado con la
   * fila bloqueada.
   */
  async requeue(
    tx: Prisma.TransactionClient,
    transactionId: string,
  ): Promise<ChainTransaction> {
    const transaction = await tx.chainTransaction.update({
      where: { id: transactionId },
      data: {
        status: 'PENDING',
        attempts: 0,
        lastError: Prisma.DbNull,
        nextAttemptAt: null,
      },
    });
    await this.announce(tx, transaction);
    return transaction;
  }

  private async announce(
    tx: Prisma.TransactionClient,
    transaction: ChainTransaction,
  ): Promise<void> {
    await this.outbox.add<ChainTxEventPayload>(tx, {
      type: CHAIN_TX_REQUESTED,
      aggregateType: CHAIN_TX_AGGREGATE,
      aggregateId: transaction.id,
      queue: QUEUE_CHAIN,
      payload: {
        transactionId: transaction.id,
        kind: transaction.kind,
        wineryId: transaction.wineryId,
      },
      ...(transaction.correlationId
        ? { correlationId: transaction.correlationId }
        : {}),
    });
  }
}
