import type Redis from 'ioredis';

/** Espera máxima a que el cliente perezoso de Redis termine de conectar. */
const CONNECT_WAIT_MS = 1000;

/**
 * `true` si el cliente compartido de Redis (`REDIS_CLIENT`) está listo. Es
 * perezoso: quien llega primero lo conecta; si otro ya está conectando, se
 * espera un momento. Si no responde, quien llama sigue sin Redis (la caché
 * cae a la base y los contadores, a la memoria del proceso).
 */
export async function redisReady(redis: Redis): Promise<boolean> {
  if (redis.status === 'ready') return true;
  if (redis.status === 'wait') {
    await redis.connect().catch(() => undefined);
    return (redis.status as string) === 'ready';
  }
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      redis.off('ready', done);
      resolve();
    };
    const timer = setTimeout(done, CONNECT_WAIT_MS);
    redis.once('ready', done);
  });
  return (redis.status as string) === 'ready';
}
