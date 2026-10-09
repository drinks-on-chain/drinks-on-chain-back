import { Reflector } from '@nestjs/core';
import { JOB_HANDLER_METADATA } from '@shared/queue/job-handler';
import { OutboxJobData } from '@shared/outbox/outbox.types';
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

  it('winery.activated queda registrado en la cola chain y no falla', async () => {
    const handler = new WineryActivatedHandler();
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
    expect(Reflect.getMetadata('imports', WineriesJobsModule) ?? []).toEqual(
      [],
    );
  });
});
