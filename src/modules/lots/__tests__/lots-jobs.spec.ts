import { ConfigService } from '@nestjs/config';
import type { JobContext } from '@shared/queue/job-handler';
import type { OutboxJobData } from '@shared/outbox/outbox.types';
import type { BottleCodeExportBuilder } from '../bottle-code-export.builder';
import { BottleCodesExportHandler } from '../jobs/bottle-codes-export.handler';
import { BottleCodeExportsCleanupTask } from '../jobs/bottle-code-exports-cleanup.task';
import { LotCertifiedHandler } from '../jobs/lot-certified.handler';
import {
  BOTTLE_CODES_EXPORT_JOB,
  BottleCodesExportPayload,
  LOT_CERTIFIED,
  LotCertifiedPayload,
} from '../lots.events';

const EXPORT_ID = '0b0e7a52-1f0c-4a55-9f0e-3a0d5a1e2b20';

function job<T>(eventType: string, payload: T): OutboxJobData<T> {
  return {
    outboxEventId: 'evt-1',
    eventType,
    aggregateType: 'bottle_code_export',
    aggregateId: EXPORT_ID,
    payload,
    correlationId: null,
    occurredAt: '2026-10-01T12:00:00.000Z',
  };
}

function context(attempt: number): JobContext {
  return {
    jobId: 'evt-1',
    name: BOTTLE_CODES_EXPORT_JOB,
    queue: 'default',
    attempt,
    correlationId: 'c-1',
  };
}

describe('trabajos de los lotes en el worker (§15)', () => {
  const payload: BottleCodesExportPayload = {
    exportId: EXPORT_ID,
    lotId: 'lot-1',
    wineryId: 'winery-1',
  };

  function setup(build: jest.Mock, attempts?: number) {
    const builder = {
      build,
      markFailed: jest.fn().mockResolvedValue(undefined),
      removeExpired: jest.fn().mockResolvedValue(2),
    };
    const config = new ConfigService(
      attempts === undefined ? {} : { JOB_ATTEMPTS: attempts },
    );
    return {
      builder,
      handler: new BottleCodesExportHandler(
        builder as unknown as BottleCodeExportBuilder,
        config,
      ),
    };
  }

  it('trace.bottle-codes.export genera el ZIP de la exportación', async () => {
    const { builder, handler } = setup(
      jest.fn().mockResolvedValue({ status: 'READY', rows: 10 }),
    );
    await handler.handle(job(BOTTLE_CODES_EXPORT_JOB, payload), context(1));
    expect(builder.build).toHaveBeenCalledWith(EXPORT_ID);
    expect(builder.markFailed).not.toHaveBeenCalled();
  });

  it('una exportación ya lista (reentrega) no falla', async () => {
    const { handler } = setup(
      jest.fn().mockResolvedValue({ status: 'SKIPPED', reason: 'ya estaba' }),
    );
    await expect(
      handler.handle(job(BOTTLE_CODES_EXPORT_JOB, payload), context(2)),
    ).resolves.toBeUndefined();
  });

  it('si falla, se reintenta; solo el último intento la deja FAILED', async () => {
    const error = new Error('almacenamiento caído');
    const { builder, handler } = setup(jest.fn().mockRejectedValue(error), 3);
    await expect(
      handler.handle(job(BOTTLE_CODES_EXPORT_JOB, payload), context(1)),
    ).rejects.toThrow('almacenamiento caído');
    await expect(
      handler.handle(job(BOTTLE_CODES_EXPORT_JOB, payload), context(2)),
    ).rejects.toThrow();
    expect(builder.markFailed).not.toHaveBeenCalled();
    await expect(
      handler.handle(job(BOTTLE_CODES_EXPORT_JOB, payload), context(3)),
    ).rejects.toThrow();
    expect(builder.markFailed).toHaveBeenCalledWith(EXPORT_ID, error);
  });

  it('sin JOB_ATTEMPTS usa los 5 intentos por defecto', async () => {
    const { builder, handler } = setup(
      jest.fn().mockRejectedValue(new Error('x')),
    );
    await expect(
      handler.handle(job(BOTTLE_CODES_EXPORT_JOB, payload), context(4)),
    ).rejects.toThrow();
    expect(builder.markFailed).not.toHaveBeenCalled();
    await expect(
      handler.handle(job(BOTTLE_CODES_EXPORT_JOB, payload), context(5)),
    ).rejects.toThrow();
    expect(builder.markFailed).toHaveBeenCalledTimes(1);
  });

  it('la limpieza horaria borra los ZIP caducados', async () => {
    const { builder } = setup(jest.fn());
    await new BottleCodeExportsCleanupTask(
      builder as unknown as BottleCodeExportBuilder,
    ).handle();
    expect(builder.removeExpired).toHaveBeenCalledTimes(1);
  });

  it('lot.certified pide el anclaje del expediente del lote (contrato O3 §7.1)', async () => {
    const certified: LotCertifiedPayload = {
      lotId: 'lot-1',
      wineryId: 'winery-1',
      lotCode: 'CVJ-2026-SINGANI-004',
      hash: 'ab'.repeat(32),
      bottleMerkleRoot: 'cd'.repeat(32),
      bottleCount: 2950,
      closedAt: '2026-10-01T15:04:05.123Z',
    };
    const db = { tx: true };
    const prisma = {
      $transaction: jest.fn((work: (tx: unknown) => unknown) => work(db)),
    };
    const anchors = { request: jest.fn().mockResolvedValue('REQUESTED') };
    await expect(
      new LotCertifiedHandler(prisma as never, anchors as never).handle(
        job(LOT_CERTIFIED, certified),
      ),
    ).resolves.toBeUndefined();
    expect(anchors.request).toHaveBeenCalledWith(db, 'lot-1');
  });
});
