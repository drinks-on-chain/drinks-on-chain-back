import { Injectable, Logger } from '@nestjs/common';
import { JobHandler, ScheduledTask } from '@shared/queue/job-handler';
import { BottleCodeExportBuilder } from '../bottle-code-export.builder';

export const BOTTLE_CODE_EXPORTS_CLEANUP_TASK =
  'trace.bottle-codes.exports-cleanup';

/**
 * Tarea programada: borra del almacenamiento los ZIP de códigos de botella
 * caducados (7 días, contrato O2 §15). Idempotente.
 */
@Injectable()
@ScheduledTask({
  name: BOTTLE_CODE_EXPORTS_CLEANUP_TASK,
  pattern: '41 * * * *',
  description: 'Limpieza horaria de los ZIP de códigos de botella caducados',
})
export class BottleCodeExportsCleanupTask implements JobHandler {
  private readonly logger = new Logger(BottleCodeExportsCleanupTask.name);

  constructor(private readonly builder: BottleCodeExportBuilder) {}

  async handle(): Promise<void> {
    const removed = await this.builder.removeExpired();
    if (removed > 0) {
      this.logger.log(
        `${removed} exportaciones de códigos de botella caducadas borradas`,
      );
    }
  }
}
