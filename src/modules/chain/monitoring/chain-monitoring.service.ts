import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  ChainAlert,
  ChainEvent,
  Prisma,
  ReconciliationRun,
} from '@prisma/client';
import { AuditAction } from '@shared/audit/audit.actions';
import { AUDIT_TX_OPTIONS, AuditService } from '@shared/audit/audit.service';
import type { AuthenticatedUser } from '@shared/decorators/current-user.decorator';
import { toPage, toPrismaPage } from '@shared/dto/pagination-query.dto';
import { AppException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';
import type { Paginated } from '@shared/interfaces/api-response.interface';
import { PrismaService } from '@shared/prisma/prisma.service';
import { CHAIN_SETTINGS, type ChainSettings } from '../chain.config';
import type {
  ChainAlertLevel,
  ChainNetwork,
  ReconciliationDepth,
  ReconciliationScope,
} from '../chain.constants';
import type {
  ChainAlertDto,
  ChainAlertsQueryDto,
  ChainEventDto,
  ChainEventsQueryDto,
  ReconciliationRunDetailDto,
  ReconciliationRunDto,
  ReconciliationRunsQueryDto,
  StartReconciliationDto,
} from '../dto/chain.dto';
import {
  ReconciliationAlreadyRunning,
  ReconciliationRunsService,
} from '../reconciliation/reconciliation-runs.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const notFound = (message: string): AppException =>
  new AppException(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, message);

const conflict = (
  code: string,
  message: string,
  meta: Record<string, unknown> = {},
): AppException =>
  new AppException(HttpStatus.CONFLICT, code, message, [
    { field: null, message, meta },
  ]);

export function toChainEvent(row: ChainEvent): ChainEventDto {
  return {
    id: row.id,
    rpcEventId: row.rpcEventId,
    network: row.network as ChainNetwork,
    contractAddress: row.contractAddress,
    wineryId: row.wineryId,
    ledger: row.ledger,
    ledgerClosedAt: row.ledgerClosedAt.toISOString(),
    txHash: row.txHash,
    type: row.type,
    topics: Array.isArray(row.topics) ? (row.topics as unknown[]) : [],
    data:
      row.data && typeof row.data === 'object' && !Array.isArray(row.data)
        ? (row.data as Record<string, unknown>)
        : {},
    matchedTransactionId: row.matchedTransactionId,
    originatedBySystem: row.originatedBySystem,
    processedAt: row.processedAt.toISOString(),
  };
}

export function toChainAlert(row: ChainAlert): ChainAlertDto {
  return {
    id: row.id,
    code: row.code,
    level: row.level as ChainAlertLevel,
    subject: { type: row.subjectType, id: row.subjectId },
    wineryId: row.wineryId,
    expected: row.expected ?? null,
    actual: row.actual ?? null,
    message: row.message,
    runId: row.runId,
    detectedAt: row.detectedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolution: row.resolvedAt
      ? {
          by: row.resolvedBy ?? 'Sistema',
          note: row.resolutionNote ?? '',
          auto: row.resolvedAuto,
        }
      : null,
  };
}

export function toReconciliationRun(
  row: ReconciliationRun,
): ReconciliationRunDto {
  return {
    id: row.id,
    scope: row.scope as ReconciliationScope,
    subjectId: row.subjectId,
    trigger: row.trigger as ReconciliationRunDto['trigger'],
    depth: row.depth as ReconciliationDepth,
    status: row.status as ReconciliationRunDto['status'],
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    checks: row.checks,
    issuesOpened: row.issuesOpened,
    issuesAutoResolved: row.issuesAutoResolved,
  };
}

/** Orden de las alertas abiertas: primero lo más grave. */
const LEVEL_ORDER = Prisma.sql`CASE level WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END`;

/**
 * Back office · lo que vigila la cadena (contrato O3 §8.1 y §8.2): eventos
 * del indexador, conciliaciones y alertas. Solo lee y cambia estado en la
 * base; la conciliación la ejecuta el worker.
 */
@Injectable()
export class ChainMonitoringService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly runs: ReconciliationRunsService,
    @Inject(CHAIN_SETTINGS) private readonly settings: ChainSettings,
  ) {}

  // ── Eventos (§8.1) ───────────────────────────────────────────────────────

  async events(query: ChainEventsQueryDto): Promise<Paginated<ChainEventDto>> {
    const closedAt: Prisma.DateTimeFilter = {};
    if (query.from) closedAt.gte = new Date(query.from);
    if (query.to) closedAt.lte = new Date(query.to);
    const where: Prisma.ChainEventWhereInput = {
      ...(query.contract ? { contractAddress: query.contract } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.txHash ? { txHash: query.txHash } : {}),
      ...(query.unmatched === 'true' ? { originatedBySystem: false } : {}),
      ...(query.unmatched === 'false' ? { originatedBySystem: true } : {}),
      ...(query.from || query.to ? { ledgerClosedAt: closedAt } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.chainEvent.findMany({
        where,
        orderBy: [{ ledger: 'desc' }, { rpcEventId: 'desc' }],
        ...toPrismaPage(query),
      }),
      this.prisma.chainEvent.count({ where }),
    ]);
    return toPage(rows.map(toChainEvent), total, query);
  }

  // ── Alertas (§8.2) ───────────────────────────────────────────────────────

  async alerts(query: ChainAlertsQueryDto): Promise<Paginated<ChainAlertDto>> {
    const resolved = query.status === 'resolved';
    const where: Prisma.ChainAlertWhereInput = {
      resolvedAt: resolved ? { not: null } : null,
      ...(query.level ? { level: query.level } : {}),
      ...(query.code ? { code: query.code } : {}),
      ...(query.wineryId ? { wineryId: query.wineryId } : {}),
    };
    const { skip, take } = toPrismaPage(query);
    const filters: Prisma.Sql[] = [
      resolved
        ? Prisma.sql`resolved_at IS NOT NULL`
        : Prisma.sql`resolved_at IS NULL`,
    ];
    if (query.level) filters.push(Prisma.sql`level = ${query.level}`);
    if (query.code) filters.push(Prisma.sql`code = ${query.code}`);
    if (query.wineryId) {
      filters.push(Prisma.sql`winery_id = ${query.wineryId}::uuid`);
    }
    // Abiertas: por nivel y antigüedad; resueltas: las últimas primero
    const order = resolved
      ? Prisma.sql`resolved_at DESC, id DESC`
      : Prisma.sql`${LEVEL_ORDER}, detected_at ASC, id ASC`;
    const [ids, total] = await Promise.all([
      this.prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM chain_alerts
        WHERE ${Prisma.join(filters, ' AND ')}
        ORDER BY ${order}
        LIMIT ${take} OFFSET ${skip}`,
      this.prisma.chainAlert.count({ where }),
    ]);
    const rows = await this.prisma.chainAlert.findMany({
      where: { id: { in: ids.map((r) => r.id) } },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    return toPage(
      ids
        .map(({ id }) => byId.get(id))
        .filter((row): row is ChainAlert => row !== undefined)
        .map(toChainAlert),
      total,
      query,
    );
  }

  /** Resolver a mano, con una nota; ya resuelta → 409. */
  async resolveAlert(
    id: string,
    note: string,
    user: AuthenticatedUser,
  ): Promise<ChainAlertDto> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM chain_alerts WHERE id = ${id}::uuid FOR UPDATE`;
      const alert = await tx.chainAlert.findUnique({ where: { id } });
      if (!alert) throw notFound('La alerta no existe');
      if (alert.resolvedAt !== null) {
        throw conflict(
          ErrorCode.CHN_ALERT_ALREADY_RESOLVED,
          alert.resolvedAuto
            ? 'La alerta ya se cerró sola al desaparecer su causa'
            : 'La alerta ya estaba resuelta',
          {
            resolvedAt: alert.resolvedAt.toISOString(),
            auto: alert.resolvedAuto,
          },
        );
      }
      const actor = await tx.user.findUnique({
        where: { id: user.id },
        select: { fullName: true },
      });
      const updated = await tx.chainAlert.update({
        where: { id },
        data: {
          resolvedAt: new Date(),
          resolvedBy: actor?.fullName ?? user.id,
          resolutionNote: note,
          resolvedAuto: false,
        },
      });
      await this.audit.record(tx, {
        action: AuditAction.CHAIN_ALERT_RESOLVED,
        resource: { type: 'chain_alert', id },
        organizationId: alert.wineryId,
        before: { resolved: false },
        after: {
          resolved: true,
          code: alert.code,
          level: alert.level,
          subject: { type: alert.subjectType, id: alert.subjectId },
        },
        reason: note,
        actor: { userId: user.id },
      });
      return toChainAlert(updated);
    }, AUDIT_TX_OPTIONS);
  }

  // ── Conciliación (§8.2) ──────────────────────────────────────────────────

  async listRuns(
    query: ReconciliationRunsQueryDto,
  ): Promise<Paginated<ReconciliationRunDto>> {
    const where: Prisma.ReconciliationRunWhereInput = query.status
      ? { status: query.status }
      : {};
    const [rows, total] = await Promise.all([
      this.prisma.reconciliationRun.findMany({
        where,
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        ...toPrismaPage(query),
      }),
      this.prisma.reconciliationRun.count({ where }),
    ]);
    return toPage(rows.map(toReconciliationRun), total, query);
  }

  async run(id: string): Promise<ReconciliationRunDetailDto> {
    const row = await this.prisma.reconciliationRun.findUnique({
      where: { id },
      include: {
        alerts: { orderBy: [{ detectedAt: 'asc' }, { id: 'asc' }] },
      },
    });
    if (!row) throw notFound('La conciliación no existe');
    return {
      ...toReconciliationRun(row),
      alerts: row.alerts.map(toChainAlert),
    };
  }

  /** `202` con la ejecución `RUNNING`: el worker la ejecuta (outbox). */
  async startRun(
    dto: StartReconciliationDto,
    user: AuthenticatedUser,
  ): Promise<ReconciliationRunDto> {
    if (!this.settings.enabled) {
      throw conflict(
        ErrorCode.CHN_DISABLED,
        'La cadena no está configurada en este entorno',
      );
    }
    const subjectId = dto.scope === 'ALL' ? null : (dto.subjectId ?? null);
    if (dto.scope !== 'ALL') await this.assertSubject(dto.scope, subjectId);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const run = await this.runs.open(tx, {
          scope: dto.scope,
          subjectId,
          depth: dto.depth ?? 'FULL',
          trigger: 'MANUAL',
          requestedByUserId: user.id,
        });
        await this.audit.record(tx, {
          action: AuditAction.RECONCILIATION_RUN_STARTED,
          resource: { type: 'reconciliation_run', id: run.id },
          organizationId: null,
          after: {
            scope: run.scope,
            subjectId: run.subjectId,
            depth: run.depth,
            trigger: run.trigger,
          },
          actor: { userId: user.id },
        });
        return toReconciliationRun(run);
      }, AUDIT_TX_OPTIONS);
    } catch (error) {
      if (error instanceof ReconciliationAlreadyRunning) {
        throw conflict(ErrorCode.CHN_RECONCILIATION_RUNNING, error.message, {
          runId: error.runId,
        });
      }
      throw error;
    }
  }

  /** El contrato o la colección del alcance tienen que existir (→ 422). */
  private async assertSubject(
    scope: 'CONTRACT' | 'COLLECTION',
    subjectId: string | null,
  ): Promise<void> {
    const exists =
      subjectId !== null && UUID.test(subjectId)
        ? scope === 'CONTRACT'
          ? await this.prisma.nftContract.count({ where: { id: subjectId } })
          : await this.prisma.collection.count({ where: { id: subjectId } })
        : 0;
    if (exists > 0) return;
    const what = scope === 'CONTRACT' ? 'un contrato' : 'una colección';
    throw new AppException(
      HttpStatus.UNPROCESSABLE_ENTITY,
      ErrorCode.VALIDATION_ERROR,
      `subjectId debe ser el id de ${what} existente`,
      [
        {
          field: 'subjectId',
          message: `Con scope ${scope}, subjectId es el id de ${what}`,
        },
      ],
    );
  }
}
