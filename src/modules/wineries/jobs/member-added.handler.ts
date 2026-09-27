import { Inject, Injectable, Logger } from '@nestjs/common';
import { WalletPurposeEnum } from '@prisma/client';
import { HandlesJob, JobHandler } from '@shared/queue/job-handler';
import { QUEUE_CHAIN } from '@shared/queue/queue.constants';
import { OutboxJobData } from '@shared/outbox/outbox.types';
import type { IWalletProvider } from '@modules/wallets/interfaces/wallet-provider.interface';
import { MEMBER_ADDED, MemberAddedPayload } from '../wineries.events';

/**
 * `member.added` → activa la bóveda custodial del miembro nuevo en el
 * proveedor (simulado hasta la Ola 3).
 */
@Injectable()
@HandlesJob(QUEUE_CHAIN, MEMBER_ADDED)
export class MemberAddedHandler implements JobHandler<
  OutboxJobData<MemberAddedPayload>
> {
  private readonly logger = new Logger(MemberAddedHandler.name);

  constructor(
    @Inject('IWalletProvider') private readonly walletProvider: IWalletProvider,
  ) {}

  async handle(data: OutboxJobData<MemberAddedPayload>): Promise<void> {
    const { userId, wineryId, vaultId } = data.payload;
    await this.walletProvider.activateCustodialVault(
      vaultId,
      userId,
      WalletPurposeEnum.CONSUMER_NFT,
    );
    this.logger.log(
      `Miembro ${userId} de la bodega ${wineryId}: bóveda activada`,
    );
  }
}
