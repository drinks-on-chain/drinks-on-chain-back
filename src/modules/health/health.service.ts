import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '@shared/prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { HealthStatusDataDto } from './dto/health-response.dto';

@Injectable()
export class HealthService implements OnModuleDestroy {
  private readonly logger = new Logger(HealthService.name);
  private readonly redisClient: Redis;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    const redisUrl =
      this.configService.get<string>('REDIS_URL') || 'redis://localhost:6379';
    this.redisClient = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
    });
  }

  async checkHealth(): Promise<HealthStatusDataDto> {
    const isDbConnected = await this.prisma.ping();
    let isRedisConnected = false;

    try {
      if (this.redisClient.status !== 'ready') {
        await this.redisClient.connect();
      }
      const pong = await this.redisClient.ping();
      isRedisConnected = pong === 'PONG';
    } catch (error) {
      this.logger.warn(
        `Redis health check ping failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      isRedisConnected = false;
    }

    return {
      status: isDbConnected && isRedisConnected ? 'ok' : 'degraded',
      database: isDbConnected ? 'connected' : 'disconnected',
      redis: isRedisConnected ? 'connected' : 'disconnected',
      uptime: process.uptime(),
    };
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
