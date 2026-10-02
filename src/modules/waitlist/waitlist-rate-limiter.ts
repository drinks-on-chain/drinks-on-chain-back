import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '@shared/redis/redis.module';
import { RetryAfterException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';
import { waitlistConfig } from './waitlist.config';

const HOUR_SECONDS = 3600;
/** Espera máxima a que el cliente perezoso de Redis termine de conectar. */
const CONNECT_WAIT_MS = 1000;

export const WaitlistKeys = {
  ipHour: (ip: string) => `waitlist:ip:h:${ip}`,
  emailHour: (email: string) =>
    `waitlist:email:h:${createHash('sha256').update(email).digest('hex')}`,
} as const;

/**
 * Límites por hora de la lista de espera (contrato O1b §1), en Redis: por IP
 * real y por correo (guardado como hash: sin datos personales en Redis).
 * Ventana fija de una hora desde la primera inscripción. Excedido → 429
 * `TOO_MANY_REQUESTS` con `Retry-After`. El límite por minuto e IP es el del
 * `ThrottlerGuard` (`@Throttle` en la ruta). Si Redis no responde, no se
 * bloquea a nadie (siguen el límite por minuto y el global).
 */
@Injectable()
export class WaitlistRateLimiter {
  private readonly logger = new Logger(WaitlistRateLimiter.name);
  private lastWarning = 0;

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** Cuenta la petición de esta IP; lanza 429 por encima del límite por hora. */
  async checkIp(ip: string | null): Promise<void> {
    if (!ip) return;
    const retryAfter = await this.hit(
      WaitlistKeys.ipHour(ip),
      waitlistConfig().ipPerHour,
    );
    if (retryAfter > 0) {
      throw new RetryAfterException(
        ErrorCode.TOO_MANY_REQUESTS,
        'Hay demasiadas inscripciones desde esta red: vuelve a intentarlo más tarde',
        retryAfter,
      );
    }
  }

  /** Cuenta la inscripción de este correo; lanza 429 por encima del límite. */
  async checkEmail(email: string): Promise<void> {
    const retryAfter = await this.hit(
      WaitlistKeys.emailHour(email),
      waitlistConfig().emailPerHour,
    );
    if (retryAfter > 0) {
      throw new RetryAfterException(
        ErrorCode.TOO_MANY_REQUESTS,
        'Ya recibimos varias inscripciones con este correo: vuelve a intentarlo más tarde',
        retryAfter,
      );
    }
  }

  /** Segundos que faltan para poder reintentar (0 = dentro del límite). */
  private async hit(key: string, limit: number): Promise<number> {
    try {
      if (!(await this.ready())) {
        this.warn('Redis no está conectado');
        return 0;
      }
      const count = await this.redis.incr(key);
      if (count === 1) {
        await this.redis.expire(key, HOUR_SECONDS);
      }
      if (count <= limit) return 0;
      const ttl = await this.redis.ttl(key);
      if (ttl > 0) return ttl;
      // Clave sin caducidad (corte entre INCR y EXPIRE): se le vuelve a poner
      await this.redis.expire(key, HOUR_SECONDS);
      return HOUR_SECONDS;
    } catch (error) {
      this.warn(error instanceof Error ? error.message : String(error));
      return 0;
    }
  }

  private isReady(): boolean {
    return this.redis.status === 'ready';
  }

  private async ready(): Promise<boolean> {
    if (this.isReady()) return true;
    if (this.redis.status === 'wait') {
      // Cliente perezoso: aún nadie lo ha conectado
      await this.redis.connect().catch(() => undefined);
      return this.isReady();
    }
    // Otro ya está conectando: se espera un momento a que termine
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.redis.off('ready', done);
        resolve();
      };
      const timer = setTimeout(done, CONNECT_WAIT_MS);
      this.redis.once('ready', done);
    });
    return this.isReady();
  }

  private warn(reason: string): void {
    // Un aviso por minuto como mucho
    if (Date.now() - this.lastWarning > 60_000) {
      this.lastWarning = Date.now();
      this.logger.warn(
        `Límites por hora de la lista de espera no disponibles: ${reason}`,
      );
    }
  }
}
