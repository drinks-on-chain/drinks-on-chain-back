import { createHash } from 'crypto';
import type Redis from 'ioredis';

/** Token de inyección del almacén de idempotencia. */
export const IDEMPOTENCY_STORE = Symbol('IDEMPOTENCY_STORE');
/** Token de inyección del cliente Redis del almacén. */
export const IDEMPOTENCY_REDIS = Symbol('IDEMPOTENCY_REDIS');

/** Vida de una respuesta guardada (contrato O0 §3: 24 h). */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
/**
 * Vida de la reserva mientras la petición se procesa. Si el proceso muere a
 * mitad, la clave se libera sola pasado este tiempo.
 */
export const IDEMPOTENCY_LOCK_TTL_SECONDS = 120;

export interface InProgressRecord {
  state: 'in_progress';
  fingerprint: string;
  lockToken: string;
  startedAt: string;
}

export interface CompletedRecord {
  state: 'completed';
  fingerprint: string;
  statusCode: number;
  body: unknown;
  completedAt: string;
}

export type IdempotencyRecord = InProgressRecord | CompletedRecord;

export type AcquireResult =
  { acquired: true } | { acquired: false; record: IdempotencyRecord };

/** Almacén de claves de idempotencia (Redis en la app; en memoria en pruebas). */
export interface IdempotencyStore {
  /**
   * Reserva `key` de forma atómica. Si ya existe (en curso o completada),
   * no la toca y devuelve el registro existente.
   */
  acquire(
    key: string,
    fingerprint: string,
    lockToken: string,
    lockTtlSeconds: number,
  ): Promise<AcquireResult>;
  /** Guarda la respuesta de una petición terminada. */
  complete(
    key: string,
    record: CompletedRecord,
    ttlSeconds: number,
  ): Promise<void>;
  /** Libera la reserva si sigue siendo la de `lockToken` (la petición falló). */
  release(key: string, lockToken: string): Promise<void>;
}

/**
 * Clave de almacenamiento: persona + método y ruta + clave del cliente
 * (contrato O0 §3). La misma `Idempotency-Key` en otra ruta o de otra persona
 * es otra operación.
 */
export function buildIdempotencyStorageKey(parts: {
  userId: string | null | undefined;
  method: string;
  path: string;
  key: string;
}): string {
  const route = `${parts.method.toUpperCase()} ${parts.path}`;
  return [
    'idem',
    'v1',
    parts.userId ?? 'anonymous',
    createHash('sha256').update(route).digest('hex').slice(0, 32),
    parts.key.toLowerCase(),
  ].join(':');
}

/** Huella del cuerpo: SHA-256 de su JSON canónico (claves ordenadas). */
export function fingerprintBody(body: unknown): string {
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === undefined) {
    return 'null';
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

// Borra la clave solo si la reserva sigue siendo la nuestra.
const RELEASE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current then
  local ok, record = pcall(cjson.decode, current)
  if ok and record['state'] == 'in_progress' and record['lockToken'] == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
end
return 0
`;

export class RedisIdempotencyStore implements IdempotencyStore {
  constructor(private readonly redis: Redis) {}

  async acquire(
    key: string,
    fingerprint: string,
    lockToken: string,
    lockTtlSeconds: number,
  ): Promise<AcquireResult> {
    const record: InProgressRecord = {
      state: 'in_progress',
      fingerprint,
      lockToken,
      startedAt: new Date().toISOString(),
    };
    // Dos intentos: la clave existente puede caducar entre el SET y el GET.
    for (let attempt = 0; attempt < 2; attempt++) {
      const created = await this.redis.set(
        key,
        JSON.stringify(record),
        'EX',
        lockTtlSeconds,
        'NX',
      );
      if (created === 'OK') {
        return { acquired: true };
      }
      const existing = await this.redis.get(key);
      if (existing !== null) {
        return {
          acquired: false,
          record: JSON.parse(existing) as IdempotencyRecord,
        };
      }
    }
    throw new Error(`No se pudo reservar la clave de idempotencia ${key}`);
  }

  async complete(
    key: string,
    record: CompletedRecord,
    ttlSeconds: number,
  ): Promise<void> {
    await this.redis.set(key, JSON.stringify(record), 'EX', ttlSeconds);
  }

  async release(key: string, lockToken: string): Promise<void> {
    await this.redis.eval(RELEASE_SCRIPT, 1, key, lockToken);
  }
}

/** Almacén en memoria con la misma semántica (pruebas y documento OpenAPI). */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<
    string,
    { record: IdempotencyRecord; expiresAt: number }
  >();

  constructor(private readonly now: () => number = () => Date.now()) {}

  acquire(
    key: string,
    fingerprint: string,
    lockToken: string,
    lockTtlSeconds: number,
  ): Promise<AcquireResult> {
    const existing = this.read(key);
    if (existing) {
      return Promise.resolve({ acquired: false, record: existing });
    }
    this.records.set(key, {
      record: {
        state: 'in_progress',
        fingerprint,
        lockToken,
        startedAt: new Date(this.now()).toISOString(),
      },
      expiresAt: this.now() + lockTtlSeconds * 1000,
    });
    return Promise.resolve({ acquired: true });
  }

  complete(
    key: string,
    record: CompletedRecord,
    ttlSeconds: number,
  ): Promise<void> {
    this.records.set(key, {
      record,
      expiresAt: this.now() + ttlSeconds * 1000,
    });
    return Promise.resolve();
  }

  release(key: string, lockToken: string): Promise<void> {
    const existing = this.read(key);
    if (existing?.state === 'in_progress' && existing.lockToken === lockToken) {
      this.records.delete(key);
    }
    return Promise.resolve();
  }

  /** Registro vigente de `key` (para las pruebas). */
  read(key: string): IdempotencyRecord | undefined {
    const entry = this.records.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.records.delete(key);
      return undefined;
    }
    return entry.record;
  }
}
