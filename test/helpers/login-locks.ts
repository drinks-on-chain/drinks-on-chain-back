import { INestApplication } from '@nestjs/common';
import type Redis from 'ioredis';
import {
  SESSION_REDIS,
  SessionKeys,
} from '../../src/modules/auth/sessions/session-redis';

/** Formas en las que la API ve la IP local cuando la prueba no envía otra. */
const LOOPBACK_IPS = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

/**
 * Borra los fallos de inicio de sesión y el bloqueo de la IP local en Redis
 * (IAM-07). Las suites que entran sin `X-Forwarded-For` comparten esa IP, y
 * los fallos que provocan a propósito se acumulan una hora: al repetir la
 * e2e sobre el mismo Redis (en local) superaban el umbral por IP y los
 * siguientes inicios de sesión respondían 429 `AUTH_TOO_MANY_ATTEMPTS`. En la
 * CI Redis nace vacío. Las pruebas del bloqueo usan sus propias IP y correos.
 */
export async function resetLoopbackLoginLocks(
  app: INestApplication,
): Promise<void> {
  const redis = app.get<Redis>(SESSION_REDIS);
  await redis.del(
    ...LOOPBACK_IPS.flatMap((ip) => [
      SessionKeys.failures('ip', ip),
      SessionKeys.lock('ip', ip),
    ]),
  );
}
