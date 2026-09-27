import {
  Global,
  Inject,
  Logger,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import {
  IDEMPOTENCY_REDIS,
  IDEMPOTENCY_STORE,
  RedisIdempotencyStore,
} from './idempotency.store';

/**
 * Almacén de `Idempotency-Key` en Redis. La conexión es perezosa: no se abre
 * hasta la primera petición con la cabecera.
 */
@Global()
@Module({
  providers: [
    {
      provide: IDEMPOTENCY_REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Redis => {
        const logger = new Logger('IdempotencyRedis');
        const client = new Redis(
          config.get<string>('REDIS_URL') ?? 'redis://localhost:6379',
          {
            lazyConnect: true,
            maxRetriesPerRequest: 1,
            connectTimeout: 5000,
            retryStrategy: (times) => Math.min(times * 200, 5000),
          },
        );
        let lastError = '';
        client.on('error', (error: Error) => {
          if (error.message !== lastError) {
            lastError = error.message;
            logger.warn(`Redis de idempotencia: ${error.message}`);
          }
        });
        client.on('ready', () => {
          lastError = '';
        });
        return client;
      },
    },
    {
      provide: IDEMPOTENCY_STORE,
      inject: [IDEMPOTENCY_REDIS],
      useFactory: (redis: Redis) => new RedisIdempotencyStore(redis),
    },
    IdempotencyInterceptor,
  ],
  exports: [IDEMPOTENCY_STORE, IdempotencyInterceptor],
})
export class IdempotencyModule implements OnApplicationShutdown {
  constructor(@Inject(IDEMPOTENCY_REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status === 'ready') {
      await this.redis.quit();
    } else {
      this.redis.disconnect();
    }
  }
}
