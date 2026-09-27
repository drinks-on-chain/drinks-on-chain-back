import { OutboxStatusEnum } from '@prisma/client';
import {
  ClaimedOutboxEvent,
  OutboxRelayService,
  computeRetryDelayMs,
} from '../outbox-relay.service';
import { WorkerSettings } from '../worker.config';
import { PrismaService } from '@shared/prisma/prisma.service';
import { QueueRegistry } from '../queue-registry.service';

const settings: WorkerSettings = {
  redisUrl: 'redis://localhost:6379',
  queuePrefix: 'test',
  concurrency: 1,
  jobAttempts: 3,
  jobBackoffMs: 100,
  relay: {
    intervalMs: 1000,
    batchSize: 10,
    maxAttempts: 3,
    retryBaseMs: 1000,
    retryMaxMs: 10000,
    lockTimeoutMs: 60000,
  },
  retentionDays: 7,
  heartbeat: { file: '/tmp/test.heartbeat', intervalMs: 1000 },
};

const lockedAt = new Date('2026-09-27T10:00:00.000Z');

function event(
  overrides: Partial<ClaimedOutboxEvent> = {},
): ClaimedOutboxEvent {
  return {
    id: 'evt-1',
    eventType: 'winery.created',
    aggregateType: 'winery',
    aggregateId: 'w-1',
    queue: 'chain',
    payload: { wineryId: 'w-1' },
    correlationId: 'corr-1',
    attempts: 1,
    lockedAt,
    createdAt: new Date('2026-09-27T09:59:59.000Z'),
    ...overrides,
  };
}

describe('computeRetryDelayMs', () => {
  it('crece de forma exponencial desde la base', () => {
    expect(computeRetryDelayMs(1, 1000, 60000)).toBe(1000);
    expect(computeRetryDelayMs(2, 1000, 60000)).toBe(2000);
    expect(computeRetryDelayMs(3, 1000, 60000)).toBe(4000);
    expect(computeRetryDelayMs(5, 1000, 60000)).toBe(16000);
  });

  it('respeta el tope', () => {
    expect(computeRetryDelayMs(20, 1000, 60000)).toBe(60000);
    expect(computeRetryDelayMs(1000, 1000, 60000)).toBe(60000);
  });
});

describe('OutboxRelayService', () => {
  let prisma: {
    $queryRaw: jest.Mock;
    outboxEvent: { updateMany: jest.Mock };
  };
  let queueAdd: jest.Mock;
  let queues: { get: jest.Mock };
  let relay: OutboxRelayService;

  beforeEach(() => {
    prisma = {
      $queryRaw: jest.fn(),
      outboxEvent: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    queueAdd = jest.fn().mockResolvedValue({ id: 'evt-1' });
    queues = { get: jest.fn().mockReturnValue({ add: queueAdd }) };
    relay = new OutboxRelayService(
      prisma as unknown as PrismaService,
      queues as unknown as QueueRegistry,
      settings,
    );
    jest.useFakeTimers({ now: new Date('2026-09-27T10:00:01.000Z') });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('sin eventos pendientes no publica nada', async () => {
    prisma.$queryRaw.mockResolvedValue([]);
    await expect(relay.tick()).resolves.toEqual({
      claimed: 0,
      published: 0,
      retried: 0,
      failed: 0,
    });
    expect(queueAdd).not.toHaveBeenCalled();
    expect(prisma.outboxEvent.updateMany).not.toHaveBeenCalled();
  });

  it('publica en la cola del evento con jobId = id del evento y marca DONE', async () => {
    prisma.$queryRaw.mockResolvedValue([event()]);

    const result = await relay.tick();

    expect(result).toEqual({ claimed: 1, published: 1, retried: 0, failed: 0 });
    expect(queues.get).toHaveBeenCalledWith('chain');
    expect(queueAdd).toHaveBeenCalledWith(
      'winery.created',
      {
        outboxEventId: 'evt-1',
        eventType: 'winery.created',
        aggregateType: 'winery',
        aggregateId: 'w-1',
        payload: { wineryId: 'w-1' },
        correlationId: 'corr-1',
        occurredAt: '2026-09-27T09:59:59.000Z',
      },
      { jobId: 'evt-1' },
    );
    expect(prisma.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['evt-1'] },
        status: OutboxStatusEnum.PROCESSING,
        lockedAt,
      },
      data: expect.objectContaining({
        status: OutboxStatusEnum.DONE,
        lockedAt: null,
        lastError: null,
        processedAt: expect.any(Date),
      }),
    });
  });

  it('si la publicación falla vuelve a PENDING con espera exponencial', async () => {
    prisma.$queryRaw.mockResolvedValue([event({ attempts: 2 })]);
    queueAdd.mockRejectedValue(new Error('Redis caído'));

    const result = await relay.tick();

    expect(result).toEqual({ claimed: 1, published: 0, retried: 1, failed: 0 });
    const call = prisma.outboxEvent.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({
      id: 'evt-1',
      status: OutboxStatusEnum.PROCESSING,
      lockedAt,
    });
    expect(call.data.status).toBe(OutboxStatusEnum.PENDING);
    expect(call.data.lockedAt).toBeNull();
    expect(call.data.lastError).toBe('Error: Redis caído');
    // intento 2 → base · 2 = 2000 ms
    expect(call.data.nextAttemptAt).toEqual(new Date(Date.now() + 2000));
  });

  it('pasa a FAILED al agotar OUTBOX_MAX_ATTEMPTS', async () => {
    prisma.$queryRaw.mockResolvedValue([event({ attempts: 3 })]);
    queueAdd.mockRejectedValue(new Error('Redis caído'));

    const result = await relay.tick();

    expect(result).toEqual({ claimed: 1, published: 0, retried: 0, failed: 1 });
    const call = prisma.outboxEvent.updateMany.mock.calls[0][0];
    expect(call.data).toEqual({
      status: OutboxStatusEnum.FAILED,
      lockedAt: null,
      lastError: 'Error: Redis caído',
    });
  });

  it('una cola desconocida es un fallo definitivo sin reintentos', async () => {
    prisma.$queryRaw.mockResolvedValue([event({ queue: 'inexistente' })]);

    const result = await relay.tick();

    expect(result.failed).toBe(1);
    expect(queueAdd).not.toHaveBeenCalled();
    const call = prisma.outboxEvent.updateMany.mock.calls[0][0];
    expect(call.data.status).toBe(OutboxStatusEnum.FAILED);
    expect(call.data.lastError).toContain('Cola desconocida');
  });

  it('en un lote mixto marca cada evento según su resultado', async () => {
    prisma.$queryRaw.mockResolvedValue([
      event({ id: 'ok-1' }),
      event({ id: 'ko-1' }),
      event({ id: 'ok-2' }),
    ]);
    queueAdd.mockImplementation((_name, data: { outboxEventId: string }) =>
      data.outboxEventId === 'ko-1'
        ? Promise.reject(new Error('timeout'))
        : Promise.resolve({}),
    );

    const result = await relay.tick();

    expect(result).toEqual({ claimed: 3, published: 2, retried: 1, failed: 0 });
    const [doneCall, retryCall] = prisma.outboxEvent.updateMany.mock.calls;
    expect(doneCall[0].where.id).toEqual({ in: ['ok-1', 'ok-2'] });
    expect(doneCall[0].data.status).toBe(OutboxStatusEnum.DONE);
    expect(retryCall[0].where.id).toBe('ko-1');
    expect(retryCall[0].data.status).toBe(OutboxStatusEnum.PENDING);
  });

  it('recorta los mensajes de error largos', async () => {
    prisma.$queryRaw.mockResolvedValue([event()]);
    queueAdd.mockRejectedValue(new Error('x'.repeat(5000)));

    await relay.tick();

    const call = prisma.outboxEvent.updateMany.mock.calls[0][0];
    expect(call.data.lastError.length).toBe(2000);
  });

  it('start/stop: el bucle no vuelve a programarse tras stop()', async () => {
    prisma.$queryRaw.mockResolvedValue([]);
    relay.start();
    expect(relay.isRunning()).toBe(true);
    await jest.advanceTimersByTimeAsync(0);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1000);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);

    await relay.stop();
    expect(relay.isRunning()).toBe(false);
    await jest.advanceTimersByTimeAsync(5000);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('un fallo al reclamar no detiene el bucle', async () => {
    prisma.$queryRaw
      .mockRejectedValueOnce(new Error('conexión perdida'))
      .mockResolvedValue([]);
    relay.start();
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(1000);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    await relay.stop();
  });
});
