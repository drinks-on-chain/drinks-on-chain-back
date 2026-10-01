import type { PrismaService } from '@shared/prisma/prisma.service';
import type { AuditQueryService } from '@modules/audit/audit-query.service';
import { DashboardService, buildAlerts } from '../dashboard.service';

const NOW = new Date('2026-09-27T12:00:00.000Z');

function setup(data: { applications?: boolean; waitlist?: boolean } = {}) {
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
  };
  const auditQuery = {
    recent: jest.fn().mockResolvedValue([{ seq: 10 }, { seq: 9 }]),
  };
  const service = new DashboardService(
    prisma as unknown as PrismaService,
    auditQuery as unknown as AuditQueryService,
  );
  return { prisma, auditQuery, service };
}

describe('Tablero del back office', () => {
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
});
