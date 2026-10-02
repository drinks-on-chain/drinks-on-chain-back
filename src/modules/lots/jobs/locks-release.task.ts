import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { AgingStatusEnum, RestStatusEnum } from '@prisma/client';
import { AUDIT_TX_OPTIONS, AuditService } from '@shared/audit/audit.service';
import { PrismaService } from '@shared/prisma/prisma.service';
import { JobHandler, ScheduledTask } from '@shared/queue/job-handler';
import { parseLotRules } from '../domain/lot-rules';
import type { LotStage } from '../domain/lot-stage';
import { releaseDueLocks } from '../lock-release';
import { dbClock, lockLotRow } from '../trace-db';

export const TRACE_LOCKS_RELEASE_TASK = 'trace.locks.release';

export interface LocksReleaseResult {
  /** Lotes con alguna fuente aún bloqueada que se revisaron. */
  lots: number;
  /** Candados que pasaron a `READY` en esta ejecución. */
  released: number;
  /** Lotes cuya revisión falló (se reintentan en la siguiente ejecución). */
  failed: number;
}

/**
 * Tarea diaria `trace.locks.release` (contrato O2 §15), a las 00:05 de
 * America/La_Paz (04:05 UTC) y al arrancar el worker, para ponerse al día:
 * pasa a `READY` las crianzas y las destilaciones cuyo candado ya se cumplió
 * según la **instantánea** de su lote y el reloj de la base, y deja
 * `LOCK_RELEASED` en la línea de tiempo y en la bitácora (actor sistema).
 *
 * Idempotente y segura con varias réplicas: cada lote va en su transacción
 * con su fila bloqueada, y solo se toca lo que sigue en `AGING`/`RESTING`.
 * Solo persiste el estado ("reposo persistido", EA-01, ERP-12): el
 * embotellado recalcula los candados y nunca depende de esta marca.
 */
@Injectable()
@ScheduledTask({
  name: TRACE_LOCKS_RELEASE_TASK,
  pattern: '5 4 * * *',
  description:
    'Candados cumplidos de crianza y reposo a READY (00:05 America/La_Paz)',
})
export class TraceLocksReleaseTask
  implements JobHandler, OnApplicationBootstrap
{
  private readonly logger = new Logger(TraceLocksReleaseTask.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Al arrancar el worker: se pone al día sin bloquear el arranque. */
  onApplicationBootstrap(): void {
    void this.handle().catch((error: unknown) => {
      this.logger.error(
        `No se pudieron revisar los candados al arrancar: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  async handle(): Promise<void> {
    const result = await this.run();
    this.logger.log(
      `Candados: ${result.released} liberados en ${result.lots} lotes revisados${result.failed > 0 ? ` (${result.failed} con error)` : ''}`,
    );
  }

  async run(): Promise<LocksReleaseResult> {
    const lots = await this.prisma.lot.findMany({
      where: {
        discardedAt: null,
        OR: [
          {
            wineAgingBatches: {
              some: { agingStatus: AgingStatusEnum.AGING, discardedAt: null },
            },
          },
          {
            productionBatches: {
              some: {
                restStatus: RestStatusEnum.RESTING,
                discardedAt: null,
                processEndDate: { not: null },
              },
            },
          },
        ],
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    const result: LocksReleaseResult = {
      lots: lots.length,
      released: 0,
      failed: 0,
    };
    for (const { id } of lots) {
      try {
        result.released += await this.releaseLot(id);
      } catch (error) {
        result.failed += 1;
        this.logger.error(
          `Candados del lote ${id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return result;
  }

  private releaseLot(lotId: string): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      await lockLotRow(tx, lotId);
      const lot = await tx.lot.findUnique({
        where: { id: lotId },
        select: { id: true, wineryId: true, stage: true, rules: true },
      });
      if (!lot) return 0;
      const clock = await dbClock(tx);
      const released = await releaseDueLocks(
        tx,
        {
          id: lot.id,
          wineryId: lot.wineryId,
          stage: lot.stage as LotStage,
          rules: parseLotRules(lot.rules),
        },
        clock,
        this.audit,
      );
      return released.length;
    }, AUDIT_TX_OPTIONS);
  }
}
