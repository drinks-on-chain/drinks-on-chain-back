import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@shared/prisma/prisma.service';
import { CHAIN_SETTINGS, type ChainSettings } from '../chain.config';
import { ChainTxFailure } from '../tx/chain-tx.errors';
import { ChainJobsQueue } from './chain-jobs.queue';
import { ChainTxLifecycle } from './chain-tx-lifecycle.service';

/** Una transacción `BUILDING` más tiempo que esto quedó a medias (worker caído). */
const STALE_BUILDING_MS = 180_000;
/** Margen para que el relay del outbox entregue una intención recién escrita. */
const PENDING_GRACE_MS = 3_000;
/** Cada cuánto se vuelve a evaluar una intención en espera (`CHN_MINT_DISABLED`). */
const HOLD_RECHECK_MS = 60_000;
const BATCH = 50;

export interface SweepResult {
  recovered: number;
  polled: number;
  woken: number;
}

/**
 * Barrido de `chain.tx.poll` (cada 5 s, contrato O3 §11): red de seguridad de
 * las colas. Consulta las transacciones `SUBMITTED`, despierta las que ya
 * pueden reintentarse o esperaban turno y recupera las que un worker dejó a
 * medias. No firma nada: solo encola trabajos idempotentes.
 */
@Injectable()
export class ChainTxSweeper {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: ChainTxLifecycle,
    private readonly jobs: ChainJobsQueue,
    @Inject(CHAIN_SETTINGS) private readonly settings: ChainSettings,
  ) {}

  async sweep(now: Date = new Date()): Promise<SweepResult> {
    const result: SweepResult = { recovered: 0, polled: 0, woken: 0 };
    if (!this.settings.enabled) return result;
    const { network } = this.settings;
    const ago = (ms: number) => new Date(now.getTime() - ms);

    const stale = await this.prisma.chainTransaction.findMany({
      where: {
        network,
        status: 'BUILDING',
        updatedAt: { lt: ago(STALE_BUILDING_MS) },
      },
      select: { id: true },
      take: BATCH,
    });
    for (const { id } of stale) {
      // Pudo llegar a enviarse: se conserva el hash para consultarlo antes
      const outcome = await this.lifecycle.fail(
        id,
        new ChainTxFailure('CHN_RPC_UNAVAILABLE', 'el worker se interrumpió'),
        { unknownOutcome: true, from: ['BUILDING'] },
      );
      if (outcome !== 'IGNORED') result.recovered += 1;
    }

    const submitted = await this.prisma.chainTransaction.findMany({
      where: { network, status: 'SUBMITTED' },
      orderBy: { updatedAt: 'asc' },
      select: { id: true },
      take: BATCH,
    });
    for (const { id } of submitted) await this.jobs.confirm(id);
    result.polled = submitted.length;

    const waiting = await this.prisma.chainTransaction.findMany({
      where: {
        network,
        abandonedAt: null,
        OR: [
          { status: 'RETRYING', nextAttemptAt: { lte: now } },
          { status: 'RETRYING', nextAttemptAt: null },
          {
            status: 'PENDING',
            lastError: { equals: Prisma.DbNull },
            updatedAt: { lt: ago(PENDING_GRACE_MS) },
          },
          {
            status: 'PENDING',
            NOT: { lastError: { equals: Prisma.DbNull } },
            updatedAt: { lt: ago(HOLD_RECHECK_MS) },
          },
        ],
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
      take: BATCH,
    });
    for (const { id } of waiting) await this.jobs.process(id);
    result.woken = waiting.length;
    return result;
  }
}
