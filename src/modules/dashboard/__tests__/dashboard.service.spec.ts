import type { PrismaService } from '@shared/prisma/prisma.service';
import type { AuditQueryService } from '@modules/audit/audit-query.service';
import { DashboardService, buildAlerts } from '../dashboard.service';

const NOW = new Date('2026-09-27T12:00:00.000Z');

function setup(tables: {
  applications?: boolean;
  invitations?: boolean;
  failQueries?: boolean;
}) {
  const queryRaw = jest.fn(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('to_regclass')) {
        const table = values[0];
        return Promise.resolve([
          {
            found:
              (table === 'winery_applications' && !!tables.applications) ||
              (table === 'invitations' && !!tables.invitations),
          },
        ]);
      }
      if (tables.failQueries) {
        return Promise.reject(new Error('column "status" does not exist'));
      }
      if (sql.includes('GROUP BY status')) {
        return Promise.resolve([
          { status: 'UNVERIFIED', total: 1 },
          { status: 'RECEIVED', total: 3 },
          { status: 'IN_REVIEW', total: 2 },
          { status: 'APPROVED', total: 9 },
        ]);
      }
      if (sql.includes('winery_applications')) {
        return Promise.resolve([
          { total: 2, oldest: new Date('2026-09-20T08:00:00.000Z') },
        ]);
      }
      if (sql.includes('FROM invitations')) {
        return Promise.resolve([{ pending: 4, expiring: 1 }]);
      }
      return Promise.resolve([]);
    },
  );
  const prisma = {
    $queryRaw: queryRaw,
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
  it('sin las tablas de solicitudes e invitaciones: ceros', async () => {
    const { service, auditQuery } = setup({});
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
      alerts: [],
      recentAudit: [{ seq: 10 }, { seq: 9 }],
    });
    expect(auditQuery.recent).toHaveBeenCalledWith(5);
  });

  it('con las tablas: cuenta por estado y avisa', async () => {
    const { service, prisma } = setup({
      applications: true,
      invitations: true,
    });
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
  });

  it('si la consulta de otra parte falla, cuenta cero sin romper el tablero', async () => {
    const { service } = setup({
      applications: true,
      invitations: true,
      failQueries: true,
    });
    const view = await service.get(NOW);
    expect(view.applications.received).toBe(0);
    expect(view.invitations.pending).toBe(0);
    expect(view.wineries.active).toBe(5);
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
