import { Reflector } from '@nestjs/core';
import { WalletPurposeEnum } from '@prisma/client';
import { JOB_HANDLER_METADATA } from '@shared/queue/job-handler';
import { OutboxJobData } from '@shared/outbox/outbox.types';
import type { IWalletProvider } from '@modules/wallets/interfaces/wallet-provider.interface';
import { WineryCreatedHandler } from '../jobs/winery-created.handler';
import { MemberAddedHandler } from '../jobs/member-added.handler';
import { MemberAddedPayload, WineryCreatedPayload } from '../wineries.events';

function jobData<T>(type: string, payload: T): OutboxJobData<T> {
  return {
    outboxEventId: 'evt-1',
    eventType: type,
    aggregateType: 'winery',
    aggregateId: 'w-1',
    payload,
    correlationId: 'corr-1',
    occurredAt: '2026-09-27T10:00:00.000Z',
  };
}

describe('Procesadores del módulo de bodegas', () => {
  const provider = {
    activateCustodialVault: jest
      .fn()
      .mockResolvedValue({ activated: true, provider: 'DYNAMIC_SIMULATED' }),
  };
  const reflector = new Reflector();

  beforeEach(() => jest.clearAllMocks());

  it('winery.created activa la bóveda institucional de la bodega', async () => {
    const handler = new WineryCreatedHandler(
      provider as unknown as IWalletProvider,
    );
    await handler.handle(
      jobData<WineryCreatedPayload>('winery.created', {
        wineryId: 'w-1',
        ownerUserId: 'u-1',
        walletId: 'wal-1',
        vaultId: 'vault-1',
        stellarPublicKey: 'GABC',
      }),
    );
    expect(provider.activateCustodialVault).toHaveBeenCalledWith(
      'vault-1',
      'w-1',
      WalletPurposeEnum.PRODUCER_SIGNING,
    );
    expect(reflector.get(JOB_HANDLER_METADATA, WineryCreatedHandler)).toEqual({
      queue: 'chain',
      name: 'winery.created',
    });
  });

  it('member.added activa la bóveda del miembro', async () => {
    const handler = new MemberAddedHandler(
      provider as unknown as IWalletProvider,
    );
    await handler.handle(
      jobData<MemberAddedPayload>('member.added', {
        wineryId: 'w-1',
        userId: 'u-2',
        memberId: 'm-1',
        memberRole: 'ENOLOGIST',
        walletId: 'wal-2',
        vaultId: 'vault-2',
      }),
    );
    expect(provider.activateCustodialVault).toHaveBeenCalledWith(
      'vault-2',
      'u-2',
      WalletPurposeEnum.CONSUMER_NFT,
    );
    expect(reflector.get(JOB_HANDLER_METADATA, MemberAddedHandler)).toEqual({
      queue: 'chain',
      name: 'member.added',
    });
  });
});
