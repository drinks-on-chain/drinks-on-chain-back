import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@shared/prisma/prisma.service';
import { AuditService } from '@shared/audit/audit.service';
import { backfillHarvestChain, BackfillResult } from './lot-backfill';
import { resolvePassportBaseUrl } from './bottle-units';

/** Intentos antes de dejar un pesaje en la cola para revisión manual. */
export const BACKFILL_MAX_ATTEMPTS = 5;

/**
 * Relleno de la migración de la Ola 2 (contrato O2 §2.6): procesa la cola
 * `lot_backfill_pending` que llenó la migración con los pesajes anteriores.
 * Arranca con la API sin bloquearla; cada pesaje va en su propia transacción
 * con `FOR UPDATE SKIP LOCKED` (varias instancias se reparten la cola sin
 * repetir). Un error deja el pesaje en la cola con `last_error` y se
 * reintenta en el siguiente arranque (hasta 5 veces).
 */
@Injectable()
export class LotBackfillRunner implements OnApplicationBootstrap {
  private readonly logger = new Logger(LotBackfillRunner.name);
  private running: Promise<BackfillResult[]> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.get<string>('LOT_BACKFILL_ON_BOOT') === 'false') return;
    void this.run().catch((error: unknown) =>
      this.logger.error(
        `Relleno de lotes interrumpido: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }

  /** Procesa la cola entera (una sola ejecución a la vez por proceso). */
  run(): Promise<BackfillResult[]> {
    this.running ??= this.drain().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async drain(): Promise<BackfillResult[]> {
    const results: BackfillResult[] = [];
    const failed = new Set<string>();
    const passportBaseUrl = resolvePassportBaseUrl({
      PASSPORT_BASE_URL: this.config.get<string>('PASSPORT_BASE_URL'),
      APP_URL_MARKETPLACE: this.config.get<string>('APP_URL_MARKETPLACE'),
    });
    for (;;) {
      let current: string | null = null;
      try {
        const result = await this.prisma.$transaction(
          async (tx) => {
            const rows = await tx.$queryRaw<{ harvest_batch_id: string }[]>`
              SELECT harvest_batch_id FROM lot_backfill_pending
              WHERE attempts < ${BACKFILL_MAX_ATTEMPTS}
                AND NOT (harvest_batch_id = ANY(${[...failed]}::uuid[]))
              ORDER BY enqueued_at, harvest_batch_id
              LIMIT 1
              FOR UPDATE SKIP LOCKED`;
            if (rows.length === 0) return null;
            current = rows[0].harvest_batch_id;
            const r = await backfillHarvestChain(tx, current, {
              passportBaseUrl,
              audit: (client, input) => this.audit.record(client, input),
            });
            await tx.lotBackfillPending.delete({
              where: { harvestBatchId: current },
            });
            return r;
          },
          { maxWait: 10_000, timeout: 300_000 },
        );
        if (!result) break;
        results.push(result);
      } catch (error) {
        if (!current) throw error;
        failed.add(current);
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Relleno del pesaje ${current}: ${message}`);
        await this.prisma.lotBackfillPending.updateMany({
          where: { harvestBatchId: current },
          data: {
            attempts: { increment: 1 },
            lastError: message.slice(0, 2000),
          },
        });
      }
    }
    if (results.length > 0 || failed.size > 0) {
      const issues = results.reduce((n, r) => n + r.issues.length, 0);
      this.logger.log(
        `Relleno de lotes (Ola 2): ${results.filter((r) => r.lotId && !r.skipped).length} lotes creados, ` +
          `${results.filter((r) => r.skipped).length} pesajes ya asignados, ${issues} incidencias de cumplimiento, ${failed.size} con error`,
      );
    }
    return results;
  }
}
