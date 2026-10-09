import { Inject, Injectable, Logger } from '@nestjs/common';
import { ChainTransaction, Prisma } from '@prisma/client';
import { OutboxService } from '@shared/outbox/outbox.service';
import { PrismaService } from '@shared/prisma/prisma.service';
import { QUEUE_CHAIN } from '@shared/queue/queue.constants';
import { CHAIN_SETTINGS, type ChainSettings } from '../chain.config';
import type { ChainTxKind, ChainTxStatus } from '../chain.constants';
import { ChainAlertsWriter } from '../alerts/chain-alerts.writer';
import {
  CHAIN_TX_AGGREGATE,
  CHAIN_TX_CONFIRMED,
  CHAIN_TX_FAILED,
  type ChainTxEventPayload,
  type ChainTxFailedPayload,
} from '../chain.events';
import {
  CRITICAL_CHAIN_TX_ERRORS,
  ChainTxFailure,
} from '../tx/chain-tx.errors';
import { assertTransition, decideRetry } from '../tx/chain-tx.state';
import {
  INTENT_HANDLERS,
  type ConfirmedLookup,
  type IntentEnv,
  type IntentHandler,
} from './signer/intent-handler';

export interface AttemptNote {
  txHash?: string | null;
  sequence?: string | null;
  errorCode?: string | null;
  detail?: string | null;
}

export type FailOutcome = 'RETRYING' | 'FAILED' | 'IGNORED';

/**
 * Cambios de estado de una transacción en el worker (contrato O3 §2.3): cada
 * uno bloquea la fila, comprueba la transición, deja su entrada en el
 * historial (`chain_tx_attempts`, solo inserción) y publica sus eventos en la
 * misma transacción de base de datos.
 */
@Injectable()
export class ChainTxLifecycle {
  private readonly logger = new Logger(ChainTxLifecycle.name);
  private readonly handlers: Map<string, IntentHandler>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly alerts: ChainAlertsWriter,
    @Inject(CHAIN_SETTINGS) private readonly settings: ChainSettings,
    @Inject(INTENT_HANDLERS) handlers: IntentHandler[],
  ) {
    this.handlers = new Map(handlers.map((h) => [h.kind, h]));
  }

  handlerOf(kind: string): IntentHandler | null {
    return this.handlers.get(kind) ?? null;
  }

  supportedKinds(): ChainTxKind[] {
    return [...this.handlers.keys()] as ChainTxKind[];
  }

  /** Bloquea la fila y la devuelve (o `null` si no existe). */
  async lock(
    db: Prisma.TransactionClient,
    id: string,
  ): Promise<ChainTransaction | null> {
    await db.$queryRaw`SELECT id FROM chain_transactions WHERE id = ${id}::uuid FOR UPDATE`;
    return db.chainTransaction.findUnique({ where: { id } });
  }

  async note(
    db: Prisma.TransactionClient,
    transaction: Pick<ChainTransaction, 'id' | 'attempts'>,
    status: ChainTxStatus,
    note: AttemptNote = {},
  ): Promise<void> {
    await db.chainTxAttempt.create({
      data: {
        transactionId: transaction.id,
        attempt: Math.max(1, transaction.attempts),
        status,
        txHash: note.txHash ?? null,
        sequence: note.sequence ?? null,
        errorCode: note.errorCode ?? null,
        detail: note.detail?.slice(0, 1000) ?? null,
      },
    });
  }

  /**
   * Fallo de un intento. Transitorio con intentos por delante → `RETRYING`
   * con su espera; definitivo o agotado → `FAILED`, alerta y evento.
   *
   * `unknownOutcome`: la transacción pudo llegar a la red; se conserva su
   * `maxTime` para no reconstruirla antes de que caduque (§2.3, nivel 3).
   */
  async fail(
    id: string,
    failure: ChainTxFailure,
    options: { unknownOutcome?: boolean; from?: ChainTxStatus[] } = {},
  ): Promise<FailOutcome> {
    const from = options.from ?? ['BUILDING', 'SUBMITTED', 'RETRYING'];
    return this.prisma.$transaction(async (db) => {
      const row = await this.lock(db, id);
      if (!row || !from.includes(row.status as ChainTxStatus)) {
        return 'IGNORED';
      }
      const now = new Date();
      const decision = failure.retryable
        ? decideRetry(row.attempts, this.settings.txRetryDelaysMs, now)
        : ({ retry: false } as const);
      const lastError = {
        code: failure.code,
        message: failure.message,
        retryable: decision.retry,
        ...(Object.keys(failure.meta).length > 0 ? { meta: failure.meta } : {}),
      } as Prisma.InputJsonObject;
      const attemptNote: AttemptNote = {
        txHash: row.txHash,
        errorCode: failure.code,
        detail: failure.detail,
      };

      if (decision.retry) {
        assertTransition(row.status as ChainTxStatus, 'RETRYING');
        await db.chainTransaction.update({
          where: { id },
          data: {
            status: 'RETRYING',
            lastError,
            nextAttemptAt: decision.nextAttemptAt,
            // Con resultado desconocido se conserva `maxTime`: el firmante
            // consulta el hash antes de reconstruirla
            ...(options.unknownOutcome ? {} : { maxTime: null }),
          },
        });
        await this.note(db, row, 'RETRYING', attemptNote);
        return 'RETRYING';
      }

      assertTransition(row.status as ChainTxStatus, 'FAILED');
      const failed = await db.chainTransaction.update({
        where: { id },
        data: { status: 'FAILED', lastError, nextAttemptAt: null },
      });
      await this.note(db, row, 'FAILED', attemptNote);
      await this.handlerOf(row.kind)?.onFailed?.(db, failed, failure);
      await this.alerts.raise(db, {
        code:
          failure.code === 'CHN_INTENT_REJECTED'
            ? 'CHN_INTENT_REJECTED'
            : failure.code === 'CHN_INSUFFICIENT_BALANCE'
              ? 'LOW_BALANCE'
              : 'TX_FAILED',
        level: CRITICAL_CHAIN_TX_ERRORS.includes(failure.code)
          ? 'CRITICAL'
          : 'WARNING',
        subjectType: 'TRANSACTION',
        subjectId: id,
        wineryId: row.wineryId,
        message: `${row.kind} falló (${failure.code}): ${failure.message}`,
        actual: { code: failure.code, detail: failure.detail },
      });
      await this.outbox.add<ChainTxFailedPayload>(db, {
        type: CHAIN_TX_FAILED,
        aggregateType: CHAIN_TX_AGGREGATE,
        aggregateId: id,
        queue: QUEUE_CHAIN,
        payload: {
          transactionId: id,
          kind: row.kind,
          wineryId: row.wineryId,
          errorCode: failure.code,
        },
      });
      this.logger.error({
        message: `Transacción ${row.kind} ${id} FAILED: ${failure.code}`,
        transactionId: id,
        kind: row.kind,
        errorCode: failure.code,
        detail: failure.detail,
      });
      return 'FAILED';
    });
  }

  /**
   * `→ CONFIRMED` con los efectos del manejador en la misma transacción de
   * base de datos. Devuelve `false` si otra réplica ya la había resuelto.
   */
  async confirm(
    id: string,
    from: ChainTxStatus[],
    lookup: ConfirmedLookup | null,
    verification: unknown,
    env: IntentEnv,
    note: string | null = null,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (db) => {
      const row = await this.lock(db, id);
      if (!row || !from.includes(row.status as ChainTxStatus)) return false;
      assertTransition(row.status as ChainTxStatus, 'CONFIRMED');
      const confirmed = await db.chainTransaction.update({
        where: { id },
        data: {
          status: 'CONFIRMED',
          confirmedAt: lookup?.closedAt ?? new Date(),
          ledger: lookup?.ledger ?? row.ledger,
          feeChargedStroops: lookup?.feeChargedStroops ?? row.feeChargedStroops,
          rentFeeStroops: lookup?.rentFeeStroops ?? row.rentFeeStroops,
          result: lookup
            ? ({
                returnValue: (lookup.returnValue ??
                  null) as Prisma.InputJsonValue,
                contractEvents: lookup.contractEvents,
              } as Prisma.InputJsonObject)
            : (row.result ?? Prisma.DbNull),
          lastError: Prisma.DbNull,
          nextAttemptAt: null,
        },
      });
      await this.note(db, row, 'CONFIRMED', {
        txHash: row.txHash,
        detail: note,
      });
      await this.handlerOf(row.kind)?.onConfirmed?.(
        db,
        confirmed,
        verification,
        env,
      );
      await this.outbox.add<ChainTxEventPayload>(db, {
        type: CHAIN_TX_CONFIRMED,
        aggregateType: CHAIN_TX_AGGREGATE,
        aggregateId: id,
        queue: QUEUE_CHAIN,
        payload: {
          transactionId: id,
          kind: row.kind,
          wineryId: row.wineryId,
        },
      });
      return true;
    });
  }
}
