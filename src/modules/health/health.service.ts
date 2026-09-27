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
import {
  DEFAULT_QUEUE_PREFIX,
  workerHeartbeatKey,
} from '@shared/queue/queue.constants';

@Injectable()
export class HealthService implements OnModuleDestroy {
  private readonly logger = new Logger(HealthService.name);
  private readonly redisClient: Redis;
  private readonly heartbeatKey: string;

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
    this.heartbeatKey = workerHeartbeatKey(
      this.configService.get<string>('QUEUE_PREFIX') || DEFAULT_QUEUE_PREFIX,
    );
  }

  /**
   * Estado de las dependencias. `status` depende de la base y Redis (como
   * hasta ahora: lo usa el healthcheck del contenedor, y el worker arranca
   * cuando la API está sana, así que el worker no cuenta aquí); el
   * almacenamiento y el worker se informan aparte.
   */
  async checkHealth(): Promise<HealthStatusDataDto> {
    const [isDbConnected, isRedisConnected, storage] = await Promise.all([
      this.prisma.ping(),
      this.pingRedis(),
      this.pingStorage(),
    ]);
    const worker = isRedisConnected ? await this.workerStatus() : 'down';

    return {
      status: isDbConnected && isRedisConnected ? 'ok' : 'degraded',
      database: isDbConnected ? 'connected' : 'disconnected',
      redis: isRedisConnected ? 'connected' : 'disconnected',
      storage,
      worker,
      uptime: process.uptime(),
    };
  }

  /**
   * Readiness: base, Redis y almacenamiento disponibles (si no, 503). El
   * worker no la hace fallar (la API atiende sin él), pero sin su latido el
   * estado es `degraded`.
   */
  async checkReadiness(): Promise<{
    ready: boolean;
    health: HealthStatusDataDto;
  }> {
    const health = await this.checkHealth();
    const ready =
      health.status === 'ok' &&
      (health.storage === 'connected' || health.storage === 'not_configured');
    const status = ready && health.worker === 'up' ? 'ok' : 'degraded';
    return { ready, health: { ...health, status } };
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

  /** `up` si el worker escribió su latido en Redis y no ha caducado. */
  private async workerStatus(): Promise<HealthStatusDataDto['worker']> {
    try {
      const beat = await this.redisClient.get(this.heartbeatKey);
      return beat ? 'up' : 'down';
    } catch {
      return 'down';
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
