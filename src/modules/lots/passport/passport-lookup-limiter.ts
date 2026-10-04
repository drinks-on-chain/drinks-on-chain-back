import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { RetryAfterException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';
import { REDIS_CLIENT } from '@shared/redis/redis.module';
import { redisReady } from '@shared/redis/redis-ready';

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Freno a la enumeración de códigos (S-24): 20 inexistentes en 10 min por IP. */
export function passportLookupLimits(
  env: Record<string, string | undefined> = process.env,
): { maxMisses: number; windowSeconds: number } {
  return {
    maxMisses: positiveInt(env.PASSPORT_MISS_LIMIT, 20),
    windowSeconds: positiveInt(env.PASSPORT_MISS_WINDOW_SECONDS, 600),
  };
}

const missKey = (ip: string) => `passport:miss:${ip}`;

/**
 * Cuenta los códigos inexistentes que consulta cada IP real (contrato O2
 * §12.4, PUB-05): por encima del límite, las consultas del pasaporte de esa
 * IP responden 429 `PUB_TOO_MANY_LOOKUPS` con `Retry-After` hasta que acaba la
 * ventana (fija, desde el primer fallo). Los contadores viven en Redis; si no
 * responde, en la memoria del proceso (nunca se deja de contar).
 */
@Injectable()
export class PassportLookupLimiter {
  private readonly logger = new Logger(PassportLookupLimiter.name);
  private readonly local = new Map<
    string,
    { count: number; resetAt: number }
  >();
  private lastWarning = 0;

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** 429 si la IP ya superó el límite de códigos inexistentes. */
  async assertAllowed(ip: string | null | undefined): Promise<void> {
    if (!ip) return;
    const { maxMisses } = passportLookupLimits();
    const state = await this.read(ip);
    if (state.count > maxMisses) throw this.blocked(state.retryAfter);
  }

  /** Anota un código inexistente; 429 si con este se supera el límite. */
  async registerMiss(ip: string | null | undefined): Promise<void> {
    if (!ip) return;
    const { maxMisses } = passportLookupLimits();
    const state = await this.increment(ip);
    if (state.count > maxMisses) throw this.blocked(state.retryAfter);
  }

  private blocked(retryAfter: number): RetryAfterException {
    return new RetryAfterException(
      ErrorCode.PUB_TOO_MANY_LOOKUPS,
      'Demasiados códigos que no existen desde esta red: vuelve a intentarlo más tarde',
      Math.max(1, retryAfter),
    );
  }

  private async read(
    ip: string,
  ): Promise<{ count: number; retryAfter: number }> {
    try {
      if (await redisReady(this.redis)) {
        const [count, ttl] = await Promise.all([
          this.redis.get(missKey(ip)),
          this.redis.ttl(missKey(ip)),
        ]);
        return { count: Number(count ?? 0), retryAfter: ttl > 0 ? ttl : 0 };
      }
    } catch (error) {
      this.warn(error);
    }
    return this.readLocal(ip);
  }

  private async increment(
    ip: string,
  ): Promise<{ count: number; retryAfter: number }> {
    const { windowSeconds } = passportLookupLimits();
    try {
      if (await redisReady(this.redis)) {
        const key = missKey(ip);
        const count = await this.redis.incr(key);
        if (count === 1) await this.redis.expire(key, windowSeconds);
        let ttl = await this.redis.ttl(key);
        if (ttl <= 0) {
          // Clave sin caducidad (corte entre INCR y EXPIRE): se le vuelve a poner
          await this.redis.expire(key, windowSeconds);
          ttl = windowSeconds;
        }
        return { count, retryAfter: ttl };
      }
    } catch (error) {
      this.warn(error);
    }
    const now = Date.now();
    const current = this.local.get(ip);
    const entry =
      current && current.resetAt > now
        ? current
        : { count: 0, resetAt: now + windowSeconds * 1000 };
    entry.count++;
    this.local.set(ip, entry);
    if (this.local.size > 10_000) this.prune(now);
    return {
      count: entry.count,
      retryAfter: Math.ceil((entry.resetAt - now) / 1000),
    };
  }

  private readLocal(ip: string): { count: number; retryAfter: number } {
    const now = Date.now();
    const entry = this.local.get(ip);
    if (!entry || entry.resetAt <= now) return { count: 0, retryAfter: 0 };
    return {
      count: entry.count,
      retryAfter: Math.ceil((entry.resetAt - now) / 1000),
    };
  }

  private prune(now: number): void {
    for (const [ip, entry] of this.local) {
      if (entry.resetAt <= now) this.local.delete(ip);
    }
  }

  private warn(error: unknown): void {
    // Un aviso por minuto como mucho
    if (Date.now() - this.lastWarning > 60_000) {
      this.lastWarning = Date.now();
      this.logger.warn(
        `Redis no disponible para el freno del pasaporte (se cuenta en memoria): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
