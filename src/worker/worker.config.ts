import * as Joi from 'joi';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConfigService } from '@nestjs/config';
import { mailEnvValidationSchema } from '@modules/mail/mail.transport';
import {
  assertChainEnvCoherent,
  chainEnvValidationSchema,
} from '@modules/chain/chain.config';

/**
 * Variables de entorno del proceso `worker`. No necesita secretos de JWT ni
 * CORS: solo base de datos, Redis y los ajustes del relay y las colas.
 */
export const workerEnvValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgres', 'postgresql'] })
    .required(),
  REDIS_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .required(),

  // Prefijo de las claves de BullMQ en Redis
  QUEUE_PREFIX: Joi.string()
    .pattern(/^[a-zA-Z0-9_-]+$/)
    .default('doc'),
  WORKER_CONCURRENCY: Joi.number().integer().min(1).max(100).default(5),
  // Reintentos de cada trabajo en BullMQ (backoff exponencial)
  JOB_ATTEMPTS: Joi.number().integer().min(1).max(50).default(5),
  JOB_BACKOFF_MS: Joi.number().integer().min(100).default(5000),

  // Relay del outbox
  OUTBOX_RELAY_INTERVAL_MS: Joi.number().integer().min(50).default(1000),
  OUTBOX_RELAY_BATCH_SIZE: Joi.number().integer().min(1).max(500).default(50),
  OUTBOX_MAX_ATTEMPTS: Joi.number().integer().min(1).max(100).default(10),
  OUTBOX_RETRY_BASE_MS: Joi.number().integer().min(10).default(2000),
  OUTBOX_RETRY_MAX_MS: Joi.number().integer().min(10).default(600000),
  // Un evento en PROCESSING más tiempo que esto se considera abandonado
  OUTBOX_LOCK_TIMEOUT_MS: Joi.number().integer().min(1000).default(60000),
  // Limpieza programada de eventos DONE
  OUTBOX_RETENTION_DAYS: Joi.number().integer().min(1).default(7),

  // Latido para el healthcheck del contenedor
  WORKER_HEARTBEAT_FILE: Joi.string().default(
    join(tmpdir(), 'doc-worker.heartbeat'),
  ),
  WORKER_HEARTBEAT_INTERVAL_MS: Joi.number().integer().min(1000).default(10000),
  WORKER_HEARTBEAT_MAX_AGE_MS: Joi.number().integer().min(1000).default(60000),

  // Correo (cola `email`): SMTP y remitente; por defecto, Mailpit en local
  ...mailEnvValidationSchema,

  // Cadena (contrato O3 §2.1): todas opcionales; sin ellas, deshabilitada.
  // El custodio de claves vive en este proceso
  ...chainEnvValidationSchema,
  // Origen público de la API: URI base de los contratos (§3.1)
  API_PUBLIC_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .allow('')
    .optional(),
}).custom(assertChainEnvCoherent);

export const WORKER_SETTINGS = Symbol('WORKER_SETTINGS');

export interface WorkerSettings {
  redisUrl: string;
  queuePrefix: string;
  concurrency: number;
  jobAttempts: number;
  jobBackoffMs: number;
  relay: {
    intervalMs: number;
    batchSize: number;
    maxAttempts: number;
    retryBaseMs: number;
    retryMaxMs: number;
    lockTimeoutMs: number;
  };
  retentionDays: number;
  heartbeat: {
    file: string;
    intervalMs: number;
    /** Vida del latido en Redis (la API lo lee en `/v1/health/ready`). */
    maxAgeMs?: number;
  };
}

export function workerSettingsFromConfig(
  config: ConfigService,
): WorkerSettings {
  const num = (key: string) => Number(config.getOrThrow<number>(key));
  return {
    redisUrl: config.getOrThrow<string>('REDIS_URL'),
    queuePrefix: config.getOrThrow<string>('QUEUE_PREFIX'),
    concurrency: num('WORKER_CONCURRENCY'),
    jobAttempts: num('JOB_ATTEMPTS'),
    jobBackoffMs: num('JOB_BACKOFF_MS'),
    relay: {
      intervalMs: num('OUTBOX_RELAY_INTERVAL_MS'),
      batchSize: num('OUTBOX_RELAY_BATCH_SIZE'),
      maxAttempts: num('OUTBOX_MAX_ATTEMPTS'),
      retryBaseMs: num('OUTBOX_RETRY_BASE_MS'),
      retryMaxMs: num('OUTBOX_RETRY_MAX_MS'),
      lockTimeoutMs: num('OUTBOX_LOCK_TIMEOUT_MS'),
    },
    retentionDays: num('OUTBOX_RETENTION_DAYS'),
    heartbeat: {
      file: config.getOrThrow<string>('WORKER_HEARTBEAT_FILE'),
      intervalMs: num('WORKER_HEARTBEAT_INTERVAL_MS'),
      maxAgeMs: num('WORKER_HEARTBEAT_MAX_AGE_MS'),
    },
  };
}
