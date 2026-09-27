import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { promises as fs } from 'fs';
import { dirname } from 'path';
import { PrismaService } from '@shared/prisma/prisma.service';
import { QueueRegistry } from './queue-registry.service';
import { OutboxRelayService } from './outbox-relay.service';
import { JobDispatcher } from './job-dispatcher.service';
import { WORKER_SETTINGS, WorkerSettings } from './worker.config';

export interface HeartbeatStatus {
  ok: boolean;
  database: boolean;
  redis: boolean;
  relay: boolean;
  workers: boolean;
}

/**
 * Latido del worker: cada `WORKER_HEARTBEAT_INTERVAL_MS` comprueba Postgres,
 * Redis, el relay y los workers de las colas y, si todo está bien, reescribe
 * `WORKER_HEARTBEAT_FILE`. El healthcheck del contenedor
 * (`dist/worker-healthcheck.js`) solo mira que el archivo sea reciente.
 */
@Injectable()
export class HeartbeatService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(HeartbeatService.name);
  private timer: NodeJS.Timeout | null = null;
  private lastOk: boolean | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueRegistry,
    private readonly relay: OutboxRelayService,
    private readonly dispatcher: JobDispatcher,
    @Inject(WORKER_SETTINGS) private readonly settings: WorkerSettings,
  ) {}

  onApplicationBootstrap(): void {
    void this.beat();
    this.timer = setInterval(
      () => void this.beat(),
      this.settings.heartbeat.intervalMs,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Al parar, el contenedor deja de estar sano de inmediato
    await fs.rm(this.settings.heartbeat.file, { force: true }).catch(() => {});
  }

  async check(): Promise<HeartbeatStatus> {
    // El relay debe haber completado una vuelta hace poco (atascado = no sano)
    const relayWindow =
      this.settings.relay.intervalMs * 3 + this.settings.relay.lockTimeoutMs;
    const [database, redis] = await Promise.all([
      this.prisma.ping(),
      this.queues.ping(),
    ]);
    const relay =
      this.relay.isRunning() && this.relay.msSinceLastTick() < relayWindow;
    const workers = this.dispatcher.isRunning();
    return {
      ok: database && redis && relay && workers,
      database,
      redis,
      relay,
      workers,
    };
  }

  async beat(): Promise<HeartbeatStatus> {
    const status = await this.check();
    if (status.ok) {
      const file = this.settings.heartbeat.file;
      await fs.mkdir(dirname(file), { recursive: true });
      await fs.writeFile(
        file,
        JSON.stringify({ at: new Date().toISOString(), pid: process.pid }),
      );
    }
    if (status.ok !== this.lastOk) {
      if (status.ok) this.logger.log('Worker sano');
      else this.logger.warn(`Worker no sano: ${JSON.stringify(status)}`);
      this.lastOk = status.ok;
    }
    return status;
  }
}
