import { Injectable } from '@nestjs/common';
import { DiscoveryService, Reflector } from '@nestjs/core';
import { Job, UnrecoverableError } from 'bullmq';
import { JobDispatcher } from '../job-dispatcher.service';
import { HandlesJob, JobContext, JobHandler } from '@shared/queue/job-handler';
import { CorrelationIdMiddleware } from '@shared/middleware/correlation-id.middleware';
import { QueueRegistry } from '../queue-registry.service';
import { WorkerSettings } from '../worker.config';

@Injectable()
@HandlesJob('chain', 'thing.happened')
class ThingHandler implements JobHandler {
  calls: { data: unknown; context: JobContext; correlationId?: string }[] = [];
  async handle(data: unknown, context: JobContext): Promise<void> {
    this.calls.push({
      data,
      context,
      correlationId: CorrelationIdMiddleware.getCorrelationId(),
    });
  }
}

@Injectable()
@HandlesJob('chain', 'thing.happened')
class DuplicateHandler implements JobHandler {
  async handle(): Promise<void> {}
}

@Injectable()
@HandlesJob('default', 'broken')
class NotAHandler {}

function discoveryOf(...instances: object[]): DiscoveryService {
  return {
    getProviders: () =>
      instances.map((instance) => ({
        instance,
        metatype: instance.constructor,
      })),
  } as unknown as DiscoveryService;
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    name: 'thing.happened',
    data: { correlationId: 'corr-1', payload: { a: 1 } },
    attemptsMade: 0,
    opts: {},
    ...overrides,
  } as unknown as Job;
}

const settings = { concurrency: 1, queuePrefix: 'test' } as WorkerSettings;

function dispatcherWith(...instances: object[]): JobDispatcher {
  const dispatcher = new JobDispatcher(
    discoveryOf(...instances),
    new Reflector(),
    {} as QueueRegistry,
    settings,
  );
  // Solo el descubrimiento: sin workers reales de BullMQ
  (
    dispatcher as unknown as { discoverHandlers: () => void }
  ).discoverHandlers();
  return dispatcher;
}

describe('JobDispatcher', () => {
  it('descubre los procesadores marcados con @HandlesJob', () => {
    const dispatcher = dispatcherWith(new ThingHandler(), { other: true });
    expect(dispatcher.registeredJobs()).toEqual(['chain/thing.happened']);
  });

  it('rechaza dos procesadores para el mismo trabajo', () => {
    expect(() =>
      dispatcherWith(new ThingHandler(), new DuplicateHandler()),
    ).toThrow(/dos procesadores/);
  });

  it('rechaza un procesador sin handle()', () => {
    expect(() => dispatcherWith(new NotAHandler())).toThrow(/handle\(\)/);
  });

  it('despacha por nombre con el correlationId del evento en el contexto', async () => {
    const handler = new ThingHandler();
    const dispatcher = dispatcherWith(handler);

    await dispatcher.process('chain', job({ attemptsMade: 1 }));

    expect(handler.calls).toHaveLength(1);
    expect(handler.calls[0].data).toEqual({
      correlationId: 'corr-1',
      payload: { a: 1 },
    });
    expect(handler.calls[0].context).toEqual({
      jobId: 'job-1',
      name: 'thing.happened',
      queue: 'chain',
      attempt: 2,
      correlationId: 'corr-1',
    });
    expect(handler.calls[0].correlationId).toBe('corr-1');
  });

  it('sin correlationId en los datos usa uno derivado del trabajo', async () => {
    const handler = new ThingHandler();
    const dispatcher = dispatcherWith(handler);
    await dispatcher.process('chain', job({ data: {} }));
    expect(handler.calls[0].correlationId).toBe('chain:thing.happened:job-1');
  });

  it('un trabajo sin procesador falla sin reintentos', async () => {
    const dispatcher = dispatcherWith(new ThingHandler());
    await expect(
      dispatcher.process('email', job({ name: 'unknown' })),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });
});
