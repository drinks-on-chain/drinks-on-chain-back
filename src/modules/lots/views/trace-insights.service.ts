import { Injectable } from '@nestjs/common';
import { LotStageEnum, PhytoStatusEnum, Prisma } from '@prisma/client';
import { PrismaService } from '@shared/prisma/prisma.service';
import { ErrorCode } from '@shared/exceptions/error-codes';
import { ValidationException } from '@shared/exceptions/validation.exception';
import { LOT_STAGES } from '../dto/lot.dto';
import { dateOnly } from '../domain/dates';
import type { LotLock } from '../domain/locks';
import {
  computeLotBalance,
  ProductionFigures,
  productionFigures,
  productionTotals,
  ProductionTotals,
} from '../domain/lot-balance';
import { parseLotRules } from '../domain/lot-rules';
import type { LotProductType, LotStage } from '../domain/lot-stage';
import { num } from '../domain/sources';
import { ruleError, violation } from '../domain/trace-errors';
import {
  LOT_VIEW_INCLUDE,
  lotLocks,
  LotSummaryView,
  toLotSummary,
} from '../lot-view';
import { dbClock } from '../trace-db';
import { balanceInputOf, LOT_FIGURES_INCLUDE } from './lot-chain';

/** Umbrales de las alertas de fermentación (S-18). */
export const FERMENTATION_MAX_TEMPERATURE_C = 32;
export const FERMENTATION_READING_GAP_HOURS = 48;
/** Candados que se liberan pronto (§11.2). */
export const LOCK_DUE_SOON_DAYS = 14;
/** Máximo de filas del reporte de producción (§11.4). */
export const PRODUCTION_REPORT_MAX_ROWS = 10_000;

type LabStatus = LotSummaryView['labStatus'];

export interface TraceDashboardView {
  lotsByStage: Record<LotStage, number>;
  locksDueSoon: {
    lotId: string;
    reference: string;
    name: string;
    lock: LotLock;
  }[];
  fermentationAlerts: {
    tankId: string;
    tankCode: string;
    lotId: string;
    kind: 'HIGH_TEMPERATURE' | 'NO_READING';
    value: number | null;
    lastReadingAt: string | null;
  }[];
  pendingPhyto: {
    harvestBatchId: string;
    harvestBatchCode: string;
    lotId: string | null;
    intakeDate: string;
    status: string;
  }[];
  bottledWithoutLab: LotSummaryView[];
  readyToClose: LotSummaryView[];
  complianceIssuesOpen: number;
  unassignedHarvestBatches: number;
}

export interface ProductionReportRow extends ProductionFigures {
  lotId: string;
  reference: string;
  lotCode: string | null;
  name: string;
  productType: LotProductType | null;
  harvestYear: number;
  stage: string;
  formatCl: number | null;
  bottlingDate: string | null;
  labStatus: LabStatus;
}

export interface ProductionReportView {
  rows: ProductionReportRow[];
  totals: Record<'WINE' | 'SINGANI' | 'UNDECIDED', ProductionTotals>;
}

export interface ProductionReportFilters {
  from?: string;
  to?: string;
  productType?: LotProductType;
  stage?: string;
}

/** Etapas con el lote aún en proceso (antes de embotellar y sin cerrar). */
const OPEN_STAGES: LotStageEnum[] = [
  LotStageEnum.ORIGIN,
  LotStageEnum.HARVEST,
  LotStageEnum.FERMENTING,
  LotStageEnum.AGING,
  LotStageEnum.DISTILLING,
  LotStageEnum.RESTING,
];

export const PRODUCTION_REPORT_COLUMNS = [
  'lotId',
  'reference',
  'lotCode',
  'name',
  'productType',
  'harvestYear',
  'stage',
  'netKg',
  'mustLiters',
  'baseWineLiters',
  'heartLiters',
  'bottledLiters',
  'bottles',
  'formatCl',
  'lossPercentFermentation',
  'lossPercentTransfer',
  'lossPercentDistillation',
  'lossPercentBottling',
  'litersPerKg',
  'bottlesPerTonne',
  'bottlingDate',
  'labStatus',
] as const;

/**
 * Celda de CSV: comillas si hace falta y un apóstrofo delante de lo que una
 * hoja de cálculo leería como fórmula (`= + - @`), salvo los números.
 */
export function csvCell(value: string | number | null): string {
  if (value === null) return '';
  if (typeof value === 'number') return String(value);
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** CSV del reporte (UTF-8 con BOM, coma, CRLF), con las columnas del JSON. */
export function productionReportCsv(
  rows: readonly ProductionReportRow[],
): string {
  const lines = [PRODUCTION_REPORT_COLUMNS.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.lotId,
        r.reference,
        r.lotCode,
        r.name,
        r.productType,
        r.harvestYear,
        r.stage,
        r.netKg,
        r.mustLiters,
        r.baseWineLiters,
        r.heartLiters,
        r.bottledLiters,
        r.bottles,
        r.formatCl,
        r.lossPercentByStage.fermentation,
        r.lossPercentByStage.transfer,
        r.lossPercentByStage.distillation,
        r.lossPercentByStage.bottling,
        r.litersPerKg,
        r.bottlesPerTonne,
        r.bottlingDate,
        r.labStatus,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `${UTF8_BOM}${lines.join('\r\n')}\r\n`;
}

/** Marca de orden de bytes: las hojas de cálculo leen así el CSV como UTF-8. */
const UTF8_BOM = String.fromCharCode(0xfeff);

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Instante en que empieza un día de calendario en America/La_Paz (UTC−4, sin horario de verano). */
function laPazDayStart(ymd: string): Date {
  return new Date(`${ymd}T04:00:00.000Z`);
}

/** Panel y reporte de producción de la bodega (contrato O2 §11.2 y §11.4). */
@Injectable()
export class TraceInsightsService {
  constructor(private readonly prisma: PrismaService) {}

  async dashboard(wineryId: string | undefined): Promise<TraceDashboardView> {
    const scope = wineryId ? { wineryId } : {};
    const { today, now } = await dbClock(this.prisma);

    const [byStage, lockLots, bottledLots, tanks, pending, issues, unassigned] =
      await Promise.all([
        this.prisma.lot.groupBy({
          by: ['stage'],
          where: scope,
          _count: { _all: true },
        }),
        this.prisma.lot.findMany({
          where: {
            ...scope,
            stage: {
              in: [
                LotStageEnum.AGING,
                LotStageEnum.DISTILLING,
                LotStageEnum.RESTING,
              ],
            },
          },
          include: LOT_VIEW_INCLUDE,
          orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        }),
        this.prisma.lot.findMany({
          where: { ...scope, stage: LotStageEnum.BOTTLED },
          include: LOT_VIEW_INCLUDE,
          orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        }),
        this.prisma.fermentationTank.findMany({
          where: {
            ...scope,
            status: 'FERMENTING',
            lot: { stage: { in: OPEN_STAGES } },
          },
          select: {
            id: true,
            tankCode: true,
            lotId: true,
            startDate: true,
            logs: {
              orderBy: { recordedAt: 'desc' },
              take: 1,
              select: { temperatureCelsius: true, recordedAt: true },
            },
          },
          orderBy: [{ startDate: 'asc' }, { id: 'asc' }],
        }),
        this.prisma.harvestBatch.findMany({
          where: {
            ...scope,
            phytosanitaryStatus: {
              in: [
                PhytoStatusEnum.PENDING_INSPECTION,
                PhytoStatusEnum.QUARANTINE,
              ],
            },
            OR: [{ lotId: null }, { lot: { stage: { in: OPEN_STAGES } } }],
          },
          select: {
            id: true,
            harvestBatchCode: true,
            lotId: true,
            intakeDate: true,
            phytosanitaryStatus: true,
          },
          orderBy: [{ intakeDate: 'asc' }, { id: 'asc' }],
        }),
        this.prisma.lotComplianceIssue.count({
          where: { resolvedAt: null, lot: scope },
        }),
        this.prisma.harvestBatch.count({ where: { ...scope, lotId: null } }),
      ]);

    const lotsByStage = Object.fromEntries(
      LOT_STAGES.map((stage) => [stage, 0]),
    ) as Record<LotStage, number>;
    for (const row of byStage) {
      lotsByStage[row.stage as LotStage] = row._count._all;
    }

    const locksDueSoon: TraceDashboardView['locksDueSoon'] = [];
    for (const lot of lockLots) {
      for (const lock of lotLocks(lot, parseLotRules(lot.rules), today)) {
        if (!lock.released && lock.daysRemaining <= LOCK_DUE_SOON_DAYS) {
          locksDueSoon.push({
            lotId: lot.id,
            reference: lot.reference,
            name: lot.name,
            lock,
          });
        }
      }
    }
    locksDueSoon.sort((a, b) =>
      a.lock.unlockDate.localeCompare(b.lock.unlockDate),
    );

    const gapMs = FERMENTATION_READING_GAP_HOURS * 3_600_000;
    const fermentationAlerts: TraceDashboardView['fermentationAlerts'] = [];
    for (const tank of tanks) {
      if (!tank.lotId) continue;
      const last = tank.logs[0] ?? null;
      const base = {
        tankId: tank.id,
        tankCode: tank.tankCode,
        lotId: tank.lotId,
        value: num(last?.temperatureCelsius),
        lastReadingAt: last ? last.recordedAt.toISOString() : null,
      };
      if (
        last &&
        last.temperatureCelsius.toNumber() > FERMENTATION_MAX_TEMPERATURE_C
      ) {
        fermentationAlerts.push({ ...base, kind: 'HIGH_TEMPERATURE' });
      }
      const since = last?.recordedAt ?? tank.startDate;
      if (now.getTime() - since.getTime() > gapMs) {
        fermentationAlerts.push({ ...base, kind: 'NO_READING' });
      }
    }

    const summaries = bottledLots.map((lot) => ({
      summary: toLotSummary(lot, today),
      // Fuentes abiertas (ni embotelladas ni descartadas): bloquean el cierre
      openSources:
        lot.wineAgingBatches.some(
          (a) => a.agingStatus === 'AGING' || a.agingStatus === 'READY',
        ) ||
        lot.productionBatches.some(
          (p) =>
            !p.discardedAt &&
            (p.restStatus === 'RESTING' || p.restStatus === 'READY'),
        ),
    }));

    return {
      lotsByStage,
      locksDueSoon,
      fermentationAlerts,
      pendingPhyto: pending.map((h) => ({
        harvestBatchId: h.id,
        harvestBatchCode: h.harvestBatchCode,
        lotId: h.lotId,
        intakeDate: dateOnly(h.intakeDate),
        status: h.phytosanitaryStatus,
      })),
      bottledWithoutLab: summaries
        .filter((s) => s.summary.labStatus === 'NOT_RECORDED')
        .map((s) => s.summary),
      readyToClose: summaries
        .filter(
          (s) =>
            s.summary.labStatus === 'CONFORMING' &&
            s.summary.dossierStatus === 'OPEN' &&
            s.summary.complianceIssuesOpen === 0 &&
            (s.summary.bottles ?? 0) > 0 &&
            !s.openSources,
        )
        .map((s) => s.summary),
      complianceIssuesOpen: issues,
      unassignedHarvestBatches: unassigned,
    };
  }

  /**
   * Reporte de producción (§11.4): una fila por lote (los más recientes
   * primero) y totales por tipo. Más de 10 000 filas → 422
   * `TRC_REPORT_TOO_LARGE`.
   */
  async productionReport(
    wineryId: string | undefined,
    filters: ProductionReportFilters,
  ): Promise<ProductionReportView> {
    const where: Prisma.LotWhereInput = { ...(wineryId && { wineryId }) };
    if (filters.productType) where.productType = filters.productType;
    if (filters.stage) {
      const stages = filters.stage
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const invalid = stages.filter(
        (s) => !(LOT_STAGES as readonly string[]).includes(s),
      );
      if (invalid.length > 0) {
        throw ValidationException.forField(
          'stage',
          `Etapas desconocidas: ${invalid.join(', ')} (válidas: ${LOT_STAGES.join(', ')})`,
        );
      }
      where.stage = { in: stages as LotStageEnum[] };
    }
    const from = filters.from?.slice(0, 10);
    const to = filters.to?.slice(0, 10);
    for (const [field, value] of [
      ['from', from],
      ['to', to],
    ] as const) {
      if (value !== undefined && !YMD.test(value)) {
        throw ValidationException.forField(
          field,
          `${field} debe ser una fecha YYYY-MM-DD`,
        );
      }
    }
    if (from && to && from > to) {
      throw ValidationException.forField(
        'from',
        'from no puede ser posterior a to',
      );
    }
    if (from || to) {
      where.createdAt = {
        ...(from && { gte: laPazDayStart(from) }),
        // Inclusive: hasta el final del día `to` en La Paz
        ...(to && {
          lt: new Date(laPazDayStart(to).getTime() + 86_400_000),
        }),
      };
    }

    const total = await this.prisma.lot.count({ where });
    if (total > PRODUCTION_REPORT_MAX_ROWS) {
      throw ruleError(
        ErrorCode.TRC_REPORT_TOO_LARGE,
        `El reporte tiene ${total} lotes y el máximo es ${PRODUCTION_REPORT_MAX_ROWS}: acota las fechas o los filtros`,
        [
          violation(
            ErrorCode.TRC_REPORT_TOO_LARGE,
            `${total} filas superan el máximo de ${PRODUCTION_REPORT_MAX_ROWS}`,
            {
              expected: PRODUCTION_REPORT_MAX_ROWS,
              actual: total,
              meta: { rows: total, maxRows: PRODUCTION_REPORT_MAX_ROWS },
            },
          ),
        ],
      );
    }

    const lots = await this.prisma.lot.findMany({
      where,
      include: LOT_FIGURES_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: PRODUCTION_REPORT_MAX_ROWS,
    });
    const rows: ProductionReportRow[] = lots.map((lot) => {
      const input = balanceInputOf(lot);
      const figures = productionFigures(
        input,
        computeLotBalance(input),
        lot.bottlingBatch?.totalBottlesPackaged ?? null,
      );
      const status = lot.bottlingBatch?.labAnalyses[0]?.conformityStatus;
      return {
        lotId: lot.id,
        reference: lot.reference,
        lotCode: lot.lotCode,
        name: lot.name,
        productType: lot.productType as LotProductType | null,
        harvestYear: lot.harvestYear,
        stage: lot.stage,
        ...figures,
        formatCl: lot.bottlingBatch?.packagingFormatCl ?? lot.plannedFormatCl,
        bottlingDate: lot.bottlingBatch
          ? dateOnly(lot.bottlingBatch.bottlingDate)
          : null,
        labStatus:
          status === 'CONFORMING' ||
          status === 'NON_CONFORMING' ||
          status === 'INCOMPLETE'
            ? status
            : 'NOT_RECORDED',
      };
    });
    const ofType = (type: LotProductType | null) =>
      productionTotals(rows.filter((r) => r.productType === type));
    return {
      rows,
      totals: {
        WINE: ofType('WINE'),
        SINGANI: ofType('SINGANI'),
        UNDECIDED: ofType(null),
      },
    };
  }
}
