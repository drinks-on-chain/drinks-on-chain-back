import { Inject, Injectable, Logger } from '@nestjs/common';
import { OutboxStatusEnum } from '@prisma/client';
import { PrismaService } from '@shared/prisma/prisma.service';
import { JobHandler, ScheduledTask } from '@shared/queue/job-handler';
import { WORKER_SETTINGS, WorkerSettings } from '../worker.config';

export const OUTBOX_CLEANUP_TASK = 'outbox.cleanup';

/**
 * Tarea programada: borra los eventos DONE del outbox más antiguos que
 * `OUTBOX_RETENTION_DAYS`. Los FAILED se conservan para revisarlos.
 */
@Injectable()
@ScheduledTask({
  name: OUTBOX_CLEANUP_TASK,
  pattern: '17 * * * *',
  description: 'Limpieza horaria de eventos DONE antiguos del outbox',
})
export class OutboxCleanupTask implements JobHandler {
  private readonly logger = new Logger(OutboxCleanupTask.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WORKER_SETTINGS) private readonly settings: WorkerSettings,
  ) {}

  async handle(): Promise<void> {
    const deleted = await this.run();
    this.logger.log(
      `Outbox: ${deleted} eventos DONE de más de ${this.settings.retentionDays} días borrados`,
    );
  }

  async run(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(
      now.getTime() - this.settings.retentionDays * 24 * 3600 * 1000,
    );
    const { count } = await this.prisma.outboxEvent.deleteMany({
      where: {
        status: OutboxStatusEnum.DONE,
        processedAt: { lt: cutoff },
      },
    });
    return count;
  }
}
