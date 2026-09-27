import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { SESSION_REDIS, SessionKeys } from './session-redis';
import { SESSION_SETTINGS, SessionSettings } from './session.config';

/** Espera máxima a Redis en el camino de cada petición. */
const REDIS_TIMEOUT_MS = 500;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Redis no respondió en ${ms} ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Lista de revocación por `sid` en Redis (IAM-13, contrato O0 §5) y caché del
 * periodo de gracia de la renovación.
 *
 * Cada entrada vive lo que un token de acceso (más un margen): pasado ese
 * tiempo ningún acceso de la sesión sigue vigente y basta con la marca de la
 * base (`sessions.revoked_at`), que el guard también consulta. Si Redis falla
 * no se lanza nada: la base sigue siendo la fuente de verdad.
 */
@Injectable()
export class SessionRevocationStore {
  private readonly logger = new Logger(SessionRevocationStore.name);

  constructor(
    @Inject(SESSION_REDIS) private readonly redis: Redis,
    @Inject(SESSION_SETTINGS) private readonly settings: SessionSettings,
  ) {}

  private get revocationTtlSeconds(): number {
    return this.settings.accessTokenTtlSeconds + 60;
  }

  async markRevoked(sessionIds: readonly string[], reason: string) {
    if (sessionIds.length === 0) {
      return;
    }
    try {
      const pipeline = this.redis.pipeline();
      for (const id of sessionIds) {
        pipeline.set(
          SessionKeys.revoked(id),
          reason,
          'EX',
          this.revocationTtlSeconds,
        );
      }
      await withTimeout(pipeline.exec(), REDIS_TIMEOUT_MS * 4);
    } catch (error) {
      this.logger.warn(
        `No se pudo anotar la revocación en Redis (${sessionIds.length} sesiones): ${(error as Error).message}`,
      );
    }
  }

  /** `true`/`false`, o `null` si Redis no respondió (se decide con la base). */
  async isRevoked(sessionId: string): Promise<boolean | null> {
    try {
      const exists = await withTimeout(
        this.redis.exists(SessionKeys.revoked(sessionId)),
        REDIS_TIMEOUT_MS,
      );
      return exists === 1;
    } catch (error) {
      this.logger.warn(
        `Lista de revocación no disponible: ${(error as Error).message}`,
      );
      return null;
    }
  }

  /** Acceso emitido en la rotación a la generación `generation`. */
  async saveGraceAccess(
    sessionId: string,
    generation: number,
    accessToken: string,
  ): Promise<void> {
    try {
      await withTimeout(
        this.redis.set(
          SessionKeys.grace(sessionId, generation),
          accessToken,
          'EX',
          Math.ceil(this.settings.refreshGraceSeconds),
        ),
        REDIS_TIMEOUT_MS,
      );
    } catch (error) {
      this.logger.warn(
        `No se pudo guardar el acceso del periodo de gracia: ${(error as Error).message}`,
      );
    }
  }

  async readGraceAccess(
    sessionId: string,
    generation: number,
  ): Promise<string | null> {
    try {
      return await withTimeout(
        this.redis.get(SessionKeys.grace(sessionId, generation)),
        REDIS_TIMEOUT_MS,
      );
    } catch {
      return null;
    }
  }
}
