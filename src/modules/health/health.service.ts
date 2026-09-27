import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '@shared/prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import {
  HealthStatusDataDto,
  LivenessDataDto,
} from './dto/health-response.dto';
import {
  ObjectStorage,
  STORAGE_SERVICE,
} from '@shared/storage/storage.interface';

@Injectable()
export class HealthService implements OnModuleDestroy {
  private readonly logger = new Logger(HealthService.name);
  private readonly redisClient: Redis;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    @Optional()
    @Inject(STORAGE_SERVICE)
    private readonly storage?: ObjectStorage,
  ) {
    const redisUrl =
      this.configService.get<string>('REDIS_URL') || 'redis://localhost:6379';
    this.redisClient = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
    });
  }

  /**
   * Estado de las dependencias. `status` depende de la base y Redis (como
   * hasta ahora: lo usa el healthcheck del contenedor); el almacenamiento se
   * informa aparte y cuenta en la readiness.
   */
  async checkHealth(): Promise<HealthStatusDataDto> {
    const [isDbConnected, isRedisConnected, storage] = await Promise.all([
      this.prisma.ping(),
      this.pingRedis(),
      this.pingStorage(),
    ]);

    return {
      status: isDbConnected && isRedisConnected ? 'ok' : 'degraded',
      database: isDbConnected ? 'connected' : 'disconnected',
      redis: isRedisConnected ? 'connected' : 'disconnected',
      storage,
      uptime: process.uptime(),
    };
  }

  /** Readiness: base, Redis y almacenamiento disponibles. */
  async checkReadiness(): Promise<{
    ready: boolean;
    health: HealthStatusDataDto;
  }> {
    const health = await this.checkHealth();
    const ready =
      health.status === 'ok' &&
      (health.storage === 'connected' || health.storage === 'not_configured');
    return { ready, health: { ...health, status: ready ? 'ok' : 'degraded' } };
  }

  /** Liveness: el proceso responde (sin mirar dependencias). */
  liveness(): LivenessDataDto {
    return {
      status: 'ok',
      uptime: process.uptime(),
      release: process.env.RELEASE_SHA ?? null,
    };
  }

  private async pingRedis(): Promise<boolean> {
    try {
      if (this.redisClient.status !== 'ready') {
        await this.redisClient.connect();
      }
      const pong = await this.redisClient.ping();
      return pong === 'PONG';
    } catch (error) {
      this.logger.warn(
        `Redis health check ping failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  private async pingStorage(): Promise<HealthStatusDataDto['storage']> {
    if (!this.storage) return 'not_configured';
    try {
      return (await this.storage.ping()) ? 'connected' : 'disconnected';
    } catch {
      return 'disconnected';
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      if (this.redisClient.status === 'ready') {
        await this.redisClient.quit();
      }
    } catch {
      this.redisClient.disconnect();
    }
  }
}
