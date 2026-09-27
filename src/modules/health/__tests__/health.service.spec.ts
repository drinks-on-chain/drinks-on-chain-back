import { Test, TestingModule } from '@nestjs/testing';
import { HealthService } from '../health.service';
import { PrismaService } from '@shared/prisma/prisma.service';
import { ConfigService } from '@nestjs/config';

type FakeRedis = {
  ping: () => Promise<string>;
  get: (key: string) => Promise<string | null>;
  connect: () => Promise<void>;
  status: string;
};

describe('HealthService', () => {
  let service: HealthService;
  let prismaService: PrismaService;
  let redis: FakeRedis;
  let getSpy: jest.SpyInstance;

  const config: Record<string, string> = {
    REDIS_URL: 'redis://localhost:6379',
    QUEUE_PREFIX: 'doc-test',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HealthService,
        {
          provide: PrismaService,
          useValue: {
            ping: jest.fn().mockResolvedValue(true),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => config[key]),
            getOrThrow: jest.fn((key: string) => config[key]),
          },
        },
      ],
    }).compile();

    service = module.get<HealthService>(HealthService);
    prismaService = module.get<PrismaService>(PrismaService);

    // Redis falso: sano y con el latido del worker presente
    redis = (service as unknown as { redisClient: FakeRedis }).redisClient;
    jest.spyOn(redis, 'connect').mockResolvedValue();
    jest.spyOn(redis, 'ping').mockResolvedValue('PONG');
    getSpy = jest
      .spyOn(redis, 'get')
      .mockResolvedValue('{"at":"2026-09-27T12:00:00.000Z","pid":1}');
    Object.defineProperty(redis, 'status', { value: 'ready', writable: true });
  });

  afterEach(async () => {
    Object.defineProperty(redis, 'status', { value: 'end', writable: true });
    await service.onModuleDestroy();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should return ok status when database is connected', async () => {
    const result = await service.checkHealth();

    expect(result.database).toBe('connected');
    expect(result.redis).toBe('connected');
    expect(result.status).toBe('ok');
    expect(result.worker).toBe('up');
    expect(typeof result.uptime).toBe('number');
    expect(getSpy).toHaveBeenCalledWith('doc-test:worker:heartbeat');
  });

  it('should return degraded status when database is disconnected', async () => {
    jest.spyOn(prismaService, 'ping').mockResolvedValueOnce(false);

    const result = await service.checkHealth();

    expect(result.database).toBe('disconnected');
    expect(result.status).toBe('degraded');
  });

  it('sin latido del worker, /health sigue ok (el worker arranca tras la API)', async () => {
    getSpy.mockResolvedValue(null);

    const result = await service.checkHealth();

    expect(result.status).toBe('ok');
    expect(result.worker).toBe('down');
  });

  it('readiness: todo bien → ready y ok', async () => {
    const { ready, health } = await service.checkReadiness();

    expect(ready).toBe(true);
    expect(health).toMatchObject({
      status: 'ok',
      worker: 'up',
      storage: 'not_configured',
    });
  });

  it('readiness: sin worker sigue ready (200) pero degradada', async () => {
    getSpy.mockResolvedValue(null);

    const { ready, health } = await service.checkReadiness();

    expect(ready).toBe(true);
    expect(health.status).toBe('degraded');
    expect(health.worker).toBe('down');
  });

  it('readiness: si leer el latido falla, el worker cuenta como caído', async () => {
    getSpy.mockRejectedValue(new Error('NOAUTH'));

    const { ready, health } = await service.checkReadiness();

    expect(ready).toBe(true);
    expect(health.worker).toBe('down');
  });

  it('readiness: sin base de datos no está ready', async () => {
    jest.spyOn(prismaService, 'ping').mockResolvedValue(false);

    const { ready, health } = await service.checkReadiness();

    expect(ready).toBe(false);
    expect(health.status).toBe('degraded');
  });

  it('sin Redis no consulta el latido y el worker cuenta como caído', async () => {
    jest.spyOn(redis, 'ping').mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await service.checkHealth();

    expect(result.redis).toBe('disconnected');
    expect(result.worker).toBe('down');
    expect(getSpy).not.toHaveBeenCalled();
  });
});
