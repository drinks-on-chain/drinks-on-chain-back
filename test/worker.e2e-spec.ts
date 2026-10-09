import { Injectable, Module } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { tmpdir } from 'os';
import Redis from 'ioredis';
import { join } from 'path';
import { OutboxStatusEnum } from '@prisma/client';
import { WorkerModule } from '../src/worker/worker.module';
import { WORKER_SETTINGS, WorkerSettings } from '../src/worker/worker.config';
import { OutboxRelayService } from '../src/worker/outbox-relay.service';
import { QueueRegistry } from '../src/worker/queue-registry.service';
import { JobDispatcher } from '../src/worker/job-dispatcher.service';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { OutboxService } from '../src/shared/outbox/outbox.service';
import { OutboxModule } from '../src/shared/outbox/outbox.module';
import {
  HandlesJob,
  JobContext,
  JobHandler,
} from '../src/shared/queue/job-handler';
import { OutboxJobData } from '../src/shared/outbox/outbox.types';
import { CorrelationIdMiddleware } from '../src/shared/middleware/correlation-id.middleware';
import { WineryActivatedHandler } from '../src/modules/wineries/jobs/winery-activated.handler';
import { LotCertifiedHandler } from '../src/modules/lots/jobs/lot-certified.handler';
import { BOTTLE_CODE_EXPORTS_CLEANUP_TASK } from '../src/modules/lots/jobs/bottle-code-exports-cleanup.task';
import { TRACE_LOCKS_RELEASE_TASK } from '../src/modules/lots/jobs/locks-release.task';
import {
  BOTTLE_CODES_EXPORT_JOB,
  LOT_CERTIFIED,
} from '../src/modules/lots/lots.events';
import { EMAIL_REQUESTED } from '../src/modules/mail/mail.events';
import { SETTING_CHANGED } from '../src/modules/settings/settings.events';
import {
  WINERY_ACTIVATED,
  WINERY_STATUS_CHANGED,
} from '../src/modules/wineries/wineries.events';
import {
  CHAIN_ALERT_RAISED,
  CHAIN_BALANCE_CHECK_TASK,
  CHAIN_IDENTITY_BACKFILL_JOB,
  CHAIN_TESTNET_FUND_TASK,
  CHAIN_TX_CONFIRMED,
  CHAIN_TX_CONFIRM_JOB,
  CHAIN_TX_FAILED,
  CHAIN_TX_POLL_TASK,
  CHAIN_TX_PROCESS_JOB,
  CHAIN_TX_REQUESTED,
  WINERY_CHAIN_IDENTITY_READY,
} from '../src/modules/chain/chain.events';
import { heartbeatAgeMs } from '../src/worker-healthcheck';
import {
  QUEUE_CHAIN,
  QUEUE_CHAIN_POLL,
  QUEUE_DEFAULT,
  QUEUE_EMAIL,
  workerHeartbeatKey,
} from '../src/shared/queue/queue.constants';

const run = `o0be3w-${Date.now()}`;

@Injectable()
@HandlesJob('default', 'e2e.ping')
class PingHandler implements JobHandler<OutboxJobData<{ n: number }>> {
  readonly calls: {
    eventId: string;
    correlationId?: string;
    attempt: number;
  }[] = [];

  async handle(
    data: OutboxJobData<{ n: number }>,
    context: JobContext,
  ): Promise<void> {
    this.calls.push({
      eventId: data.outboxEventId,
      correlationId: CorrelationIdMiddleware.getCorrelationId(),
      attempt: context.attempt,
    });
  }
}

@Module({ imports: [OutboxModule], providers: [PingHandler] })
class E2eJobsModule {}

async function waitFor(
  condition: () => Promise<boolean> | boolean,
  timeoutMs = 20000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Tiempo agotado esperando la condición');
}

/**
 * Worker con Postgres y Redis reales: outbox → relay → BullMQ → procesador,
 * una sola vez aunque haya dos relays a la vez; tareas programadas; latido.
 */
describe('Worker: outbox, colas y tareas programadas (e2e)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let outbox: OutboxService;
  let queues: QueueRegistry;
  let ping: PingHandler;
  let secondPrisma: PrismaService;
  let secondRelay: OutboxRelayService;

  const settings: WorkerSettings = {
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    // Prefijo propio: no toca las colas de nadie
    queuePrefix: run,
    concurrency: 5,
    jobAttempts: 3,
    jobBackoffMs: 200,
    relay: {
      intervalMs: 100,
      batchSize: 7,
      maxAttempts: 3,
      retryBaseMs: 200,
      retryMaxMs: 2000,
      lockTimeoutMs: 60000,
    },
    retentionDays: 7,
    heartbeat: {
      file: join(tmpdir(), `${run}.heartbeat`),
      intervalMs: 1000,
      maxAgeMs: 30000,
    },
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [WorkerModule, E2eJobsModule],
    })
      .overrideProvider(WORKER_SETTINGS)
      .useValue(settings)
      .compile();
    await moduleRef.init();

    prisma = moduleRef.get(PrismaService);
    outbox = moduleRef.get(OutboxService);
    queues = moduleRef.get(QueueRegistry);
    ping = moduleRef.get(PingHandler);

    // Segundo relay con su propia conexión, como otra réplica del worker
    secondPrisma = new PrismaService();
    await secondPrisma.$connect();
    secondRelay = new OutboxRelayService(secondPrisma, queues, settings);
    secondRelay.start();
  });

  afterAll(async () => {
    await secondRelay?.stop();
    await secondPrisma?.$disconnect();
    if (prisma) {
      await prisma.outboxEvent.deleteMany({
        where: { correlationId: { startsWith: run } },
      });
    }
    if (queues) {
      await Promise.allSettled(
        queues.all().map((q) => q.obliterate({ force: true })),
      );
    }
    await moduleRef?.close();
  });

  it('registra los procesadores de los módulos y el de las pruebas', () => {
    expect(moduleRef.get(JobDispatcher).registeredJobs()).toEqual(
      expect.arrayContaining([
        'chain/winery.activated',
        'default/e2e.ping',
        'scheduled/outbox.cleanup',
      ]),
    );
  });

  it('cada evento que emite la API tiene un procesador, y solo uno (contrato O2 §15)', () => {
    // Dos procesadores para la misma cola y nombre no dejan arrancar el
    // worker (JobDispatcher); un evento sin procesador falla sin reintentos
    const registered = moduleRef.get(JobDispatcher).registeredJobs();
    expect(new Set(registered).size).toBe(registered.length);
    const emitted = [
      `${QUEUE_CHAIN}/${LOT_CERTIFIED}`,
      `${QUEUE_DEFAULT}/${BOTTLE_CODES_EXPORT_JOB}`,
      `${QUEUE_CHAIN}/${WINERY_ACTIVATED}`,
      `${QUEUE_EMAIL}/${EMAIL_REQUESTED}`,
      `${QUEUE_DEFAULT}/${SETTING_CHANGED}`,
      // Ola 3 · cadena (contrato O3 §11)
      `${QUEUE_CHAIN}/${WINERY_STATUS_CHANGED}`,
      `${QUEUE_CHAIN}/${CHAIN_TX_REQUESTED}`,
      `${QUEUE_CHAIN}/${CHAIN_TX_CONFIRMED}`,
      `${QUEUE_CHAIN}/${CHAIN_TX_FAILED}`,
      `${QUEUE_CHAIN}/${CHAIN_ALERT_RAISED}`,
      `${QUEUE_CHAIN}/${WINERY_CHAIN_IDENTITY_READY}`,
    ];
    expect(registered).toEqual(expect.arrayContaining(emitted));
    // Colas y tareas de la cadena: `chain` (firmante), `chain-poll`
    // (confirmaciones) y sus tareas programadas
    expect(registered).toEqual(
      expect.arrayContaining([
        `${QUEUE_CHAIN}/${CHAIN_TX_PROCESS_JOB}`,
        `${QUEUE_CHAIN}/${CHAIN_IDENTITY_BACKFILL_JOB}`,
        `${QUEUE_CHAIN_POLL}/${CHAIN_TX_CONFIRM_JOB}`,
        `scheduled/${CHAIN_TX_POLL_TASK}`,
        `scheduled/${CHAIN_BALANCE_CHECK_TASK}`,
        `scheduled/${CHAIN_TESTNET_FUND_TASK}`,
      ]),
    );
    // Tareas programadas de la trazabilidad
    expect(registered).toEqual(
      expect.arrayContaining([
        `scheduled/${TRACE_LOCKS_RELEASE_TASK}`,
        `scheduled/${BOTTLE_CODE_EXPORTS_CLEANUP_TASK}`,
      ]),
    );
  });

  it('lot.certified llega a su procesador de la cola chain y queda DONE', async () => {
    const handler = moduleRef.get(LotCertifiedHandler);
    const spy = jest.spyOn(handler, 'handle');
    const event = await prisma.$transaction((tx) =>
      outbox.add(tx, {
        type: LOT_CERTIFIED,
        aggregateType: 'lot',
        aggregateId: `${run}-lot`,
        queue: QUEUE_CHAIN,
        payload: {
          lotId: `${run}-lot`,
          wineryId: `${run}-winery`,
          lotCode: 'E2E-2026-SINGANI-001',
          hash: 'a'.repeat(64),
          bottleMerkleRoot: 'b'.repeat(64),
          bottleCount: 2950,
          closedAt: new Date().toISOString(),
        },
        correlationId: `${run}-lot-certified`,
      }),
    );
    await waitFor(() =>
      spy.mock.calls.some(
        ([data]) => (data as OutboxJobData).outboxEventId === event.id,
      ),
    );
    await waitFor(async () => {
      const row = await prisma.outboxEvent.findUnique({
        where: { id: event.id },
      });
      return row?.status === OutboxStatusEnum.DONE;
    });
    spy.mockRestore();
  });

  it('un evento escrito en la transacción llega a la cola y se procesa una sola vez con dos relays concurrentes', async () => {
    const correlationId = `${run}-once`;
    const total = 40;
    const ids = await prisma.$transaction(
      async (tx) => {
        const created: string[] = [];
        for (let n = 0; n < total; n += 1) {
          const event = await outbox.add(tx, {
            type: 'e2e.ping',
            aggregateType: 'e2e',
            aggregateId: `${run}-${n}`,
            payload: { n },
            correlationId,
          });
          created.push(event.id);
        }
        return created;
      },
      // 40 inserciones: margen para entornos lentos (Docker en Windows)
      { timeout: 30000 },
    );

    // Además de los dos bucles, vueltas manuales simultáneas de ambos relays
    const firstRelay = moduleRef.get(OutboxRelayService);
    await Promise.all([
      firstRelay.tick(),
      secondRelay.tick(),
      firstRelay.tick(),
      secondRelay.tick(),
    ]);

    const mine = () => ping.calls.filter((c) => ids.includes(c.eventId));
    await waitFor(() => mine().length >= total);
    await waitFor(
      async () =>
        (await prisma.outboxEvent.count({
          where: { id: { in: ids }, status: OutboxStatusEnum.DONE },
        })) === total,
    );
    // Margen para cualquier duplicado tardío
    await new Promise((r) => setTimeout(r, 1500));

    const calls = mine();
    expect(calls).toHaveLength(total);
    expect(new Set(calls.map((c) => c.eventId)).size).toBe(total);
    expect(calls.every((c) => c.correlationId === correlationId)).toBe(true);
    expect(calls.every((c) => c.attempt === 1)).toBe(true);

    const rows = await prisma.outboxEvent.findMany({
      where: { id: { in: ids } },
    });
    expect(rows.every((r) => r.status === OutboxStatusEnum.DONE)).toBe(true);
    expect(rows.every((r) => r.processedAt !== null)).toBe(true);
    // Cada evento se reclamó una sola vez
    expect(rows.every((r) => r.attempts === 1)).toBe(true);
  });

  it('si la transacción se revierte no se publica nada', async () => {
    const correlationId = `${run}-rollback`;
    let eventId = '';
    await expect(
      prisma.$transaction(async (tx) => {
        const event = await outbox.add(tx, {
          type: 'e2e.ping',
          aggregateType: 'e2e',
          aggregateId: `${run}-rollback`,
          payload: { n: -1 },
          correlationId,
        });
        eventId = event.id;
        throw new Error('rollback a propósito');
      }),
    ).rejects.toThrow('rollback a propósito');

    await new Promise((r) => setTimeout(r, 1000));
    expect(await prisma.outboxEvent.count({ where: { id: eventId } })).toBe(0);
    expect(ping.calls.some((c) => c.eventId === eventId)).toBe(false);
    expect(await queues.get('default').getJob(eventId)).toBeUndefined();
  });

  it('winery.activated llega al procesador de la cola chain', async () => {
    const handler = moduleRef.get(WineryActivatedHandler);
    const spy = jest.spyOn(handler, 'handle');
    const correlationId = `${run}-winery`;
    const event = await prisma.$transaction((tx) =>
      outbox.add(tx, {
        type: 'winery.activated',
        aggregateType: 'winery',
        aggregateId: `${run}-winery`,
        queue: 'chain',
        payload: {
          wineryId: `${run}-winery`,
          lotPrefix: 'EEE',
          ownerUserId: 'u',
          activatedAt: new Date().toISOString(),
        },
        correlationId,
      }),
    );

    await waitFor(() =>
      spy.mock.calls.some(
        ([data]) => (data as OutboxJobData).outboxEventId === event.id,
      ),
    );
    spy.mockRestore();
  });

  it('una cola desconocida deja el evento en FAILED', async () => {
    const correlationId = `${run}-bad-queue`;
    const event = await prisma.$transaction((tx) =>
      tx.outboxEvent.create({
        data: {
          eventType: 'e2e.ping',
          aggregateType: 'e2e',
          aggregateId: `${run}-bad`,
          queue: 'no-existe',
          payload: {},
          correlationId,
        },
      }),
    );
    await waitFor(
      async () =>
        (await prisma.outboxEvent.findUnique({ where: { id: event.id } }))
          ?.status === OutboxStatusEnum.FAILED,
    );
    const row = await prisma.outboxEvent.findUnique({
      where: { id: event.id },
    });
    expect(row?.lastError).toContain('Cola desconocida');
  });

  it('registra la tarea programada de limpieza del outbox', async () => {
    const schedulers = await queues.get('scheduled').getJobSchedulers();
    expect(schedulers.map((s) => s.key)).toContain('outbox.cleanup');
  });

  it('escribe el latido que usa el healthcheck del contenedor', async () => {
    await waitFor(() => {
      const age = heartbeatAgeMs(settings.heartbeat.file);
      return age !== null && age < 5000;
    });
  });

  it('escribe el latido en Redis con caducidad (lo lee /v1/health/ready)', async () => {
    const client = new Redis(settings.redisUrl);
    try {
      const key = workerHeartbeatKey(run);
      await waitFor(async () => (await client.get(key)) !== null);
      const beat = JSON.parse((await client.get(key)) ?? '{}') as {
        at?: string;
      };
      expect(Date.now() - Date.parse(beat.at ?? '')).toBeLessThan(5000);
      const ttl = await client.pttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(30000);
    } finally {
      client.disconnect();
    }
  });
});
