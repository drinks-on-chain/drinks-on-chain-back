import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HandlesJob, JobContext, JobHandler } from '@shared/queue/job-handler';
import { QUEUE_DEFAULT } from '@shared/queue/queue.constants';
import type { OutboxJobData } from '@shared/outbox/outbox.types';
import { BottleCodeExportBuilder } from '../bottle-code-export.builder';
import {
  BOTTLE_CODES_EXPORT_JOB,
  BottleCodesExportPayload,
} from '../lots.events';

/**
 * `trace.bottle-codes.export` (contrato O2 §15): genera el ZIP de una
 * exportación de códigos de botella. Idempotente (una exportación lista no se
 * rehace). Si falla, BullMQ reintenta; en el último intento la exportación
 * queda `FAILED` con el motivo.
 */
@Injectable()
@HandlesJob(QUEUE_DEFAULT, BOTTLE_CODES_EXPORT_JOB)
export class BottleCodesExportHandler implements JobHandler<
  OutboxJobData<BottleCodesExportPayload>
> {
  private readonly logger = new Logger(BottleCodesExportHandler.name);

  constructor(
    private readonly builder: BottleCodeExportBuilder,
    private readonly config: ConfigService,
  ) {}

  async handle(
    data: OutboxJobData<BottleCodesExportPayload>,
    context: JobContext,
  ): Promise<void> {
    const { exportId } = data.payload;
    try {
      const result = await this.builder.build(exportId);
      if (result.status === 'SKIPPED') {
        this.logger.warn(
          `Exportación ${exportId} sin generar: ${result.reason}`,
        );
      }
    } catch (error) {
      const attempts = Number(this.config.get('JOB_ATTEMPTS') ?? 5);
      if (context.attempt >= attempts) {
        await this.builder.markFailed(exportId, error);
      }
      throw error;
    }
  }
}
