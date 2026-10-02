import { Injectable } from '@nestjs/common';
import {
  EmailStatusEnum,
  InvitationStatusEnum,
  MembershipStatusEnum,
  Prisma,
  WaitlistTypeEnum,
  WineryApplicationStatusEnum,
} from '@prisma/client';
import { PrismaService } from '@shared/prisma/prisma.service';
import type { AuditEventView } from '@shared/audit/audit.types';
import { AuditQueryService } from '@modules/audit/audit-query.service';

export type AlertLevel = 'INFO' | 'WARNING' | 'CRITICAL';

export interface DashboardAlert {
  /** Estable por tipo de alerta (el cliente puede recordar las descartadas). */
  id: string;
  level: AlertLevel;
  message: string;
  createdAt: string;
  /** Ruta sugerida dentro del back office, o `null`. */
  link: string | null;
}

/** Tablero del back office (contrato O1 §8, PLT-06). */
export interface DashboardView {
  applications: {
    unverified: number;
    received: number;
    inReview: number;
    meetingScheduled: number;
  };
  wineries: { invited: number; active: number; suspended: number };
  invitations: { pending: number; expiringIn24h: number };
  team: { blockedMembers: number };
  /** Lista de espera (contrato O1b §2): totales por tipo y altas de las últimas 24 h. */
  waitlist: { consumers: number; wineries: number; last24h: number };
  alerts: DashboardAlert[];
  recentAudit: AuditEventView[];
}

/** Solicitudes sin tomar (`RECEIVED`) más tiempo que esto → alerta. */
export const UNASSIGNED_APPLICATION_ALERT_HOURS = 48;
/** Correos fallidos de los últimos días que cuentan para la alerta. */
export const FAILED_EMAIL_ALERT_DAYS = 7;

const HOUR_MS = 3_600_000;

interface ApplicationStats {
  counts: DashboardView['applications'];
  unassigned: { count: number; oldest: Date | null };
}

interface InvitationStats {
  pending: number;
  expiringIn24h: number;
}

/**
 * Tablero del back office (contrato O1 §8, PLT-06): solicitudes de alta por
 * estado, bodegas por estado, invitaciones pendientes y a punto de caducar,
 * miembros bloqueados, lista de espera, alertas y los últimos eventos de la
 * bitácora, con consultas tipadas de Prisma sobre los modelos de la Ola 1.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditQuery: AuditQueryService,
  ) {}

  async get(now: Date = new Date()): Promise<DashboardView> {
    const [
      applications,
      invitations,
      wineries,
      blockedMembers,
      emails,
      recent,
      waitlist,
    ] = await Promise.all([
      this.applicationStats(now),
      this.invitationStats(now),
      this.wineryCounts(),
      this.prisma.membership.count({
        where: { status: MembershipStatusEnum.BLOCKED },
      }),
      this.failedEmails(now),
      this.auditQuery.recent(5),
      this.waitlistStats(now),
    ]);

    return {
      applications: applications.counts,
      wineries,
      invitations,
      team: { blockedMembers },
      waitlist,
      alerts: buildAlerts(now, { applications, invitations, emails }),
      recentAudit: recent,
    };
  }

  private async waitlistStats(now: Date): Promise<DashboardView['waitlist']> {
    const [byType, last24h] = await Promise.all([
      this.prisma.waitlistEntry.groupBy({
        by: ['type'],
        _count: { _all: true },
      }),
      this.prisma.waitlistEntry.count({
        where: { createdAt: { gte: new Date(now.getTime() - 24 * HOUR_MS) } },
      }),
    ]);
    const count = (type: WaitlistTypeEnum) =>
      byType.find((g) => g.type === type)?._count._all ?? 0;
    return {
      consumers: count(WaitlistTypeEnum.CONSUMER),
      wineries: count(WaitlistTypeEnum.WINERY),
      last24h,
    };
  }

  private async wineryCounts(): Promise<DashboardView['wineries']> {
    const groups = await this.prisma.winery.groupBy({
      by: ['certificationStatus'],
      _count: true,
    });
    const count = (status: string) =>
      groups.find((g) => g.certificationStatus === status)?._count ?? 0;
    return {
      invited: count('INVITED'),
      active: count('ACTIVE'),
      suspended: count('SUSPENDED'),
    };
  }

  private async failedEmails(
    now: Date,
  ): Promise<{ count: number; latest: Date | null }> {
    const since = new Date(
      now.getTime() - FAILED_EMAIL_ALERT_DAYS * 24 * HOUR_MS,
    );
    const where = {
      status: EmailStatusEnum.FAILED,
      updatedAt: { gte: since },
    };
    const [count, latest] = await Promise.all([
      this.prisma.emailMessage.count({ where }),
      this.prisma.emailMessage.findFirst({
        where,
        orderBy: { updatedAt: 'desc' },
        select: { updatedAt: true },
      }),
    ]);
    return { count, latest: latest?.updatedAt ?? null };
  }

  private async applicationStats(now: Date): Promise<ApplicationStats> {
    const threshold = new Date(
      now.getTime() - UNASSIGNED_APPLICATION_ALERT_HOURS * HOUR_MS,
    );
    const unassignedWhere: Prisma.WineryApplicationWhereInput = {
      status: WineryApplicationStatusEnum.RECEIVED,
      assigneeUserId: null,
      createdAt: { lt: threshold },
    };
    const [byStatus, unassigned, oldest] = await Promise.all([
      this.prisma.wineryApplication.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      this.prisma.wineryApplication.count({ where: unassignedWhere }),
      this.prisma.wineryApplication.findFirst({
        where: unassignedWhere,
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
    ]);
    const count = (status: WineryApplicationStatusEnum) =>
      byStatus.find((r) => r.status === status)?._count._all ?? 0;
    return {
      counts: {
        unverified: count(WineryApplicationStatusEnum.UNVERIFIED),
        received: count(WineryApplicationStatusEnum.RECEIVED),
        inReview: count(WineryApplicationStatusEnum.IN_REVIEW),
        meetingScheduled: count(WineryApplicationStatusEnum.MEETING_SCHEDULED),
      },
      unassigned: { count: unassigned, oldest: oldest?.createdAt ?? null },
    };
  }

  /** Una invitación `PENDING` ya vencida cuenta como caducada (contrato O1 §2). */
  private async invitationStats(now: Date): Promise<InvitationStats> {
    const in24h = new Date(now.getTime() + 24 * HOUR_MS);
    const [pending, expiringIn24h] = await Promise.all([
      this.prisma.invitation.count({
        where: { status: InvitationStatusEnum.PENDING, expiresAt: { gt: now } },
      }),
      this.prisma.invitation.count({
        where: {
          status: InvitationStatusEnum.PENDING,
          expiresAt: { gt: now, lte: in24h },
        },
      }),
    ]);
    return { pending, expiringIn24h };
  }
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Alertas del tablero (una por tipo, de la más grave a la menos): correos
 * fallidos, solicitudes sin tomar más de 48 h e invitaciones que caducan en
 * menos de 24 h. Se añaden más tipos con sus olas.
 */
export function buildAlerts(
  now: Date,
  data: {
    applications: ApplicationStats;
    invitations: InvitationStats;
    emails: { count: number; latest: Date | null };
  },
): DashboardAlert[] {
  const alerts: DashboardAlert[] = [];
  if (data.emails.count > 0) {
    alerts.push({
      id: 'emails-failed',
      level: 'CRITICAL',
      message: `${plural(data.emails.count, 'correo no se pudo enviar', 'correos no se pudieron enviar')} en los últimos ${FAILED_EMAIL_ALERT_DAYS} días: revisa el servidor de correo.`,
      createdAt: (data.emails.latest ?? now).toISOString(),
      link: null,
    });
  }
  if (data.applications.unassigned.count > 0) {
    alerts.push({
      id: 'applications-unassigned',
      level: 'WARNING',
      message: `${plural(data.applications.unassigned.count, 'solicitud de alta lleva', 'solicitudes de alta llevan')} más de ${UNASSIGNED_APPLICATION_ALERT_HOURS} h sin que nadie la tome.`,
      createdAt: (data.applications.unassigned.oldest ?? now).toISOString(),
      link: '/solicitudes',
    });
  }
  if (data.invitations.expiringIn24h > 0) {
    alerts.push({
      id: 'invitations-expiring',
      level: 'INFO',
      message: `${plural(data.invitations.expiringIn24h, 'invitación caduca', 'invitaciones caducan')} en menos de 24 h.`,
      createdAt: now.toISOString(),
      link: '/bodegas',
    });
  }
  return alerts;
}
