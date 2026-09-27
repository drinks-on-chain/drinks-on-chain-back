import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConnectionOptions, JobsOptions, Queue } from 'bullmq';
import { buildRedisConnection } from '@shared/queue/redis-connection';
import {
  QUEUE_NAMES,
  QueueName,
  workerHeartbeatKey,
} from '@shared/queue/queue.constants';
import { WORKER_SETTINGS, WorkerSettings } from './worker.config';

/**
 * Instancias `Queue` de BullMQ del worker (una por cola nombrada) y opciones
 * comunes de los trabajos.
 */
@Injectable()
export class QueueRegistry implements OnModuleDestroy {
  private readonly logger = new Logger(QueueRegistry.name);
  private readonly queues = new Map<QueueName, Queue>();
  readonly connection: ConnectionOptions;

  constructor(
    @Inject(WORKER_SETTINGS) private readonly settings: WorkerSettings,
  ) {
    this.connection = buildRedisConnection(settings.redisUrl);
  }

  get prefix(): string {
    return this.settings.queuePrefix;
  }

  get(name: QueueName): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, {
        connection: this.connection,
        prefix: this.settings.queuePrefix,
        defaultJobOptions: this.defaultJobOptions(),
      });
      queue.on('error', (err) =>
        this.logger.error(`Error de Redis en la cola ${name}: ${err.message}`),
      );
      this.queues.set(name, queue);
    }
    return queue;
  }

  all(): Queue[] {
    return QUEUE_NAMES.map((name) => this.get(name));
  }

  /** Reintentos exponenciales y retención acotada en Redis. */
  defaultJobOptions(): JobsOptions {
    return {
      attempts: this.settings.jobAttempts,
      backoff: { type: 'exponential', delay: this.settings.jobBackoffMs },
      removeOnComplete: { age: 24 * 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    };
  }

  /** Comprueba la conexión con Redis. */
  async ping(): Promise<boolean> {
    try {
      // Ida y vuelta real a Redis (el cliente de BullMQ no expone PING)
      const client = await this.get('default').client;
      await client.get(`${this.settings.queuePrefix}:worker:ping`);
      return client.status === 'ready';
    } catch {
      return false;
    }
  }

  /**
   * Latido del worker en Redis, con caducidad: si el worker muere o deja de
   * estar sano, la clave desaparece sola al pasar `ttlMs`.
   */
  async writeHeartbeat(value: string, ttlMs: number): Promise<void> {
    const client = await this.get('default').client;
    await client.set(workerHeartbeatKey(this.prefix), value, { PX: ttlMs });
  }

  /** Borra el latido de Redis (parada ordenada del worker). */
  async clearHeartbeat(): Promise<void> {
    const client = await this.get('default').client;
    await client.del(workerHeartbeatKey(this.prefix));
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([...this.queues.values()].map((q) => q.close()));
    this.queues.clear();
  }
}
