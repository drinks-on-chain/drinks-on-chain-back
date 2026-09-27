import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import type { PrismaService } from '@shared/prisma/prisma.service';
import type { AuditService } from '@shared/audit/audit.service';
import { AuditQueryService } from '../audit-query.service';
import {
  AuditListQueryDto,
  OrganizationAuditQueryDto,
  isAuditDate,
  parseAuditDate,
} from '../dto/audit-query.dto';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

function setup() {
  const prisma = {
    auditEvent: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
  };
  const audit = {
    toView: jest.fn((row: { seq: bigint }) => ({ seq: Number(row.seq) })),
    verifyChain: jest
      .fn()
      .mockResolvedValue({ valid: true, checked: 3, firstBrokenSeq: null }),
  };
  const service = new AuditQueryService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
  );
  return { prisma, audit, service };
}

describe('Consulta de la bitácora', () => {
  describe('fechas de los filtros', () => {
    it('AAAA-MM-DD = día completo UTC; ISO tal cual', () => {
      expect(parseAuditDate('2026-09-27', 'from')?.toISOString()).toBe(
        '2026-09-27T00:00:00.000Z',
      );
      expect(parseAuditDate('2026-09-27', 'to')?.toISOString()).toBe(
        '2026-09-27T23:59:59.999Z',
      );
      expect(
        parseAuditDate('2026-09-27T10:00:00-04:00', 'from')?.toISOString(),
      ).toBe('2026-09-27T14:00:00.000Z');
      expect(parseAuditDate(undefined, 'from')).toBeUndefined();
    });

    it.each(['2026-13-01', 'ayer', '27/09/2026', '2026-09-27T10:00'])(
      'rechaza %p',
      (value) => {
        expect(isAuditDate(value)).toBe(false);
      },
    );

    it('valida los filtros con 422 por campo', () => {
      const dto = plainToInstance(AuditListQueryDto, {
        from: 'ayer',
        actorId: 'no-uuid',
        action: 'minúsculas',
        limit: '500',
      });
      const fields = validateSync(dto).map((e) => e.property);
      expect(fields.sort()).toEqual(['action', 'actorId', 'from', 'limit']);
    });

    it('la del dueño no acepta organizationId (sí wineryId)', () => {
      const dto = plainToInstance(OrganizationAuditQueryDto, {
        wineryId: ORG,
        action: 'SETTING_CHANGED',
      });
      expect(validateSync(dto)).toHaveLength(0);
      expect(dto.limit).toBe(20);
      expect('organizationId' in dto).toBe(false);
    });
  });

  it('where: combina los filtros', () => {
    const { service } = setup();
    expect(
      service.where({
        from: '2026-09-01',
        to: '2026-09-27',
        actorId: USER,
        organizationId: ORG,
        action: 'SETTING_CHANGED',
        resourceType: 'setting',
        resourceId: 'canje.ventanaDias',
      }),
    ).toEqual({
      occurredAt: {
        gte: new Date('2026-09-01T00:00:00.000Z'),
        lte: new Date('2026-09-27T23:59:59.999Z'),
      },
      actorUserId: USER,
      organizationId: ORG,
      action: 'SETTING_CHANGED',
      resourceType: 'setting',
      resourceId: 'canje.ventanaDias',
    });
    expect(service.where({})).toEqual({});
  });

  it('organizationWhere: lo que afecta a la organización o hicieron desde ella', () => {
    const { service } = setup();
    expect(service.organizationWhere(ORG, { action: 'X_Y' })).toEqual({
      AND: [
        { action: 'X_Y' },
        { OR: [{ organizationId: ORG }, { actorOrganizationId: ORG }] },
      ],
    });
  });

  it('list: seq descendente, con total', async () => {
    const { service, prisma } = setup();
    prisma.auditEvent.findMany.mockResolvedValue([
      { seq: BigInt(9) },
      { seq: BigInt(8) },
    ]);
    prisma.auditEvent.count.mockResolvedValue(42);
    await expect(
      service.list({ action: 'A_B' }, { limit: 2, offset: 4 }),
    ).resolves.toEqual({ items: [{ seq: 9 }, { seq: 8 }], total: 42 });
    expect(prisma.auditEvent.findMany).toHaveBeenCalledWith({
      where: { action: 'A_B' },
      orderBy: { seq: 'desc' },
      take: 2,
      skip: 4,
    });
  });

  it('batches: recorre por seq ascendente sin OFFSET', async () => {
    const { service, prisma } = setup();
    prisma.auditEvent.findMany
      .mockResolvedValueOnce([{ seq: BigInt(1) }, { seq: BigInt(2) }])
      .mockResolvedValueOnce([{ seq: BigInt(3) }]);
    const seen: number[] = [];
    for await (const batch of service.batches({ action: 'A_B' }, 2)) {
      seen.push(...batch.map((e) => e.seq));
    }
    expect(seen).toEqual([1, 2, 3]);
    expect(prisma.auditEvent.findMany).toHaveBeenLastCalledWith({
      where: { AND: [{ action: 'A_B' }, { seq: { gt: BigInt(2) } }] },
      orderBy: { seq: 'asc' },
      take: 2,
    });
  });

  describe('verify por fechas', () => {
    it('sin fechas verifica toda la cadena', async () => {
      const { service, audit } = setup();
      await service.verify({});
      expect(audit.verifyChain).toHaveBeenCalledWith(undefined, undefined);
    });

    it('traduce las fechas a seq', async () => {
      const { service, audit, prisma } = setup();
      prisma.auditEvent.findFirst
        .mockResolvedValueOnce({ seq: BigInt(10) })
        .mockResolvedValueOnce({ seq: BigInt(20) });
      await service.verify({ from: '2026-09-01', to: '2026-09-27' });
      expect(audit.verifyChain).toHaveBeenCalledWith(10, 20);
      expect(prisma.auditEvent.findFirst).toHaveBeenNthCalledWith(1, {
        where: { occurredAt: { gte: new Date('2026-09-01T00:00:00.000Z') } },
        orderBy: { seq: 'asc' },
        select: { seq: true },
      });
    });

    it('un tramo sin entradas es válido con 0 comprobadas', async () => {
      const { service, audit, prisma } = setup();
      prisma.auditEvent.findFirst.mockResolvedValueOnce(null);
      await expect(service.verify({ from: '2030-01-01' })).resolves.toEqual({
        valid: true,
        checked: 0,
        firstBrokenSeq: null,
      });
      expect(audit.verifyChain).not.toHaveBeenCalled();
    });
  });
});
