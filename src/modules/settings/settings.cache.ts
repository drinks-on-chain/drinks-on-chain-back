import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import type { ResolvedSetting } from './settings.types';

/** Valores efectivos de un ámbito (una bodega o el estándar), por clave. */
export type ResolvedMap = Record<string, ResolvedSetting>;

export const SETTINGS_CACHE = Symbol('SETTINGS_CACHE');

/**
 * Caché de valores efectivos (CFG-05). Invalida por **generación**: cada
 * cambio incrementa un contador y las claves incluyen la generación vigente,
 * así que invalidar es O(1) y una lectura que calculó con datos viejos antes
 * del cambio escribe en una generación que ya nadie lee.
 */
export interface SettingsCache {
  /** Generación vigente, o `null` si la caché no está disponible. */
  generation(): Promise<string | null>;
  get(generation: string, scope: string): Promise<ResolvedMap | null>;
  set(generation: string, scope: string, value: ResolvedMap): Promise<void>;
  /** Invalida todo (nueva generación). */
  invalidate(): Promise<void>;
}

const PREFIX = 'doc:settings';
/** Vida de una entrada: acota el daño si una invalidación se pierde. */
export const SETTINGS_CACHE_TTL_SECONDS = 300;

/**
 * Caché en Redis. Si Redis no está disponible, `generation()` devuelve
 * `null` y el servicio lee de la base sin esperar (la API no se cae por la
 * caché).
 */
export class RedisSettingsCache implements SettingsCache {
  private readonly logger = new Logger('SettingsCache');
  private lastError = 0;

  constructor(private readonly redis: Redis) {}

  private ready(): boolean {
    if (this.redis.status === 'wait') {
      // Cliente perezoso: conecta en segundo plano; esta vez va a la base
      this.redis.connect().catch(() => undefined);
    }
    return this.redis.status === 'ready';
  }

  private warn(error: unknown): void {
    // Un aviso por minuto como mucho
    if (Date.now() - this.lastError > 60_000) {
      this.lastError = Date.now();
      this.logger.warn({
        message: 'Caché de configuración no disponible; se lee de la base',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async generation(): Promise<string | null> {
    if (!this.ready()) return null;
    try {
      return (await this.redis.get(`${PREFIX}:gen`)) ?? '0';
    } catch (error) {
      this.warn(error);
      return null;
    }
  }

  async get(generation: string, scope: string): Promise<ResolvedMap | null> {
    try {
      const raw = await this.redis.get(`${PREFIX}:${generation}:${scope}`);
      return raw ? (JSON.parse(raw) as ResolvedMap) : null;
    } catch (error) {
      this.warn(error);
      return null;
    }
  }

  async set(generation: string, scope: string, value: ResolvedMap) {
    try {
      await this.redis.set(
        `${PREFIX}:${generation}:${scope}`,
        JSON.stringify(value),
        'EX',
        SETTINGS_CACHE_TTL_SECONDS,
      );
    } catch (error) {
      this.warn(error);
    }
  }

  async invalidate(): Promise<void> {
    if (this.redis.status === 'wait') {
      await this.redis.connect().catch(() => undefined);
    }
    await this.redis.incr(`${PREFIX}:gen`);
  }
}

/** Misma semántica en memoria (pruebas). */
export class InMemorySettingsCache implements SettingsCache {
  private gen = 0;
  readonly entries = new Map<string, ResolvedMap>();
  available = true;

  generation(): Promise<string | null> {
    return Promise.resolve(this.available ? String(this.gen) : null);
  }

  get(generation: string, scope: string): Promise<ResolvedMap | null> {
    return Promise.resolve(this.entries.get(`${generation}:${scope}`) ?? null);
  }

  set(generation: string, scope: string, value: ResolvedMap): Promise<void> {
    this.entries.set(`${generation}:${scope}`, value);
    return Promise.resolve();
  }

  invalidate(): Promise<void> {
    this.gen += 1;
    return Promise.resolve();
  }
}
