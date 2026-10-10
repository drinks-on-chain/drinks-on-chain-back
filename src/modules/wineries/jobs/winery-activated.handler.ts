import { Injectable } from '@nestjs/common';
import { HandlesJob, JobHandler } from '@shared/queue/job-handler';
import { QUEUE_CHAIN } from '@shared/queue/queue.constants';
import { OutboxJobData } from '@shared/outbox/outbox.types';
import { WineryIdentityProvisioner } from '@modules/chain/jobs/winery-identity.provisioner';
import { WINERY_ACTIVATED, WineryActivatedPayload } from '../wineries.events';

/**
 * `winery.activated` → identidad de la bodega en la red (contrato O3 §3.1):
 * su cuenta y su contrato NFT, encadenados como intenciones que el firmante
 * valida, firma y envía. Reprocesar el evento no crea otra transacción
 * (`intentKey`). Con la cadena deshabilitada solo queda registrado.
 */
@Injectable()
@HandlesJob(QUEUE_CHAIN, WINERY_ACTIVATED)
export class WineryActivatedHandler implements JobHandler<
  OutboxJobData<WineryActivatedPayload>
> {
  constructor(private readonly provisioner: WineryIdentityProvisioner) {}

  async handle(data: OutboxJobData<WineryActivatedPayload>): Promise<void> {
    await this.provisioner.provision(data.payload.wineryId);
  }
}
