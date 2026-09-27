import { Logger, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/** Cliente Redis de las sesiones: revocación, gracia y bloqueo por intentos. */
export const SESSION_REDIS = Symbol('SESSION_REDIS');

/**
 * Conexión perezosa (no se abre hasta el primer uso) y sin colas de
 * reintentos largas: si Redis no responde, quien llama decide (la revocación
 * se comprueba también en la base; el bloqueo por intentos deja pasar).
 */
export const sessionRedisProvider: Provider = {
  provide: SESSION_REDIS,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Redis => {
    const logger = new Logger('SessionRedis');
    const client = new Redis(
      config.get<string>('REDIS_URL') ?? 'redis://localhost:6379',
      {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        connectTimeout: 5000,
        enableOfflineQueue: true,
        retryStrategy: (times) => Math.min(times * 200, 5000),
      },
    );
    let lastError = '';
    client.on('error', (error: Error) => {
      if (error.message !== lastError) {
        lastError = error.message;
        logger.warn(`Redis de sesiones: ${error.message}`);
      }
    });
    client.on('ready', () => {
      lastError = '';
    });
    return client;
  },
};

/** Claves de Redis de las sesiones (un solo sitio para no repetirlas). */
export const SessionKeys = {
  revoked: (sessionId: string) => `auth:revoked:${sessionId}`,
  grace: (sessionId: string, generation: number) =>
    `auth:grace:${sessionId}:${generation}`,
  failures: (scope: 'email' | 'ip', id: string) => `auth:fail:${scope}:${id}`,
  lock: (scope: 'email' | 'ip', id: string) => `auth:lock:${scope}:${id}`,
} as const;
