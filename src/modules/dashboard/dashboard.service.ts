import { Injectable, Logger } from '@nestjs/common';
import { EmailStatusEnum, MembershipStatusEnum } from '@prisma/client';
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

const NO_APPLICATIONS: ApplicationStats = {
  counts: { unverified: 0, received: 0, inReview: 0, meetingScheduled: 0 },
  unassigned: { count: 0, oldest: null },
};

/**
 * Tablero del back office. Cuenta sobre lo que existe hoy en el modelo:
 *
 * - Solicitudes de alta (`winery_applications`) e invitaciones
 *   (`invitations`) llegan con otras partes de la Ola 1 (O1-BE-1 A y B): se
 *   leen con SQL solo si la tabla existe (`to_regclass`) y con las columnas
 *   del contrato (`status`, `created_at`, `expires_at`). Mientras no exista,
 *   o si la consulta falla, cuentan cero (y se avisa en los logs).
 * - Bodegas por estado, miembros bloqueados, correos fallidos y los últimos
 *   eventos de la bitácora salen del modelo actual.
 */
@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

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
    ] = await Promise.all([
      this.applicationStats(now),
      this.invitationStats(now),
      this.wineryCounts(),
      this.prisma.membership.count({
        where: { status: MembershipStatusEnum.BLOCKED },
      }),
      this.failedEmails(now),
      this.auditQuery.recent(5),
    ]);

    return {
      applications: applications.counts,
      wineries,
      invitations,
      team: { blockedMembers },
      alerts: buildAlerts(now, { applications, invitations, emails }),
      recentAudit: recent,
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

  /** ¿Existe la tabla? (las de otras partes de la ola pueden no existir aún). */
  private async tableExists(table: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ found: boolean }[]>`
      SELECT to_regclass(${table}::text) IS NOT NULL AS found`;
    return rows[0]?.found === true;
  }

  private async applicationStats(now: Date): Promise<ApplicationStats> {
    try {
      if (!(await this.tableExists('winery_applications'))) {
        return NO_APPLICATIONS;
      }
      const threshold = new Date(
        now.getTime() - UNASSIGNED_APPLICATION_ALERT_HOURS * HOUR_MS,
      );
      const [byStatus, unassigned] = await Promise.all([
        this.prisma.$queryRaw<{ status: string; total: number }[]>`
          SELECT status::text AS status, count(*)::int AS total
          FROM winery_applications GROUP BY status`,
        this.prisma.$queryRaw<{ total: number; oldest: Date | null }[]>`
          SELECT count(*)::int AS total, min(created_at) AS oldest
          FROM winery_applications
          WHERE status::text = 'RECEIVED' AND created_at < ${threshold}`,
      ]);
      const count = (status: string) =>
        byStatus.find((r) => r.status === status)?.total ?? 0;
      return {
        counts: {
          unverified: count('UNVERIFIED'),
          received: count('RECEIVED'),
          inReview: count('IN_REVIEW'),
          meetingScheduled: count('MEETING_SCHEDULED'),
        },
        unassigned: {
          count: unassigned[0]?.total ?? 0,
          oldest: unassigned[0]?.oldest ?? null,
        },
      };
    } catch (error) {
      this.logger.warn({
        message: 'Tablero: no se pudieron contar las solicitudes de alta',
        error: error instanceof Error ? error.message : String(error),
      });
      return NO_APPLICATIONS;
    }
  }

  private async invitationStats(now: Date): Promise<InvitationStats> {
    try {
      if (!(await this.tableExists('invitations'))) {
        return { pending: 0, expiringIn24h: 0 };
      }
      const in24h = new Date(now.getTime() + 24 * HOUR_MS);
      // Una invitación PENDING ya vencida cuenta como caducada (contrato O1 §2)
      const rows = await this.prisma.$queryRaw<
        { pending: number; expiring: number }[]
      >`
        SELECT
          count(*) FILTER (WHERE expires_at > ${now})::int AS pending,
          count(*) FILTER (WHERE expires_at > ${now} AND expires_at <= ${in24h})::int AS expiring
        FROM invitations
        WHERE status::text = 'PENDING'`;
      return {
        pending: rows[0]?.pending ?? 0,
        expiringIn24h: rows[0]?.expiring ?? 0,
      };
    } catch (error) {
      this.logger.warn({
        message: 'Tablero: no se pudieron contar las invitaciones',
        error: error instanceof Error ? error.message : String(error),
      });
      return { pending: 0, expiringIn24h: 0 };
    }
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
