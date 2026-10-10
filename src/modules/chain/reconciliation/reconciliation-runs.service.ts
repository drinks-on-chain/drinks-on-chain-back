import { Injectable } from '@nestjs/common';
import { Prisma, ReconciliationRun } from '@prisma/client';
import { OutboxService } from '@shared/outbox/outbox.service';
import { QUEUE_DEFAULT } from '@shared/queue/queue.constants';
import type {
  ReconciliationDepth,
  ReconciliationScope,
} from '../chain.constants';
import {
  CHAIN_RECONCILIATION_REQUESTED,
  type ChainReconciliationRequestedPayload,
} from '../chain.events';

export type ReconciliationTrigger = 'SCHEDULED' | 'MANUAL' | 'INDEXER_GAP';

export interface ReconciliationRequest {
  scope: ReconciliationScope;
  subjectId?: string | null;
  depth: ReconciliationDepth;
  trigger: ReconciliationTrigger;
  requestedByUserId?: string | null;
}

/** Una ejecución `RUNNING` más vieja que esto se quedó a medias (worker caído). */
export const STALE_RUN_MS = 30 * 60_000;

/** Ya hay una conciliación en curso para ese alcance (→ 409 en la API). */
export class ReconciliationAlreadyRunning extends Error {
  constructor(readonly runId: string) {
    super('Ya hay una conciliación en curso para ese alcance');
    this.name = 'ReconciliationAlreadyRunning';
  }
}

/**
 * Registro de ejecuciones de la conciliación (contrato O3 §8.2). Lo comparten
 * la API (lanzarla a mano) y el worker (programadas y huecos del indexador):
 * crea la fila `RUNNING` y, si no la va a ejecutar quien llama, su evento
 * `chain.reconciliation.requested` en la misma transacción. Una en curso por
 * alcance.
 */
@Injectable()
export class ReconciliationRunsService {
  constructor(private readonly outbox: OutboxService) {}

  /**
   * Crea la ejecución `RUNNING`. Con `announce` (la API) deja además el evento
   * para que el worker la ejecute; sin él, quien llama la ejecuta en seguida.
   */
  async open(
    db: Prisma.TransactionClient,
    request: ReconciliationRequest,
    options: { announce: boolean; now?: Date } = { announce: true },
  ): Promise<ReconciliationRun> {
    const subjectId =
      request.scope === 'ALL' ? null : (request.subjectId ?? null);
    const now = options.now ?? new Date();
    // Dos peticiones simultáneas del mismo alcance: la segunda ve la primera
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`chain-reconcile:${request.scope}:${subjectId ?? ''}`}))`;
    // Las que un worker dejó a medias no bloquean para siempre
    await db.reconciliationRun.updateMany({
      where: {
        status: 'RUNNING',
        startedAt: { lt: new Date(now.getTime() - STALE_RUN_MS) },
      },
      data: { status: 'ERROR', finishedAt: now },
    });
    const running = await db.reconciliationRun.findFirst({
      where: { status: 'RUNNING', scope: request.scope, subjectId },
      select: { id: true },
    });
    if (running) throw new ReconciliationAlreadyRunning(running.id);
    const run = await db.reconciliationRun.create({
      data: {
        scope: request.scope,
        subjectId,
        trigger: request.trigger,
        depth: request.depth,
        status: 'RUNNING',
        startedAt: now,
        requestedByUserId: request.requestedByUserId ?? null,
      },
    });
    if (options.announce) {
      await this.outbox.add<ChainReconciliationRequestedPayload>(db, {
        type: CHAIN_RECONCILIATION_REQUESTED,
        aggregateType: 'reconciliation_run',
        aggregateId: run.id,
        queue: QUEUE_DEFAULT,
        payload: { runId: run.id },
      });
    }
    return run;
  }
}
