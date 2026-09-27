import type { ConnectionOptions } from 'bullmq';

/**
 * Opciones de conexión de BullMQ a partir de `REDIS_URL`
 * (`redis://[:clave@]host:puerto[/db]` o `rediss://` con TLS).
 *
 * `maxRetriesPerRequest: null` es obligatorio para los `Worker` de BullMQ
 * (bloquean en Redis y no deben fallar por número de reintentos).
 */
export function buildRedisConnection(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error('REDIS_URL debe usar redis:// o rediss://');
  }
  const db = url.pathname && url.pathname !== '/' ? url.pathname.slice(1) : '';
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: db ? Number(db) : 0,
    tls: url.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}
