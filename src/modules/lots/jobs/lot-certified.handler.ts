import { Injectable, Logger } from '@nestjs/common';
import { HandlesJob, JobHandler } from '@shared/queue/job-handler';
import { QUEUE_CHAIN } from '@shared/queue/queue.constants';
import type { OutboxJobData } from '@shared/outbox/outbox.types';
import { LOT_CERTIFIED, LotCertifiedPayload } from '../lots.events';

/**
 * `lot.certified` (contrato O2 §10 y §15): el expediente del lote se cerró y
 * su huella queda pendiente de anclarse en la red. El anclaje llega en la
 * Ola 3 (este procesador pasará a llamarlo); hasta entonces solo deja
 * constancia, así el evento no queda sin procesador.
 */
@Injectable()
@HandlesJob(QUEUE_CHAIN, LOT_CERTIFIED)
export class LotCertifiedHandler implements JobHandler<
  OutboxJobData<LotCertifiedPayload>
> {
  private readonly logger = new Logger(LotCertifiedHandler.name);

  handle(data: OutboxJobData<LotCertifiedPayload>): Promise<void> {
    const { lotId, lotCode, hash } = data.payload;
    this.logger.log({
      message: `Lote ${lotCode} certificado: huella pendiente de anclaje (Ola 3)`,
      lotId,
      lotCode,
      hash,
    });
    return Promise.resolve();
  }
}
