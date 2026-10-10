import type { PrismaService } from '@shared/prisma/prisma.service';
import type { AuditQueryService } from '@modules/audit/audit-query.service';
import type { ChainBalanceCache } from '@modules/chain/accounts/chain-balance-cache';
import type { ChainSettings } from '@modules/chain/chain.config';
import { DashboardService, buildAlerts } from '../dashboard.service';

const NOW = new Date('2026-09-27T12:00:00.000Z');

interface SetupData {
  applications?: boolean;
  waitlist?: boolean;
  tokenization?: { status: string; _count: { _all: number } }[];
  oldestRequest?: { submittedAt: Date } | null;
  collections?: Record<string, number>;
  shortfalls?: number;
  failedTransactions?: number;
  stuckTransactions?: number;
  chainAlerts?: { level: string; _count: { _all: number } }[];
  lastRun?: { finishedAt: Date; status: string } | null;
  cursor?: { updatedAt: Date } | null;
  balances?: Record<
    string,
    { address: string; balanceStroops: string | null; checkedAt: string }
  >;
}

function setup(data: SetupData = {}) {
  const prisma = {
    waitlistEntry: {
      groupBy: jest.fn().mockResolvedValue(
        data.waitlist
          ? [
              { type: 'CONSUMER', _count: { _all: 40 } },
              { type: 'WINERY', _count: { _all: 6 } },
            ]
          : [],
      ),
      count: jest.fn().mockResolvedValue(data.waitlist ? 12 : 0),
    },
    wineryApplication: {
      groupBy: jest.fn().mockResolvedValue(
        data.applications
          ? [
              { status: 'UNVERIFIED', _count: { _all: 1 } },
              { status: 'RECEIVED', _count: { _all: 3 } },
              { status: 'IN_REVIEW', _count: { _all: 2 } },
              { status: 'APPROVED', _count: { _all: 9 } },
            ]
          : [],
      ),
      count: jest.fn().mockResolvedValue(data.applications ? 2 : 0),
      findFirst: jest
        .fn()
        .mockResolvedValue(
          data.applications
            ? { createdAt: new Date('2026-09-20T08:00:00.000Z') }
            : null,
        ),
    },
    invitation: {
      count: jest.fn((args: { where: { expiresAt: { lte?: Date } } }) =>
        Promise.resolve(
          data.applications ? (args.where.expiresAt.lte ? 1 : 4) : 0,
        ),
      ),
    },
    winery: {
      groupBy: jest.fn().mockResolvedValue([
        { certificationStatus: 'ACTIVE', _count: 5 },
        { certificationStatus: 'SUSPENDED', _count: 1 },
        { certificationStatus: 'REVOKED', _count: 2 },
      ]),
    },
    membership: { count: jest.fn().mockResolvedValue(3) },
    emailMessage: {
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    // Ola 3 (contrato O3 §11): sin datos salvo que la prueba los ponga
    tokenizationRequest: {
      groupBy: jest.fn().mockResolvedValue(data.tokenization ?? []),
      findFirst: jest.fn().mockResolvedValue(data.oldestRequest ?? null),
    },
    collection: {
      count: jest.fn((args: { where: Record<string, string> }) =>
        Promise.resolve(data.collections?.[Object.values(args.where)[0]] ?? 0),
      ),
    },
    lotClosure: { count: jest.fn().mockResolvedValue(data.shortfalls ?? 0) },
    chainTransaction: {
      count: jest.fn((args: { where: { status: unknown } }) =>
        Promise.resolve(
          args.where.status === 'FAILED'
            ? (data.failedTransactions ?? 0)
            : (data.stuckTransactions ?? 0),
        ),
      ),
    },
    chainAlert: {
      groupBy: jest.fn().mockResolvedValue(data.chainAlerts ?? []),
    },
    reconciliationRun: {
      findFirst: jest.fn().mockResolvedValue(data.lastRun ?? null),
    },
    chainCursor: {
      findUnique: jest.fn().mockResolvedValue(data.cursor ?? null),
    },
  };
  const auditQuery = {
    recent: jest.fn().mockResolvedValue([{ seq: 10 }, { seq: 9 }]),
  };
  const service = new DashboardService(
    prisma as unknown as PrismaService,
    auditQuery as unknown as AuditQueryService,
    { network: 'TESTNET' } as ChainSettings,
    {
      read: jest
        .fn()
        .mockImplementation((role: string) =>
          Promise.resolve(data.balances?.[role] ?? null),
        ),
    } as unknown as ChainBalanceCache,
  );
  return { prisma, auditQuery, service };
}

describe('Tablero del back office', () => {
  it('tokenización y cadena: todo en cero sin solicitudes, colecciones ni transacciones (apertura de la Ola 3)', async () => {
    const { service } = setup();
    const view = await service.get(NOW);
    expect(view.tokenization).toEqual({
      submitted: 0,
      inReview: 0,
      changesRequested: 0,
      oldestOpenHours: 0,
      collectionsMinting: 0,
      mintFailures: 0,
      collectionsPublished: 0,
      shortfallsOpen: 0,
    });
    expect(view.chain).toEqual({
      network: 'TESTNET',
      operationsBalanceXlm: '0.0000000',
      anchorBalanceXlm: '0.0000000',
      failedTransactions: 0,
      stuckTransactions: 0,
      openAlerts: { critical: 0, warning: 0 },
      lastReconciliation: null,
      indexerLagSeconds: 0,
    });
  });

  it('tokenización y cadena: cuentan lo que hay en la base', async () => {
    const { service, prisma } = setup({
      tokenization: [
        { status: 'SUBMITTED', _count: { _all: 3 } },
        { status: 'IN_REVIEW', _count: { _all: 2 } },
        { status: 'CHANGES_REQUESTED', _count: { _all: 1 } },
      ],
      oldestRequest: { submittedAt: new Date('2026-09-25T06:30:00.000Z') },
      collections: { MINTING: 1, FAILED: 2, PUBLISHED: 4 },
      shortfalls: 1,
      failedTransactions: 2,
      stuckTransactions: 1,
      chainAlerts: [
        { level: 'CRITICAL', _count: { _all: 1 } },
        { level: 'WARNING', _count: { _all: 5 } },
        { level: 'INFO', _count: { _all: 9 } },
      ],
      lastRun: {
        finishedAt: new Date('2026-09-27T06:30:00.000Z'),
        status: 'DIFFERENCES',
      },
      cursor: { updatedAt: new Date('2026-09-27T11:58:30.000Z') },
    });
    const view = await service.get(NOW);
    expect(view.tokenization).toEqual({
      submitted: 3,
      inReview: 2,
      changesRequested: 1,
      oldestOpenHours: 53,
      collectionsMinting: 1,
      mintFailures: 2,
      collectionsPublished: 4,
      shortfallsOpen: 1,
    });
    expect(view.chain).toMatchObject({
      failedTransactions: 2,
      stuckTransactions: 1,
      openAlerts: { critical: 1, warning: 5 },
      lastReconciliation: {
        at: '2026-09-27T06:30:00.000Z',
        status: 'DIFFERENCES',
      },
      indexerLagSeconds: 90,
    });
    // Atascada = enviada o reintentando desde hace más de 15 min
    expect(prisma.chainTransaction.count).toHaveBeenCalledWith({
      where: {
        status: { in: ['SUBMITTED', 'RETRYING'] },
        updatedAt: { lt: new Date('2026-09-27T11:45:00.000Z') },
      },
    });
  });

  it('lista de espera: totales por tipo y altas de las últimas 24 h', async () => {
    const { service, prisma } = setup({ waitlist: true });
    const view = await service.get(NOW);
    expect(view.waitlist).toEqual({ consumers: 40, wineries: 6, last24h: 12 });
    expect(prisma.waitlistEntry.count).toHaveBeenCalledWith({
      where: { createdAt: { gte: new Date('2026-09-26T12:00:00.000Z') } },
    });
  });

  it('sin solicitudes ni invitaciones: ceros', async () => {
    const { service, auditQuery } = setup();
    const view = await service.get(NOW);
    expect(view).toEqual({
      applications: {
        unverified: 0,
        received: 0,
        inReview: 0,
        meetingScheduled: 0,
      },
      wineries: { invited: 0, active: 5, suspended: 1 },
      invitations: { pending: 0, expiringIn24h: 0 },
      team: { blockedMembers: 3 },
      waitlist: { consumers: 0, wineries: 0, last24h: 0 },
      tokenization: {
        submitted: 0,
        inReview: 0,
        changesRequested: 0,
        oldestOpenHours: 0,
        collectionsMinting: 0,
        mintFailures: 0,
        collectionsPublished: 0,
        shortfallsOpen: 0,
      },
      chain: {
        network: 'TESTNET',
        operationsBalanceXlm: '0.0000000',
        anchorBalanceXlm: '0.0000000',
        failedTransactions: 0,
        stuckTransactions: 0,
        openAlerts: { critical: 0, warning: 0 },
        lastReconciliation: null,
        indexerLagSeconds: 0,
      },
      alerts: [],
      recentAudit: [{ seq: 10 }, { seq: 9 }],
    });
    expect(auditQuery.recent).toHaveBeenCalledWith(5);
  });

  it('cuenta por estado con Prisma y avisa', async () => {
    const { service, prisma } = setup({ applications: true });
    prisma.emailMessage.count.mockResolvedValue(2);
    prisma.emailMessage.findFirst.mockResolvedValue({
      updatedAt: new Date('2026-09-26T10:00:00.000Z'),
    });
    const view = await service.get(NOW);
    expect(view.applications).toEqual({
      unverified: 1,
      received: 3,
      inReview: 2,
      meetingScheduled: 0,
    });
    expect(view.invitations).toEqual({ pending: 4, expiringIn24h: 1 });
    expect(view.alerts.map((a) => [a.id, a.level])).toEqual([
      ['emails-failed', 'CRITICAL'],
      ['applications-unassigned', 'WARNING'],
      ['invitations-expiring', 'INFO'],
    ]);
    expect(view.alerts[1]).toMatchObject({
      createdAt: '2026-09-20T08:00:00.000Z',
      link: '/solicitudes',
    });
    // Sin tomar más de 48 h: RECEIVED, sin asignar y anteriores al umbral
    expect(prisma.wineryApplication.count).toHaveBeenCalledWith({
      where: {
        status: 'RECEIVED',
        assigneeUserId: null,
        createdAt: { lt: new Date('2026-09-25T12:00:00.000Z') },
      },
    });
  });

  it('buildAlerts: singular y plural', () => {
    const alerts = buildAlerts(NOW, {
      applications: {
        counts: {
          unverified: 0,
          received: 1,
          inReview: 0,
          meetingScheduled: 0,
        },
        unassigned: { count: 1, oldest: null },
      },
      invitations: { pending: 3, expiringIn24h: 3 },
      emails: { count: 1, latest: null },
    });
    expect(alerts.map((a) => a.message)).toEqual([
      '1 correo no se pudo enviar en los últimos 7 días: revisa el servidor de correo.',
      '1 solicitud de alta lleva más de 48 h sin que nadie la tome.',
      '3 invitaciones caducan en menos de 24 h.',
    ]);
    expect(alerts.every((a) => a.createdAt === NOW.toISOString())).toBe(true);
  });

  it('buildAlerts: las alertas abiertas de la cadena entran por su nivel (contrato O3 §8.2)', () => {
    const quiet = {
      applications: {
        counts: {
          unverified: 0,
          received: 0,
          inReview: 0,
          meetingScheduled: 0,
        },
        unassigned: { count: 0, oldest: null },
      },
      invitations: { pending: 0, expiringIn24h: 0 },
      emails: { count: 0, latest: null },
    };
    expect(
      buildAlerts(NOW, { ...quiet, chain: { critical: 0, warning: 0 } }),
    ).toEqual([]);
    const alerts = buildAlerts(NOW, {
      ...quiet,
      chain: { critical: 2, warning: 1 },
    });
    expect(alerts.map((a) => [a.id, a.level, a.link])).toEqual([
      ['chain-alerts-critical', 'CRITICAL', '/cadena/alertas'],
      ['chain-alerts-warning', 'WARNING', '/cadena/alertas'],
    ]);
    expect(alerts[0].message).toBe(
      '2 alertas críticas de la cadena sin resolver: nada se corrige solo.',
    );
    expect(alerts[1].message).toBe('1 aviso de la cadena sin resolver.');
  });
});

describe('Tablero · saldos de la cadena (chain.balance.check)', () => {
  it('muestra la última lectura del worker; una cuenta que no existe en la red, cero', async () => {
    const checkedAt = NOW.toISOString();
    const { service } = setup({
      balances: {
        OPERATIONS: {
          address: `G${'A'.repeat(55)}`,
          balanceStroops: '98734512300',
          checkedAt,
        },
        ANCHOR: {
          address: `G${'B'.repeat(55)}`,
          balanceStroops: null,
          checkedAt,
        },
      },
    });
    const view = await service.get(NOW);
    expect(view.chain).toMatchObject({
      operationsBalanceXlm: '9873.4512300',
      anchorBalanceXlm: '0.0000000',
    });
  });
});
