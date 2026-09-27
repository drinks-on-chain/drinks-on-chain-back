import { Inject, Injectable, Logger } from '@nestjs/common';
import { WalletPurposeEnum } from '@prisma/client';
import { HandlesJob, JobHandler } from '@shared/queue/job-handler';
import { QUEUE_CHAIN } from '@shared/queue/queue.constants';
import { OutboxJobData } from '@shared/outbox/outbox.types';
import type { IWalletProvider } from '@modules/wallets/interfaces/wallet-provider.interface';
import { WINERY_CREATED, WineryCreatedPayload } from '../wineries.events';

/**
 * `winery.created` → activa la bóveda custodial de la bodega en el proveedor
 * (simulado hasta la Ola 3, que la sustituye por la cuenta real en la red).
 */
@Injectable()
@HandlesJob(QUEUE_CHAIN, WINERY_CREATED)
export class WineryCreatedHandler implements JobHandler<
  OutboxJobData<WineryCreatedPayload>
> {
  private readonly logger = new Logger(WineryCreatedHandler.name);

  constructor(
    @Inject('IWalletProvider') private readonly walletProvider: IWalletProvider,
  ) {}

  async handle(data: OutboxJobData<WineryCreatedPayload>): Promise<void> {
    const { wineryId, vaultId } = data.payload;
    await this.walletProvider.activateCustodialVault(
      vaultId,
      wineryId,
      WalletPurposeEnum.PRODUCER_SIGNING,
    );
    this.logger.log(`Bodega ${wineryId}: bóveda institucional activada`);
  }
}
