import { AuditService } from '../audit.service';
import { computeAuditHash } from '../audit-hash';
import {
  emptyRequestContext,
  runWithRequestContext,
} from '@shared/context/request-context';
import type { PrismaService } from '@shared/prisma/prisma.service';

type Row = Record<string, unknown> & { seq: bigint; hash: string };

/** Transacción simulada con una tabla en memoria. */
function fakeTx(rows: Row[]) {
  return {
    $executeRaw: jest.fn().mockResolvedValue(1),
    auditEvent: {
      findFirst: jest.fn(async () => {
        const last = rows[rows.length - 1];
        return last ? { seq: last.seq, hash: last.hash } : null;
      }),
      create: jest.fn(async ({ data }: { data: Row }) => {
        rows.push(data);
        return data;
      }),
    },
  };
}

describe('AuditService.record', () => {
  const service = new AuditService({} as PrismaService);

  it('rechaza el cliente raíz de Prisma', async () => {
    await expect(
      service.record({ $transaction: jest.fn() } as never, {
        action: 'TEST_ACTION',
        resource: { type: 't' },
      }),
    ).rejects.toThrow(/transacción/);
  });

  it('rechaza acciones que no son UPPER_SNAKE_CASE', async () => {
    await expect(
      service.record(fakeTx([]) as never, {
        action: 'winery.approved',
        resource: { type: 'winery' },
      }),
    ).rejects.toThrow(/Acción/);
  });

  it('toma el candado, numera y encadena las entradas', async () => {
    const rows: Row[] = [];
    const tx = fakeTx(rows);
    await service.record(tx as never, {
      action: 'TEST_ONE',
      resource: { type: 'thing', id: '1' },
    });
    await service.record(tx as never, {
      action: 'TEST_TWO',
      resource: { type: 'thing', id: '2' },
    });

    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(rows.map((r) => r.seq)).toEqual([BigInt(1), BigInt(2)]);
    expect(rows[0].prevHash).toBeNull();
    expect(rows[1].prevHash).toBe(rows[0].hash);
    // El hash guardado corresponde al contenido
    const second = rows[1];
    expect(
      computeAuditHash({
        ...(second as unknown as Parameters<typeof computeAuditHash>[0]),
        seq: 2,
        occurredAt: (second.occurredAt as Date).toISOString(),
        before: null,
        after: null,
      }),
    ).toBe(second.hash);
  });

  it('toma actor, origen y correlación del contexto de la petición', async () => {
    const rows: Row[] = [];
    const ctx = emptyRequestContext({
      correlationId: 'corr-1',
      userId: '11111111-1111-1111-1111-111111111111',
      userFullName: 'Ana',
      organizationId: '22222222-2222-2222-2222-222222222222',
      organizationType: 'PLATFORM',
      role: 'ADMIN',
      sessionId: 'sid-1',
      ip: '10.0.0.9',
      clientApp: 'BACKOFFICE',
    });
    await runWithRequestContext(ctx, () =>
      service.record(fakeTx(rows) as never, {
        action: 'WINERY_APPROVED',
        resource: { type: 'winery', id: 'w1' },
        organizationId: '33333333-3333-3333-3333-333333333333',
        before: { status: 'PENDING', passwordHash: 'x' },
        after: { status: 'ACTIVE' },
        reason: 'Documentación completa',
      }),
    );
    expect(rows[0]).toMatchObject({
      actorUserId: ctx.userId,
      actorFullName: 'Ana',
      actorRole: 'ADMIN',
      actorOrganizationId: ctx.organizationId,
      actorViaPlatform: true,
      sourceApp: 'BACKOFFICE',
      sourceIp: '10.0.0.9',
      sessionId: 'sid-1',
      correlationId: 'corr-1',
      organizationId: '33333333-3333-3333-3333-333333333333',
      before: { status: 'PENDING', passwordHash: '[REDACTED]' },
      after: { status: 'ACTIVE' },
      reason: 'Documentación completa',
    });
  });

  it('actor null = sistema aunque haya contexto', async () => {
    const rows: Row[] = [];
    await runWithRequestContext({ userId: 'u1', clientApp: 'ERP' }, () =>
      service.record(fakeTx(rows) as never, {
        action: 'SYSTEM_TASK_DONE',
        resource: { type: 'task' },
        actor: null,
      }),
    );
    expect(rows[0]).toMatchObject({
      actorUserId: null,
      actorViaPlatform: false,
      sourceApp: 'ERP',
    });
  });
});
