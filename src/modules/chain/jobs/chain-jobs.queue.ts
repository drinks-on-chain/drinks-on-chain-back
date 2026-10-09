import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { JobsOptions } from 'bullmq';
import {
  QUEUE_CHAIN,
  QUEUE_CHAIN_POLL,
  type QueueName,
} from '@shared/queue/queue.constants';
import { QueueRegistry } from '../../../worker/queue-registry.service';
import {
  CHAIN_ANCHOR_BACKFILL_JOB,
  CHAIN_IDENTITY_BACKFILL_JOB,
  CHAIN_TTL_REVIEW_JOB,
  CHAIN_TX_CONFIRM_JOB,
  CHAIN_TX_PROCESS_JOB,
  type ChainTxJobData,
} from '../chain.events';

/** Lo mínimo de `QueueRegistry` (src/worker) que usa la cadena. */
interface QueueSource {
  get(name: QueueName): {
    add(name: string, data: unknown, opts?: JobsOptions): Promise<unknown>;
  };
}

/**
 * Trabajos directos de la cadena (sondeos y reintentos). No sustituyen al
 * outbox: una intención nueva siempre nace con su evento `chain.tx.requested`;
 * esto solo vuelve a despertar transacciones que ya existen. Si Redis falla,
 * la tarea `chain.tx.poll` (cada 5 s) las recoge igualmente.
 */
@Injectable()
export class ChainJobsQueue {
  private readonly logger = new Logger(ChainJobsQueue.name);
  private registry: QueueSource | null | undefined;

  constructor(private readonly moduleRef: ModuleRef) {}

  /** Vuelve a intentar tomar una transacción en espera. */
  process(transactionId: string, delayMs = 0): Promise<void> {
    return this.add<ChainTxJobData>(
      QUEUE_CHAIN,
      CHAIN_TX_PROCESS_JOB,
      { transactionId },
      { jobId: `process-${transactionId}`, delay: delayMs },
    );
  }

  /** Consulta en la red una transacción enviada. */
  confirm(transactionId: string, delayMs = 0): Promise<void> {
    return this.add<ChainTxJobData>(
      QUEUE_CHAIN_POLL,
      CHAIN_TX_CONFIRM_JOB,
      { transactionId },
      { jobId: `confirm-${transactionId}`, delay: delayMs },
    );
  }

  /** Siguiente bodega del relleno de identidades. */
  backfill(delayMs = 0): Promise<void> {
    return this.add(
      QUEUE_CHAIN,
      CHAIN_IDENTITY_BACKFILL_JOB,
      {},
      { jobId: 'identity-backfill', delay: delayMs },
    );
  }

  /** Relleno de anclajes: expedientes cerrados sin anclaje (§7.1). */
  anchorBackfill(delayMs = 0): Promise<void> {
    return this.add(
      QUEUE_CHAIN,
      CHAIN_ANCHOR_BACKFILL_JOB,
      {},
      { jobId: 'anchor-backfill', delay: delayMs },
    );
  }

  /** Revisión del TTL fuera de su hora: una emisión deja entradas nuevas (§8.3). */
  ttlReview(delayMs = 0): Promise<void> {
    return this.add(
      QUEUE_CHAIN,
      CHAIN_TTL_REVIEW_JOB,
      {},
      { jobId: 'ttl-review', delay: delayMs },
    );
  }

  private async add<T>(
    queue: QueueName,
    name: string,
    data: T,
    opts: JobsOptions,
  ): Promise<void> {
    const registry = this.resolve();
    if (!registry) return;
    try {
      await registry.get(queue).add(name, data, {
        // Un solo intento y sin rastro: el `jobId` evita duplicados mientras
        // está en cola y, al terminar, deja sitio al siguiente
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
        ...opts,
      });
    } catch (error) {
      this.logger.warn(
        `No se pudo encolar ${queue}/${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private resolve(): QueueSource | null {
    if (this.registry === undefined) {
      try {
        this.registry = this.moduleRef.get<QueueSource>(QueueRegistry, {
          strict: false,
        });
      } catch {
        // Fuera del worker (pruebas de un módulo suelto) no hay colas
        this.registry = null;
      }
    }
    return this.registry;
  }
}
