import { Prisma } from '@prisma/client';
import { OutboxService } from '../outbox.service';
import { runWithCorrelationId } from '@shared/logging/correlation';

describe('OutboxService', () => {
  const service = new OutboxService();

  function txMock() {
    return {
      outboxEvent: {
        create: jest.fn().mockImplementation(({ data }) => ({
          id: 'evt-1',
          ...data,
        })),
      },
    };
  }

  it('escribe el evento con el cliente de la transacción', async () => {
    const tx = txMock();

    await service.add(tx as unknown as Prisma.TransactionClient, {
      type: 'winery.created',
      aggregateType: 'winery',
      aggregateId: 'w-1',
      queue: 'chain',
      payload: { wineryId: 'w-1' },
      correlationId: 'corr-explicit',
    });

    expect(tx.outboxEvent.create).toHaveBeenCalledWith({
      data: {
        eventType: 'winery.created',
        aggregateType: 'winery',
        aggregateId: 'w-1',
        queue: 'chain',
        payload: { wineryId: 'w-1' },
        correlationId: 'corr-explicit',
      },
    });
  });

  it('usa la cola default y el correlationId de la petición en curso', async () => {
    const tx = txMock();

    await runWithCorrelationId('corr-http', () =>
      service.add(tx as unknown as Prisma.TransactionClient, {
        type: 'thing.happened',
        aggregateType: 'thing',
        aggregateId: 't-1',
        payload: {},
      }),
    );

    expect(tx.outboxEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        queue: 'default',
        correlationId: 'corr-http',
      }),
    });
  });

  it('sin petición en curso guarda correlationId null', async () => {
    const tx = txMock();
    await service.add(tx as unknown as Prisma.TransactionClient, {
      type: 'thing.happened',
      aggregateType: 'thing',
      aggregateId: 't-1',
      payload: {},
    });
    expect(tx.outboxEvent.create.mock.calls[0][0].data.correlationId).toBe(
      null,
    );
  });

  it('rechaza el cliente raíz de Prisma (fuera de una transacción)', async () => {
    const root = { ...txMock(), $transaction: jest.fn() };

    await expect(
      service.add(root as unknown as Prisma.TransactionClient, {
        type: 'thing.happened',
        aggregateType: 'thing',
        aggregateId: 't-1',
        payload: {},
      }),
    ).rejects.toThrow(/transacción/);
    expect(root.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('exige tipo y agregado', async () => {
    const tx = txMock();
    await expect(
      service.add(tx as unknown as Prisma.TransactionClient, {
        type: '',
        aggregateType: 'thing',
        aggregateId: 't-1',
        payload: {},
      }),
    ).rejects.toThrow(/type, aggregateType y aggregateId/);
  });
});
