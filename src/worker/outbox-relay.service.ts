import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { OutboxStatusEnum, Prisma } from '@prisma/client';
import { PrismaService } from '@shared/prisma/prisma.service';
import { isQueueName } from '@shared/queue/queue.constants';
import { OutboxJobData } from '@shared/outbox/outbox.types';
import { runWithCorrelationId } from '@shared/logging/correlation';
import { QueueRegistry } from './queue-registry.service';
import { WORKER_SETTINGS, WorkerSettings } from './worker.config';

/** Fila reclamada por el relay (subconjunto de OutboxEvent). */
export interface ClaimedOutboxEvent {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  queue: string;
  payload: Prisma.JsonValue;
  correlationId: string | null;
  attempts: number;
  lockedAt: Date;
  createdAt: Date;
}

export interface RelayTickResult {
  claimed: number;
  published: number;
  retried: number;
  failed: number;
}

const MAX_ERROR_LENGTH = 2000;

/**
 * Espera antes del intento `attempts + 1`: base · 2^(attempts − 1), con tope.
 * `attempts` es el número de intentos ya hechos (≥ 1).
 */
export function computeRetryDelayMs(
  attempts: number,
  baseMs: number,
  maxMs: number,
): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(maxMs, baseMs * 2 ** Math.min(exponent, 30));
}

/**
 * Relay del outbox (ADR-005): toma lotes de eventos PENDING con
 * `FOR UPDATE SKIP LOCKED` (varios relays no toman el mismo evento), los
 * publica en BullMQ con `jobId = id del evento` (un reintento no duplica el
 * trabajo) y marca DONE; si la publicación falla, reintenta con espera
 * exponencial y pasa a FAILED tras `OUTBOX_MAX_ATTEMPTS`.
 *
 * Un evento que se queda en PROCESSING más de `OUTBOX_LOCK_TIMEOUT_MS`
 * (el relay murió a mitad) vuelve a reclamarse.
 */
@Injectable()
export class OutboxRelayService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(OutboxRelayService.name);
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = true;
  private lastTickAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueRegistry,
    @Inject(WORKER_SETTINGS) private readonly settings: WorkerSettings,
  ) {}

  onApplicationBootstrap(): void {
    this.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.lastTickAt = Date.now();
    this.schedule(0);
    this.logger.log(
      `Relay del outbox en marcha (cada ${this.settings.relay.intervalMs} ms, lotes de ${this.settings.relay.batchSize})`,
    );
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
    this.logger.log('Relay del outbox detenido');
  }

  /** Milisegundos desde la última vuelta completada (para el latido). */
  msSinceLastTick(): number {
    return Date.now() - this.lastTickAt;
  }

  isRunning(): boolean {
    return !this.stopped;
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.running = this.loop();
    }, delayMs);
  }

  private async loop(): Promise<void> {
    let fullBatch = false;
    try {
      const result = await this.tick();
      fullBatch = result.claimed >= this.settings.relay.batchSize;
    } catch (error) {
      this.logger.error(
        `Vuelta del relay fallida: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.lastTickAt = Date.now();
      // Si el lote venía lleno, hay más pendientes: sigue sin esperar
      if (!this.stopped)
        this.schedule(fullBatch ? 0 : this.settings.relay.intervalMs);
    }
  }

  /** Una vuelta: reclama un lote, lo publica y marca cada evento. */
  async tick(): Promise<RelayTickResult> {
    const events = await this.claimBatch();
    const result: RelayTickResult = {
      claimed: events.length,
      published: 0,
      retried: 0,
      failed: 0,
    };
    if (events.length === 0) return result;

    const outcomes = await Promise.all(
      events.map(async (event) => ({
        event,
        error: await this.publish(event),
      })),
    );

    const done = outcomes.filter((o) => o.error === null).map((o) => o.event);
    if (done.length > 0) {
      await this.markDone(done);
      result.published = done.length;
    }
    for (const { event, error } of outcomes) {
      if (error === null) continue;
      const final = await this.markFailure(event, error);
      if (final) result.failed += 1;
      else result.retried += 1;
    }
    return result;
  }

  async claimBatch(): Promise<ClaimedOutboxEvent[]> {
    const { batchSize, lockTimeoutMs } = this.settings.relay;
    return this.prisma.$queryRaw<ClaimedOutboxEvent[]>`
      UPDATE outbox_events AS o
         SET status = 'PROCESSING'::outbox_status_enum,
             attempts = o.attempts + 1,
             locked_at = date_trunc('milliseconds', now()),
             updated_at = now()
        FROM (
          SELECT id
            FROM outbox_events
           WHERE (status = 'PENDING'::outbox_status_enum AND next_attempt_at <= now())
              OR (status = 'PROCESSING'::outbox_status_enum
                  AND locked_at < now() - (${lockTimeoutMs}::int * interval '1 millisecond'))
           ORDER BY next_attempt_at, created_at
           LIMIT ${batchSize}::int
           FOR UPDATE SKIP LOCKED
        ) AS claimed
       WHERE o.id = claimed.id
      RETURNING o.id,
                o.event_type AS "eventType",
                o.aggregate_type AS "aggregateType",
                o.aggregate_id AS "aggregateId",
                o.queue,
                o.payload,
                o.correlation_id AS "correlationId",
                o.attempts,
                o.locked_at AS "lockedAt",
                o.created_at AS "createdAt"`;
  }

  /** Publica el evento; devuelve el error o `null` si quedó en la cola. */
  private async publish(event: ClaimedOutboxEvent): Promise<Error | null> {
    return runWithCorrelationId(
      event.correlationId ?? `outbox:${event.id}`,
      async () => {
        try {
          if (!isQueueName(event.queue)) {
            throw new UnknownQueueError(event.queue);
          }
          const data: OutboxJobData = {
            outboxEventId: event.id,
            eventType: event.eventType,
            aggregateType: event.aggregateType,
            aggregateId: event.aggregateId,
            payload: (event.payload ?? {}) as Record<string, unknown>,
            correlationId: event.correlationId,
            occurredAt: new Date(event.createdAt).toISOString(),
          };
          await this.queues
            .get(event.queue)
            .add(event.eventType, data, { jobId: event.id });
          this.logger.log(
            `Evento ${event.eventType} ${event.id} publicado en la cola ${event.queue}`,
          );
          return null;
        } catch (error) {
          return error instanceof Error ? error : new Error(String(error));
        }
      },
    );
  }

  private async markDone(events: ClaimedOutboxEvent[]): Promise<void> {
    // Todas las filas de un mismo reclamo comparten locked_at; la condición
    // evita pisar un evento que otro relay reclamó por caducidad.
    const byLock = new Map<number, string[]>();
    for (const e of events) {
      const key = new Date(e.lockedAt).getTime();
      byLock.set(key, [...(byLock.get(key) ?? []), e.id]);
    }
    const processedAt = new Date();
    for (const [lockedAt, ids] of byLock) {
      await this.prisma.outboxEvent.updateMany({
        where: {
          id: { in: ids },
          status: OutboxStatusEnum.PROCESSING,
          lockedAt: new Date(lockedAt),
        },
        data: {
          status: OutboxStatusEnum.DONE,
          processedAt,
          lockedAt: null,
          lastError: null,
        },
      });
    }
  }

  /** Devuelve true si el evento pasa a FAILED (sin más intentos). */
  private async markFailure(
    event: ClaimedOutboxEvent,
    error: Error,
  ): Promise<boolean> {
    const { maxAttempts, retryBaseMs, retryMaxMs } = this.settings.relay;
    const final =
      error instanceof UnknownQueueError || event.attempts >= maxAttempts;
    const lastError = `${error.name}: ${error.message}`.slice(
      0,
      MAX_ERROR_LENGTH,
    );
    const delayMs = computeRetryDelayMs(
      event.attempts,
      retryBaseMs,
      retryMaxMs,
    );

    await this.prisma.outboxEvent.updateMany({
      where: {
        id: event.id,
        status: OutboxStatusEnum.PROCESSING,
        lockedAt: new Date(event.lockedAt),
      },
      data: final
        ? { status: OutboxStatusEnum.FAILED, lockedAt: null, lastError }
        : {
            status: OutboxStatusEnum.PENDING,
            lockedAt: null,
            lastError,
            nextAttemptAt: new Date(Date.now() + delayMs),
          },
    });

    runWithCorrelationId(event.correlationId ?? `outbox:${event.id}`, () => {
      if (final) {
        this.logger.error(
          `Evento ${event.eventType} ${event.id} FAILED tras ${event.attempts} intentos: ${lastError}`,
        );
      } else {
        this.logger.warn(
          `Evento ${event.eventType} ${event.id} no publicado (intento ${event.attempts}/${maxAttempts}), reintento en ${delayMs} ms: ${lastError}`,
        );
      }
    });
    return final;
  }
}

class UnknownQueueError extends Error {
  constructor(queue: string) {
    super(`Cola desconocida "${queue}"`);
    this.name = 'UnknownQueueError';
  }
}
