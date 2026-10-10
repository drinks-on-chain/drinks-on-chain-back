import { Reflector } from '@nestjs/core';
import { JOB_HANDLER_METADATA } from '@shared/queue/job-handler';
import { OutboxJobData } from '@shared/outbox/outbox.types';
import { ChainJobsModule } from '@modules/chain/jobs/chain-jobs.module';
import type { WineryIdentityProvisioner } from '@modules/chain/jobs/winery-identity.provisioner';
import { WineryActivatedHandler } from '../jobs/winery-activated.handler';
import { WineriesJobsModule } from '../jobs/wineries-jobs.module';
import { WineryActivatedPayload } from '../wineries.events';

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
  const reflector = new Reflector();

  it('winery.activated queda registrado en la cola chain y aprovisiona la identidad de la bodega', async () => {
    const provision = jest.fn().mockResolvedValue('REQUESTED');
    const handler = new WineryActivatedHandler({
      provision,
    } as unknown as WineryIdentityProvisioner);
    await expect(
      handler.handle(
        jobData<WineryActivatedPayload>('winery.activated', {
          wineryId: 'w-1',
          lotPrefix: 'CVJ',
          ownerUserId: 'u-1',
          activatedAt: '2026-09-27T10:00:00.000Z',
        }),
      ),
    ).resolves.toBeUndefined();
    expect(provision).toHaveBeenCalledWith('w-1');
    expect(reflector.get(JOB_HANDLER_METADATA, WineryActivatedHandler)).toEqual(
      { queue: 'chain', name: 'winery.activated' },
    );
  });

  it('SE-02: no queda ningún procesador de bóvedas simuladas', () => {
    const providers = Reflect.getMetadata(
      'providers',
      WineriesJobsModule,
    ) as unknown[];
    expect(providers).toEqual([WineryActivatedHandler]);
    // Solo la cadena (identidad real de la bodega, contrato O3 §3.1)
    expect(Reflect.getMetadata('imports', WineriesJobsModule) ?? []).toEqual([
      ChainJobsModule,
    ]);
  });
});
