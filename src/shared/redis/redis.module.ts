import {
  Global,
  Inject,
  Logger,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/** Cliente Redis compartido (caché de configuración y usos futuros). */
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

/**
 * Crea un cliente perezoso: no conecta hasta que se llama a `connect()`,
 * falla rápido sin conexión y reconecta solo. Quien lo use debe tolerar que
 * Redis no esté disponible (p. ej. la caché cae a la base de datos).
 */
export function createRedisClient(url: string, name: string): Redis {
  const logger = new Logger(name);
  const client = new Redis(url, {
    lazyConnect: true,
    // Sin cola sin conexión: si Redis no está, el comando falla al momento
    // y quien lo usa cae a la base (no espera al timeout de conexión)
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 5000,
    retryStrategy: (times) => Math.min(times * 200, 5000),
  });
  let lastError = '';
  client.on('error', (error: Error) => {
    if (error.message !== lastError) {
      lastError = error.message;
      logger.warn(`Redis: ${error.message}`);
    }
  });
  client.on('ready', () => {
    lastError = '';
  });
  return client;
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Redis =>
        createRedisClient(
          config.get<string>('REDIS_URL') ?? 'redis://localhost:6379',
          'Redis',
        ),
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status === 'ready') {
      await this.redis.quit();
    } else {
      this.redis.disconnect();
    }
  }
}
