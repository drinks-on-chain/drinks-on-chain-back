import { mkdtempSync, existsSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { HeartbeatService } from '../heartbeat.service';
import { WorkerSettings } from '../worker.config';
import { PrismaService } from '@shared/prisma/prisma.service';
import { QueueRegistry } from '../queue-registry.service';
import { OutboxRelayService } from '../outbox-relay.service';
import { JobDispatcher } from '../job-dispatcher.service';
import { heartbeatAgeMs } from '../../worker-healthcheck';

describe('HeartbeatService', () => {
  let dir: string;
  let file: string;
  let deps: {
    prisma: { ping: jest.Mock };
    queues: {
      ping: jest.Mock;
      writeHeartbeat: jest.Mock;
      clearHeartbeat: jest.Mock;
    };
    relay: { isRunning: jest.Mock; msSinceLastTick: jest.Mock };
    dispatcher: { isRunning: jest.Mock };
  };
  let service: HeartbeatService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'doc-hb-'));
    file = join(dir, 'sub', 'worker.heartbeat');
    deps = {
      prisma: { ping: jest.fn().mockResolvedValue(true) },
      queues: {
        ping: jest.fn().mockResolvedValue(true),
        writeHeartbeat: jest.fn().mockResolvedValue(undefined),
        clearHeartbeat: jest.fn().mockResolvedValue(undefined),
      },
      relay: {
        isRunning: jest.fn().mockReturnValue(true),
        msSinceLastTick: jest.fn().mockReturnValue(500),
      },
      dispatcher: { isRunning: jest.fn().mockReturnValue(true) },
    };
    const settings = {
      relay: { intervalMs: 1000, lockTimeoutMs: 60000 },
      heartbeat: { file, intervalMs: 10000, maxAgeMs: 45000 },
    } as WorkerSettings;
    service = new HeartbeatService(
      deps.prisma as unknown as PrismaService,
      deps.queues as unknown as QueueRegistry,
      deps.relay as unknown as OutboxRelayService,
      deps.dispatcher as unknown as JobDispatcher,
      settings,
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('con todo sano escribe el latido y el healthcheck lo acepta', async () => {
    const status = await service.beat();
    expect(status.ok).toBe(true);
    expect(existsSync(file)).toBe(true);
    const content = JSON.parse(readFileSync(file, 'utf8'));
    expect(typeof content.at).toBe('string');
    const age = heartbeatAgeMs(file);
    expect(age).not.toBeNull();
    expect(age as number).toBeLessThan(5000);
    // Y el mismo latido en Redis, con caducidad (lo lee /v1/health/ready)
    expect(deps.queues.writeHeartbeat).toHaveBeenCalledWith(
      readFileSync(file, 'utf8'),
      45000,
    );
  });

  it('si Redis falla al escribir el latido, el archivo se escribe igual', async () => {
    deps.queues.writeHeartbeat.mockRejectedValueOnce(new Error('READONLY'));
    const status = await service.beat();
    expect(status.ok).toBe(true);
    expect(existsSync(file)).toBe(true);
  });

  it.each([
    ['Postgres', () => deps.prisma.ping.mockResolvedValue(false)],
    ['Redis', () => deps.queues.ping.mockResolvedValue(false)],
    ['relay parado', () => deps.relay.isRunning.mockReturnValue(false)],
    [
      'relay atascado',
      () => deps.relay.msSinceLastTick.mockReturnValue(999999),
    ],
    ['workers', () => deps.dispatcher.isRunning.mockReturnValue(false)],
  ])('sin %s no escribe el latido', async (_name, breakIt) => {
    breakIt();
    const status = await service.beat();
    expect(status.ok).toBe(false);
    expect(existsSync(file)).toBe(false);
    expect(deps.queues.writeHeartbeat).not.toHaveBeenCalled();
  });

  it('stop() borra el latido', async () => {
    await service.beat();
    await service.stop();
    expect(existsSync(file)).toBe(false);
    expect(deps.queues.clearHeartbeat).toHaveBeenCalled();
  });
});

describe('heartbeatAgeMs', () => {
  it('devuelve null si el archivo no existe o no es válido', () => {
    expect(heartbeatAgeMs(join(tmpdir(), 'no-existe-doc.heartbeat'))).toBe(
      null,
    );
  });
});
