import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { DEFAULT_QUEUE_PREFIX } from '@shared/queue/queue.constants';
import { REDIS_CLIENT } from '@shared/redis/redis.module';
import { redisReady } from '@shared/redis/redis-ready';
import { CHAIN_SETTINGS, type ChainSettings } from '../chain.config';

export type PlatformAccountRole = 'OPERATIONS' | 'ANCHOR';

/** Última lectura del saldo de una cuenta de la plataforma en la red. */
export interface BalanceSnapshot {
  address: string;
  /** Stroops; `null` = la cuenta no existe en la red. */
  balanceStroops: string | null;
  checkedAt: string;
}

/** Tres lecturas perdidas de `chain.balance.check` (15 min) y deja de valer. */
const SNAPSHOT_TTL_SECONDS = 60 * 60;

/**
 * Saldos de las cuentas de la plataforma leídos por el worker
 * (`chain.balance.check`) para la API: ninguna ruta espera a la red (contrato
 * O3 §0). Es estado de la red, no del negocio: vive en Redis con caducidad, y
 * si falta, la cuenta se muestra sin lectura (`checkedAt: null`).
 */
@Injectable()
export class ChainBalanceCache {
  private readonly logger = new Logger(ChainBalanceCache.name);
  private readonly prefix: string;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(CHAIN_SETTINGS) private readonly settings: ChainSettings,
    config: ConfigService,
  ) {
    this.prefix = config.get<string>('QUEUE_PREFIX') ?? DEFAULT_QUEUE_PREFIX;
  }

  private key(role: PlatformAccountRole): string {
    return `${this.prefix}:chain:balance:${this.settings.network}:${role}`;
  }

  async write(
    role: PlatformAccountRole,
    snapshot: BalanceSnapshot,
  ): Promise<void> {
    try {
      if (!(await redisReady(this.redis))) return;
      await this.redis.set(
        this.key(role),
        JSON.stringify(snapshot),
        'EX',
        SNAPSHOT_TTL_SECONDS,
      );
    } catch (error) {
      this.logger.warn(
        `No se pudo guardar el saldo de ${role}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async read(role: PlatformAccountRole): Promise<BalanceSnapshot | null> {
    try {
      if (!(await redisReady(this.redis))) return null;
      const raw = await this.redis.get(this.key(role));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<BalanceSnapshot>;
      return typeof parsed.address === 'string' &&
        typeof parsed.checkedAt === 'string'
        ? {
            address: parsed.address,
            balanceStroops:
              typeof parsed.balanceStroops === 'string'
                ? parsed.balanceStroops
                : null,
            checkedAt: parsed.checkedAt,
          }
        : null;
    } catch {
      return null;
    }
  }
}
