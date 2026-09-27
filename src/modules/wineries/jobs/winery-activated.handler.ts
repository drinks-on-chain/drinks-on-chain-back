import { Injectable, Logger } from '@nestjs/common';
import { HandlesJob, JobHandler } from '@shared/queue/job-handler';
import { QUEUE_CHAIN } from '@shared/queue/queue.constants';
import { OutboxJobData } from '@shared/outbox/outbox.types';
import { WINERY_ACTIVATED, WineryActivatedPayload } from '../wineries.events';

/**
 * `winery.activated` → identidad de la bodega en la red. Llega con la Ola 3
 * (doc 06 §3: cuenta y contrato NFT por bodega); hasta entonces solo queda
 * registrado, para que el evento no se pierda ni falle por falta de
 * procesador.
 */
@Injectable()
@HandlesJob(QUEUE_CHAIN, WINERY_ACTIVATED)
export class WineryActivatedHandler implements JobHandler<
  OutboxJobData<WineryActivatedPayload>
> {
  private readonly logger = new Logger(WineryActivatedHandler.name);

  handle(data: OutboxJobData<WineryActivatedPayload>): Promise<void> {
    const { wineryId, lotPrefix } = data.payload;
    this.logger.log(
      `Bodega ${wineryId} activada (prefijo ${lotPrefix}); identidad en la red pendiente de la Ola 3`,
    );
    return Promise.resolve();
  }
}
