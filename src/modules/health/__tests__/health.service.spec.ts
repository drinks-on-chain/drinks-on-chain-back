import { Test, TestingModule } from '@nestjs/testing';
import { HealthService } from '../health.service';
import { PrismaService } from '@shared/prisma/prisma.service';
import { ConfigService } from '@nestjs/config';

describe('HealthService', () => {
  let service: HealthService;
  let prismaService: PrismaService;

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
            get: jest.fn().mockReturnValue('redis://localhost:6379'),
            getOrThrow: jest.fn().mockReturnValue('redis://localhost:6379'),
          },
        },
      ],
    }).compile();

    service = module.get<HealthService>(HealthService);
    prismaService = module.get<PrismaService>(PrismaService);
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should return ok status when database is connected', async () => {
    const redis = (
      service as unknown as {
        redisClient: {
          ping: () => Promise<string>;
          connect: () => Promise<void>;
          status: string;
        };
      }
    ).redisClient;
    jest.spyOn(redis, 'connect').mockResolvedValue();
    jest.spyOn(redis, 'ping').mockResolvedValue('PONG');
    Object.defineProperty(redis, 'status', { value: 'ready', writable: true });

    const result = await service.checkHealth();

    expect(result.database).toBe('connected');
    expect(result.redis).toBe('connected');
    expect(result.status).toBe('ok');
    expect(typeof result.uptime).toBe('number');
  });

  it('should return degraded status when database is disconnected', async () => {
    jest.spyOn(prismaService, 'ping').mockResolvedValueOnce(false);
    const redis = (
      service as unknown as {
        redisClient: {
          ping: () => Promise<string>;
          connect: () => Promise<void>;
          status: string;
        };
      }
    ).redisClient;
    jest.spyOn(redis, 'connect').mockResolvedValue();
    jest.spyOn(redis, 'ping').mockResolvedValue('PONG');
    Object.defineProperty(redis, 'status', { value: 'ready', writable: true });

    const result = await service.checkHealth();

    expect(result.database).toBe('disconnected');
    expect(result.status).toBe('degraded');
  });
});
