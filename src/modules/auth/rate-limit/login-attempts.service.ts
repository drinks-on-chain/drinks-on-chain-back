import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import type Redis from 'ioredis';
import { SESSION_REDIS, SessionKeys } from '../sessions/session-redis';

export interface LoginAttemptPolicy {
  /** Fallos por correo antes del primer bloqueo. */
  emailThreshold: number;
  /** Fallos por IP antes del primer bloqueo. */
  ipThreshold: number;
  /** Primer bloqueo (s); se duplica con cada fallo por encima del umbral. */
  baseLockSeconds: number;
  /** Bloqueo máximo (s). */
  maxLockSeconds: number;
  /** Ventana en la que se acumulan los fallos (s). */
  windowSeconds: number;
}

export const DEFAULT_LOGIN_ATTEMPT_POLICY: LoginAttemptPolicy = {
  emailThreshold: 5,
  ipThreshold: 20,
  baseLockSeconds: 60,
  maxLockSeconds: 3600,
  windowSeconds: 3600,
};

/** Segundos de bloqueo tras `failures` fallos con un umbral dado (0 = sin bloqueo). */
export function lockSecondsFor(
  failures: number,
  threshold: number,
  policy: Pick<LoginAttemptPolicy, 'baseLockSeconds' | 'maxLockSeconds'>,
): number {
  if (failures < threshold) {
    return 0;
  }
  const exponent = Math.min(failures - threshold, 16);
  return Math.min(
    policy.baseLockSeconds * 2 ** exponent,
    policy.maxLockSeconds,
  );
}

function emailKey(email: string): string {
  return createHash('sha256').update(email.toLowerCase().trim()).digest('hex');
}

function positiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Bloqueo progresivo del inicio de sesión (IAM-07): por correo y por IP real,
 * en Redis. Mientras hay bloqueo, el login responde 429
 * `AUTH_TOO_MANY_ATTEMPTS` con `Retry-After` sin comprobar la contraseña. El
 * correo se guarda como hash (sin datos personales en Redis). Si Redis no
 * responde, no bloquea (el límite de peticiones por IP sigue activo).
 */
@Injectable()
export class LoginAttemptsService {
  private readonly logger = new Logger(LoginAttemptsService.name);
  readonly policy: LoginAttemptPolicy;

  constructor(
    @Inject(SESSION_REDIS) private readonly redis: Redis,
    config: ConfigService,
  ) {
    this.policy = {
      ...DEFAULT_LOGIN_ATTEMPT_POLICY,
      emailThreshold: positiveInt(
        config.get('LOGIN_LOCK_EMAIL_THRESHOLD'),
        DEFAULT_LOGIN_ATTEMPT_POLICY.emailThreshold,
      ),
      ipThreshold: positiveInt(
        config.get('LOGIN_LOCK_IP_THRESHOLD'),
        DEFAULT_LOGIN_ATTEMPT_POLICY.ipThreshold,
      ),
    };
  }

  /** Segundos que quedan de bloqueo (0 = puede intentarlo). */
  async lockedFor(email: string, ip: string | null): Promise<number> {
    try {
      const keys = [SessionKeys.lock('email', emailKey(email))];
      if (ip) {
        keys.push(SessionKeys.lock('ip', ip));
      }
      const ttls = await Promise.all(keys.map((k) => this.redis.pttl(k)));
      const maxMs = Math.max(0, ...ttls);
      return maxMs > 0 ? Math.ceil(maxMs / 1000) : 0;
    } catch (error) {
      this.logger.warn(
        `Bloqueo por intentos no disponible: ${(error as Error).message}`,
      );
      return 0;
    }
  }

  /** Anota un fallo; devuelve los segundos de bloqueo que empiezan (0 si ninguno). */
  async recordFailure(email: string, ip: string | null): Promise<number> {
    try {
      const scopes: Array<{
        scope: 'email' | 'ip';
        id: string;
        threshold: number;
      }> = [
        {
          scope: 'email',
          id: emailKey(email),
          threshold: this.policy.emailThreshold,
        },
      ];
      if (ip) {
        scopes.push({
          scope: 'ip',
          id: ip,
          threshold: this.policy.ipThreshold,
        });
      }
      let lock = 0;
      for (const { scope, id, threshold } of scopes) {
        const key = SessionKeys.failures(scope, id);
        const results = await this.redis
          .multi()
          .incr(key)
          .expire(key, this.policy.windowSeconds)
          .exec();
        const failures = Number(results?.[0]?.[1] ?? 0);
        const seconds = lockSecondsFor(failures, threshold, this.policy);
        if (seconds > 0) {
          await this.redis.set(SessionKeys.lock(scope, id), '1', 'EX', seconds);
          lock = Math.max(lock, seconds);
          this.logger.warn(
            `Inicio de sesión bloqueado ${seconds} s por ${failures} fallos (${scope})`,
          );
        }
      }
      return lock;
    } catch (error) {
      this.logger.warn(
        `No se pudo anotar el intento fallido: ${(error as Error).message}`,
      );
      return 0;
    }
  }

  /** Inicio de sesión correcto: se olvidan los fallos del correo. */
  async recordSuccess(email: string): Promise<void> {
    try {
      const id = emailKey(email);
      await this.redis.del(
        SessionKeys.failures('email', id),
        SessionKeys.lock('email', id),
      );
    } catch {
      // Sin Redis no hay contador que limpiar
    }
  }
}
