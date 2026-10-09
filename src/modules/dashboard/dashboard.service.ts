import { Inject, Injectable } from '@nestjs/common';
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
import {
  CHAIN_SETTINGS,
  type ChainSettings,
} from '@modules/chain/chain.config';
import { ChainBalanceCache } from '@modules/chain/accounts/chain-balance-cache';
import { stroopsToXlm } from '@modules/chain/tx/chain-tx.mapper';
import type {
  ChainNetwork,
  RECONCILIATION_STATUSES,
} from '@modules/chain/chain.constants';
import { OPEN_TOKENIZATION_REQUEST_STATUSES } from '@modules/tokenization/tokenization.constants';

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
  /** Tokenización (contrato O3 §11): bandeja, emisiones y faltantes. */
  tokenization: {
    submitted: number;
    inReview: number;
    changesRequested: number;
    oldestOpenHours: number;
    collectionsMinting: number;
    mintFailures: number;
    collectionsPublished: number;
    shortfallsOpen: number;
  };
  /** Cadena (contrato O3 §11): saldos, transacciones, alertas e indexador. */
  chain: {
    network: ChainNetwork;
    operationsBalanceXlm: string;
    anchorBalanceXlm: string;
    failedTransactions: number;
    stuckTransactions: number;
    openAlerts: { critical: number; warning: number };
    lastReconciliation: {
      at: string;
      status: (typeof RECONCILIATION_STATUSES)[number];
    } | null;
    indexerLagSeconds: number;
  };
  alerts: DashboardAlert[];
  recentAudit: AuditEventView[];
}

/** Solicitudes sin tomar (`RECEIVED`) más tiempo que esto → alerta. */
export const UNASSIGNED_APPLICATION_ALERT_HOURS = 48;
/** Correos fallidos de los últimos días que cuentan para la alerta. */
export const FAILED_EMAIL_ALERT_DAYS = 7;

const HOUR_MS = 3_600_000;
/** Una transacción enviada y sin confirmar más tiempo que esto está atascada (§8.2, `TX_STUCK`). */
export const STUCK_TRANSACTION_MINUTES = 15;
/** Saldo de una cuenta que aún no se ha leído de la red. */
const UNKNOWN_BALANCE_XLM = '0.0000000';

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
    @Inject(CHAIN_SETTINGS) private readonly chainSettings: ChainSettings,
    private readonly chainBalances: ChainBalanceCache,
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
      tokenization,
      chain,
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
      this.tokenizationStats(now),
      this.chainStats(now),
    ]);

    return {
      applications: applications.counts,
      wineries,
      invitations,
      team: { blockedMembers },
      waitlist,
      tokenization,
      chain,
      alerts: buildAlerts(now, { applications, invitations, emails }),
      recentAudit: recent,
    };
  }

  /**
   * Bloque `tokenization` (contrato O3 §11): cuentas reales sobre las tablas
   * de la Ola 3. Todo cero mientras no haya solicitudes ni colecciones.
   */
  private async tokenizationStats(
    now: Date,
  ): Promise<DashboardView['tokenization']> {
    const open = { in: [...OPEN_TOKENIZATION_REQUEST_STATUSES] };
    const [byStatus, oldest, minting, failures, published, shortfalls] =
      await Promise.all([
        this.prisma.tokenizationRequest.groupBy({
          by: ['status'],
          where: { status: open },
          _count: { _all: true },
        }),
        this.prisma.tokenizationRequest.findFirst({
          where: { status: open },
          orderBy: { submittedAt: 'asc' },
          select: { submittedAt: true },
        }),
        this.prisma.collection.count({ where: { status: 'MINTING' } }),
        this.prisma.collection.count({ where: { mintStatus: 'FAILED' } }),
        this.prisma.collection.count({ where: { status: 'PUBLISHED' } }),
        this.prisma.lotClosure.count({ where: { status: 'SHORTFALL_OPEN' } }),
      ]);
    const count = (status: string) =>
      byStatus.find((g) => g.status === status)?._count._all ?? 0;
    return {
      submitted: count('SUBMITTED'),
      inReview: count('IN_REVIEW'),
      changesRequested: count('CHANGES_REQUESTED'),
      oldestOpenHours: oldest
        ? Math.max(
            0,
            Math.floor(
              (now.getTime() - oldest.submittedAt.getTime()) / HOUR_MS,
            ),
          )
        : 0,
      collectionsMinting: minting,
      mintFailures: failures,
      collectionsPublished: published,
      shortfallsOpen: shortfalls,
    };
  }

  /**
   * Bloque `chain` (contrato O3 §11): transacciones, alertas y conciliación
   * salen de la base. Los saldos son la última lectura de la tarea
   * `chain.balance.check` del worker (cero si aún no hay ninguna); el retraso
   * del indexador lo escribe `chain.indexer.poll` (paso 3.6).
   */
  private async chainStats(now: Date): Promise<DashboardView['chain']> {
    const stuckBefore = new Date(
      now.getTime() - STUCK_TRANSACTION_MINUTES * 60_000,
    );
    const { network } = this.chainSettings;
    const balanceXlm = async (role: 'OPERATIONS' | 'ANCHOR') => {
      const reading = await this.chainBalances.read(role);
      return reading?.balanceStroops
        ? stroopsToXlm(BigInt(reading.balanceStroops))
        : UNKNOWN_BALANCE_XLM;
    };
    const [operationsBalanceXlm, anchorBalanceXlm] = await Promise.all([
      balanceXlm('OPERATIONS'),
      balanceXlm('ANCHOR'),
    ]);
    const [failed, stuck, alerts, lastRun, cursor] = await Promise.all([
      this.prisma.chainTransaction.count({
        where: { status: 'FAILED', abandonedAt: null },
      }),
      this.prisma.chainTransaction.count({
        where: {
          status: { in: ['SUBMITTED', 'RETRYING'] },
          updatedAt: { lt: stuckBefore },
        },
      }),
      this.prisma.chainAlert.groupBy({
        by: ['level'],
        where: { resolvedAt: null },
        _count: { _all: true },
      }),
      this.prisma.reconciliationRun.findFirst({
        where: { finishedAt: { not: null } },
        orderBy: { finishedAt: 'desc' },
        select: { finishedAt: true, status: true },
      }),
      this.prisma.chainCursor.findUnique({
        where: { network_name: { network, name: 'events' } },
        select: { updatedAt: true },
      }),
    ]);
    const level = (name: string) =>
      alerts.find((g) => g.level === name)?._count._all ?? 0;
    return {
      network,
      operationsBalanceXlm,
      anchorBalanceXlm,
      failedTransactions: failed,
      stuckTransactions: stuck,
      openAlerts: { critical: level('CRITICAL'), warning: level('WARNING') },
      lastReconciliation: lastRun?.finishedAt
        ? {
            at: lastRun.finishedAt.toISOString(),
            status: lastRun.status as (typeof RECONCILIATION_STATUSES)[number],
          }
        : null,
      indexerLagSeconds: cursor
        ? Math.max(
            0,
            Math.floor((now.getTime() - cursor.updatedAt.getTime()) / 1000),
          )
        : 0,
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
