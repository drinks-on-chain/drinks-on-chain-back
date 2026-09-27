import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { DiscoveryService, Reflector } from '@nestjs/core';
import { Job, UnrecoverableError, Worker } from 'bullmq';
import {
  JOB_HANDLER_METADATA,
  JobContext,
  JobHandler,
  JobHandlerMetadata,
} from '@shared/queue/job-handler';
import { QUEUE_NAMES, QueueName } from '@shared/queue/queue.constants';
import { runWithCorrelationId } from '@shared/logging/correlation';
import { QueueRegistry } from './queue-registry.service';
import { WORKER_SETTINGS, WorkerSettings } from './worker.config';

function isJobHandler(value: unknown): value is JobHandler {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { handle?: unknown }).handle === 'function'
  );
}

function correlationIdOf(job: Job, queue: QueueName): string {
  const data: unknown = job.data;
  if (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as { correlationId?: unknown }).correlationId === 'string'
  ) {
    return (data as { correlationId: string }).correlationId;
  }
  return `${queue}:${job.name}:${job.id ?? 'sin-id'}`;
}

/**
 * Descubre los procesadores (`@HandlesJob` / `@ScheduledTask`) de todos los
 * módulos cargados y levanta un `Worker` de BullMQ por cola que despacha cada
 * trabajo por su nombre. Un trabajo sin procesador falla sin reintentos.
 */
@Injectable()
export class JobDispatcher implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(JobDispatcher.name);
  private readonly handlers = new Map<string, JobHandler>();
  private readonly workers: Worker[] = [];
  private closed = false;

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly reflector: Reflector,
    private readonly queues: QueueRegistry,
    @Inject(WORKER_SETTINGS) private readonly settings: WorkerSettings,
  ) {}

  onApplicationBootstrap(): void {
    this.discoverHandlers();
    this.startWorkers();
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  /** Pares `cola/nombre` con procesador registrado. */
  registeredJobs(): string[] {
    return [...this.handlers.keys()].sort();
  }

  isRunning(): boolean {
    return (
      !this.closed &&
      this.workers.length > 0 &&
      this.workers.every((w) => w.isRunning())
    );
  }

  /** Espera a que terminen los trabajos en curso y cierra los workers. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled(this.workers.map((w) => w.close()));
    this.logger.log('Workers de las colas cerrados');
  }

  private key(queue: QueueName, name: string): string {
    return `${queue}/${name}`;
  }

  private discoverHandlers(): void {
    for (const wrapper of this.discovery.getProviders()) {
      const { instance, metatype } = wrapper;
      if (!metatype || !instance) continue;
      const meta = this.reflector.get<JobHandlerMetadata | undefined>(
        JOB_HANDLER_METADATA,
        metatype,
      );
      if (!meta) continue;
      if (!isJobHandler(instance)) {
        throw new Error(
          `${metatype.name} está marcado como procesador pero no implementa handle()`,
        );
      }
      const key = this.key(meta.queue, meta.name);
      if (this.handlers.has(key)) {
        throw new Error(`Hay dos procesadores para ${key}`);
      }
      this.handlers.set(key, instance);
    }
    this.logger.log(
      `Procesadores registrados: ${this.registeredJobs().join(', ') || 'ninguno'}`,
    );
  }

  private startWorkers(): void {
    for (const queue of QUEUE_NAMES) {
      const worker = new Worker(queue, (job: Job) => this.process(queue, job), {
        connection: this.queues.connection,
        prefix: this.settings.queuePrefix,
        concurrency: this.settings.concurrency,
      });
      worker.on('failed', (job, err) => {
        if (!job) return;
        runWithCorrelationId(correlationIdOf(job, queue), () => {
          const attempts = job.opts.attempts ?? 1;
          const final =
            err instanceof UnrecoverableError || job.attemptsMade >= attempts;
          const msg = `Trabajo ${queue}/${job.name} ${job.id} falló (intento ${job.attemptsMade}/${attempts}): ${err.message}`;
          if (final) this.logger.error(msg);
          else this.logger.warn(msg);
        });
      });
      worker.on('error', (err) =>
        this.logger.error(`Error del worker de ${queue}: ${err.message}`),
      );
      this.workers.push(worker);
    }
    this.logger.log(
      `Escuchando las colas ${QUEUE_NAMES.join(', ')} (concurrencia ${this.settings.concurrency})`,
    );
  }

  /** Procesa un trabajo con su correlationId en el contexto asíncrono. */
  async process(queue: QueueName, job: Job): Promise<void> {
    const correlationId = correlationIdOf(job, queue);
    return runWithCorrelationId(correlationId, async () => {
      const handler = this.handlers.get(this.key(queue, job.name));
      if (!handler) {
        throw new UnrecoverableError(
          `No hay procesador para ${queue}/${job.name}`,
        );
      }
      const context: JobContext = {
        jobId: job.id ?? '',
        name: job.name,
        queue,
        attempt: job.attemptsMade + 1,
        correlationId,
      };
      const started = Date.now();
      await handler.handle(job.data, context);
      this.logger.log(
        `Trabajo ${queue}/${job.name} ${job.id} completado en ${Date.now() - started} ms`,
      );
    });
  }
}
