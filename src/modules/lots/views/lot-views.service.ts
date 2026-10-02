import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@shared/prisma/prisma.service';
import type { AuthenticatedUser } from '@shared/decorators/current-user.decorator';
import { PLATFORM_WINERY_READERS } from '@modules/organizations/organization.constants';
import { LotsService } from '../lots.service';
import { computeLotBalance, LotBalance } from '../domain/lot-balance';
import { dateOnly, laPazDate } from '../domain/dates';
import { isLateEntry } from '../domain/late-entry';
import { agingLock, LotLock, restLock } from '../domain/locks';
import { parseLotRules } from '../domain/lot-rules';
import type { LotProductType } from '../domain/lot-stage';
import { num } from '../domain/sources';
import { lotNotFound } from '../domain/trace-errors';
import type { LotEventType } from '../lot-events';
import { actorOf, resolveTraceActors, TraceActor } from '../trace-actors';
import { dbClock } from '../trace-db';
import {
  balanceInputOf,
  distillationCuts,
  LOT_FIGURES_INCLUDE,
  storedBottlingBalance,
} from './lot-chain';

export interface LotEventView {
  id: string;
  seq: number;
  type: LotEventType;
  occurredAt: string;
  recordedAt: string;
  lateEntry: boolean;
  stage: string;
  actor: TraceActor | null;
  summary: string;
  data: Record<string, unknown>;
  resource: { type: string; id: string };
  visibility: 'PUBLIC' | 'INTERNAL';
  corrected: boolean;
}

export interface LotTimelineView {
  events: LotEventView[];
  locks: LotLock[];
  estimatedReadyDate: string | null;
  estimatedReadyBasis: 'LOCK' | 'DECLARED' | null;
}

type GraphNodeType =
  | 'TERROIR'
  | 'HARVEST_BATCH'
  | 'TANK'
  | 'WINE_AGING'
  | 'DISTILLATION'
  | 'BOTTLING'
  | 'LAB_ANALYSIS';

interface GraphMetric {
  key: string;
  label: string;
  value: number | string | null;
  unit: string | null;
}

export interface LotGraphNode {
  id: string;
  type: GraphNodeType;
  label: string;
  occurredAt: string;
  recordedAt: string;
  quantity: { value: number; unit: 'kg' | 'L' | 'bottles' } | null;
  metrics: GraphMetric[];
  actor: TraceActor | null;
  status: string;
  corrected: boolean;
}

export interface LotGraphEdge {
  from: string;
  to: string;
  quantity: { value: number; unit: 'kg' | 'L' } | null;
}

export interface LotGraphView {
  lotId: string;
  lotCode: string | null;
  productType: LotProductType | null;
  nodes: LotGraphNode[];
  edges: LotGraphEdge[];
}

const GRAPH_INCLUDE = {
  harvestBatches: {
    orderBy: [{ intakeDate: 'asc' }, { createdAt: 'asc' }],
    include: {
      terroir: true,
      maturityAnalyses: {
        where: { voidedAt: null },
        orderBy: { measuredAt: 'desc' },
        take: 1,
      },
    },
  },
  fermentationTanks: {
    orderBy: [{ startDate: 'asc' }, { createdAt: 'asc' }],
    include: {
      inputs: { select: { harvestBatchId: true, kg: true } },
      logs: {
        orderBy: { recordedAt: 'desc' },
        take: 1,
        select: { temperatureCelsius: true, recordedAt: true },
      },
      _count: { select: { logs: true, treatments: true } },
    },
  },
  wineAgingBatches: { orderBy: { createdAt: 'asc' } },
  productionBatches: {
    orderBy: [{ processStartDate: 'asc' }, { createdAt: 'asc' }],
  },
  bottlingBatch: {
    include: { labAnalyses: { orderBy: { createdAt: 'asc' } } },
  },
  _count: { select: { bottleUnits: { where: { status: 'ACTIVE' } } } },
} satisfies Prisma.LotInclude;

const LAB_PARAMETER_LABELS: Record<string, string> = {
  metanol: 'Metanol',
  cobre: 'Cobre',
  acidezVolatil: 'Acidez volátil',
  grado: 'Grado alcohólico',
};

const metric = (
  key: string,
  label: string,
  value: number | string | null,
  unit: string | null,
): GraphMetric => ({ key, label, value, unit });

/** Vistas de lectura del lote (contrato O2 §11.1 y §11.3). */
@Injectable()
export class LotViewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lots: LotsService,
  ) {}

  /** Línea de tiempo (§11.1): eventos por `seq`, candados y fecha estimada. */
  async timeline(
    wineryId: string | undefined,
    id: string,
  ): Promise<LotTimelineView> {
    const lot = await this.lots.get(wineryId, id);
    const rows = await this.prisma.lotEvent.findMany({
      where: { lotId: id },
      orderBy: { seq: 'asc' },
    });
    const actors = await resolveTraceActors(
      this.prisma,
      rows.map((r) => r.actorMembershipId),
    );
    return {
      events: rows.map((r) => ({
        id: r.id,
        seq: r.seq,
        type: r.type as LotEventType,
        occurredAt: r.occurredAt.toISOString(),
        recordedAt: r.recordedAt.toISOString(),
        lateEntry: isLateEntry(r.occurredAt, r.recordedAt),
        stage: r.stage,
        actor: actorOf(actors, r.actorMembershipId),
        summary: r.summary,
        data: (r.data ?? {}) as Record<string, unknown>,
        resource: { type: r.resourceType, id: r.resourceId },
        visibility: r.visibility === 'PUBLIC' ? 'PUBLIC' : 'INTERNAL',
        corrected: r.corrected,
      })),
      locks: lot.locks,
      estimatedReadyDate: lot.estimatedReadyDate,
      estimatedReadyBasis: lot.estimatedReadyBasis,
    };
  }

  /** Balance kilos → litros → botellas con mermas y proyección (§11.3, S-19). */
  async balance(wineryId: string | undefined, id: string): Promise<LotBalance> {
    const lot = await this.prisma.lot.findFirst({
      where: { id, ...(wineryId && { wineryId }) },
      include: LOT_FIGURES_INCLUDE,
    });
    if (!lot) throw lotNotFound();
    return computeLotBalance(balanceInputOf(lot));
  }

  /**
   * Grafo del lote (§11.3) con SE-07: solo los miembros de la bodega dueña y
   * el personal de plataforma que lee bodegas; cualquier otra sesión
   * (consumidor, otra bodega, punto de retiro) → 404, nunca 403.
   */
  async graphForUser(
    user: AuthenticatedUser,
    id: string,
  ): Promise<LotGraphView> {
    const isPlatformReader =
      user.organizationType === 'PLATFORM' &&
      (PLATFORM_WINERY_READERS as readonly string[]).includes(user.role ?? '');
    const isWineryMember =
      user.organizationType === 'WINERY' && !!user.organizationId;
    if (!isPlatformReader && !isWineryMember) throw lotNotFound();
    return this.graph(
      isPlatformReader ? undefined : (user.organizationId as string),
      id,
    );
  }

  private async graph(
    wineryId: string | undefined,
    id: string,
  ): Promise<LotGraphView> {
    const lot = await this.prisma.lot.findFirst({
      where: { id, ...(wineryId && { wineryId }) },
      include: GRAPH_INCLUDE,
    });
    if (!lot) throw lotNotFound();
    const { today } = await dbClock(this.prisma);
    const rules = parseLotRules(lot.rules);
    const bottling = lot.bottlingBatch;

    const [actors, corrections] = await Promise.all([
      resolveTraceActors(this.prisma, [
        ...lot.harvestBatches.map((h) => h.createdByMembershipId),
        ...lot.fermentationTanks.map((t) => t.createdByMembershipId),
        ...lot.wineAgingBatches.map((a) => a.createdByMembershipId),
        ...lot.productionBatches.map((p) => p.createdByMembershipId),
        bottling?.createdByMembershipId,
        ...(bottling?.labAnalyses.map((l) => l.createdByMembershipId) ?? []),
      ]),
      this.prisma.traceCorrection.findMany({
        where: {
          OR: [
            { lotId: id },
            {
              targetType: 'TERROIR',
              targetId: { in: lot.harvestBatches.map((h) => h.terroirId) },
            },
          ],
        },
        select: { targetId: true },
      }),
    ]);
    const corrected = new Set(corrections.map((c) => c.targetId));
    const nodes: LotGraphNode[] = [];
    const edges: LotGraphEdge[] = [];

    const terroirs = new Set<string>();
    for (const h of lot.harvestBatches) {
      const t = h.terroir;
      if (!terroirs.has(t.id)) {
        terroirs.add(t.id);
        nodes.push({
          id: t.id,
          type: 'TERROIR',
          label: t.parcelName,
          occurredAt: t.createdAt.toISOString(),
          recordedAt: t.createdAt.toISOString(),
          quantity: null,
          metrics: [
            metric('altitudeMasl', 'Altitud', num(t.altitudeMasl), 'msnm'),
            metric('varietyName', 'Variedad', t.varietyName, null),
            metric(
              'surfaceHectares',
              'Superficie',
              num(t.surfaceHectares),
              'ha',
            ),
          ],
          actor: null,
          status: t.isActive ? 'ACTIVE' : 'INACTIVE',
          corrected: corrected.has(t.id),
        });
      }
      const maturity = h.maturityAnalyses[0] ?? null;
      nodes.push({
        id: h.id,
        type: 'HARVEST_BATCH',
        label: h.harvestBatchCode,
        occurredAt: h.intakeDate.toISOString(),
        recordedAt: h.createdAt.toISOString(),
        quantity: { value: num(h.netWeightKg) ?? 0, unit: 'kg' },
        metrics: [
          metric(
            'brixDegrees',
            'Grados Brix',
            num(maturity?.brixDegrees),
            '°Bx',
          ),
          metric('ph', 'pH', num(maturity?.ph), null),
          metric('acidityGl', 'Acidez', num(maturity?.acidityGl), 'g/L'),
          metric(
            'temperatureAtIntakeC',
            'Temperatura al ingreso',
            num(h.temperatureAtIntakeC),
            '°C',
          ),
        ],
        actor: actorOf(actors, h.createdByMembershipId),
        status: h.phytosanitaryStatus,
        corrected: corrected.has(h.id),
      });
      edges.push({ from: t.id, to: h.id, quantity: null });
    }

    for (const t of lot.fermentationTanks) {
      const last = t.logs[0] ?? null;
      const filled = num(t.volumeFilledLiters);
      nodes.push({
        id: t.id,
        type: 'TANK',
        label: t.tankCode,
        occurredAt: t.startDate.toISOString(),
        recordedAt: t.createdAt.toISOString(),
        quantity: filled !== null ? { value: filled, unit: 'L' } : null,
        metrics: [
          metric('capacityLiters', 'Capacidad', num(t.capacityLiters), 'L'),
          metric(
            'finalVolumeLiters',
            'Volumen final',
            num(t.finalVolumeLiters),
            'L',
          ),
          metric('readings', 'Lecturas', t._count.logs, null),
          metric(
            'lastTemperatureC',
            'Última temperatura',
            num(last?.temperatureCelsius),
            '°C',
          ),
          metric('treatments', 'Tratamientos', t._count.treatments, null),
        ],
        actor: actorOf(actors, t.createdByMembershipId),
        status: t.status,
        corrected: corrected.has(t.id),
      });
      for (const input of t.inputs) {
        edges.push({
          from: input.harvestBatchId,
          to: t.id,
          quantity: { value: num(input.kg) ?? 0, unit: 'kg' },
        });
      }
    }

    for (const a of lot.wineAgingBatches) {
      const liters = num(a.volumeLiters);
      const lock = agingLock(
        {
          id: a.id,
          startDate: a.startDate
            ? dateOnly(a.startDate)
            : laPazDate(a.createdAt),
          plannedMonths: a.plannedMonths,
          storedUnlockDate: dateOnly(a.lockUntilDate),
        },
        rules,
        today,
      );
      nodes.push({
        id: a.id,
        type: 'WINE_AGING',
        label: a.containerCode ?? a.containerType,
        occurredAt: (a.startDate ?? a.createdAt).toISOString(),
        recordedAt: a.createdAt.toISOString(),
        quantity: liters !== null ? { value: liters, unit: 'L' } : null,
        metrics: [
          metric('containerType', 'Recipiente', a.containerType, null),
          metric('containerMaterial', 'Material', a.containerMaterial, null),
          metric(
            'plannedMonths',
            'Crianza planificada',
            a.plannedMonths,
            'meses',
          ),
          metric('unlockDate', 'Desbloqueo', lock.unlockDate, null),
        ],
        actor: actorOf(actors, a.createdByMembershipId),
        status: a.agingStatus,
        corrected: corrected.has(a.id),
      });
      edges.push({
        from: a.fermentationTankId,
        to: a.id,
        quantity: liters !== null ? { value: liters, unit: 'L' } : null,
      });
      if (bottling && a.agingStatus === 'BOTTLED') {
        edges.push({
          from: a.id,
          to: bottling.id,
          quantity: liters !== null ? { value: liters, unit: 'L' } : null,
        });
      }
    }

    for (const p of lot.productionBatches) {
      const cuts = distillationCuts(p);
      const input = num(p.inputVolumeLiters);
      const lock = restLock(
        {
          id: p.id,
          processEndDate: p.processEndDate ? dateOnly(p.processEndDate) : null,
          storedUnlockDate: p.mandatoryRestUntil
            ? dateOnly(p.mandatoryRestUntil)
            : null,
        },
        rules,
        today,
      );
      nodes.push({
        id: p.id,
        type: 'DISTILLATION',
        label: p.equipmentIdentifier,
        occurredAt: p.processStartDate.toISOString(),
        recordedAt: p.createdAt.toISOString(),
        quantity:
          cuts.heartLiters !== null
            ? { value: cuts.heartLiters, unit: 'L' }
            : null,
        metrics: [
          metric('inputVolumeLiters', 'Entrada', input, 'L'),
          metric('headsLiters', 'Cabezas', cuts.headsLiters, 'L'),
          metric('heartLiters', 'Corazón', cuts.heartLiters, 'L'),
          metric('tailsLiters', 'Colas', cuts.tailsLiters, 'L'),
          metric(
            'heartAbvPercent',
            'Grado del corazón',
            cuts.heartAbvPercent,
            '% v/v',
          ),
          metric(
            'processEndDate',
            'Fin de la destilación',
            p.processEndDate ? dateOnly(p.processEndDate) : null,
            null,
          ),
          metric(
            'unlockDate',
            'Fin del reposo',
            lock?.unlockDate ?? null,
            null,
          ),
        ],
        actor: actorOf(actors, p.createdByMembershipId),
        status: p.restStatus,
        corrected: corrected.has(p.id),
      });
      edges.push({
        from: p.fermentationTankId,
        to: p.id,
        quantity: input !== null ? { value: input, unit: 'L' } : null,
      });
      if (bottling && p.restStatus === 'BOTTLED') {
        edges.push({
          from: p.id,
          to: bottling.id,
          quantity:
            cuts.heartLiters !== null
              ? { value: cuts.heartLiters, unit: 'L' }
              : null,
        });
      }
    }

    if (bottling) {
      const balance = storedBottlingBalance(lot);
      nodes.push({
        id: bottling.id,
        type: 'BOTTLING',
        label: bottling.internationalLotCode,
        occurredAt: bottling.bottlingDate.toISOString(),
        recordedAt: bottling.createdAt.toISOString(),
        quantity: { value: bottling.totalBottlesPackaged, unit: 'bottles' },
        metrics: [
          metric(
            'packagingFormatCl',
            'Formato',
            bottling.packagingFormatCl,
            'cL',
          ),
          metric(
            'finalAlcoholAbv',
            'Grado final',
            num(bottling.finalAlcoholAbv),
            '% v/v',
          ),
          metric(
            'waterDilutionLiters',
            'Agua de dilución',
            num(bottling.waterDilutionLiters),
            'L',
          ),
          metric(
            'bottledLiters',
            'Embotellado',
            balance?.bottledLiters ?? null,
            'L',
          ),
          metric('lossPercent', 'Merma', balance?.lossPercent ?? null, '%'),
          metric(
            'activeBottleCodes',
            'Códigos activos',
            lot._count.bottleUnits,
            null,
          ),
        ],
        actor: actorOf(
          actors,
          bottling.createdByMembershipId ?? bottling.releasedByMemberId,
        ),
        status: 'BOTTLED',
        corrected: corrected.has(bottling.id),
      });
      for (const lab of bottling.labAnalyses) {
        const checks = ((lab.conformity as { checks?: unknown } | null)
          ?.checks ?? []) as {
          parameter: string;
          value: number | null;
          unit: string;
        }[];
        nodes.push({
          id: lab.id,
          type: 'LAB_ANALYSIS',
          label: lab.certifiedLaboratoryName,
          occurredAt: lab.testPerformedAt.toISOString(),
          recordedAt: lab.createdAt.toISOString(),
          quantity: null,
          metrics: Array.isArray(checks)
            ? checks.map((c) =>
                metric(
                  c.parameter,
                  LAB_PARAMETER_LABELS[c.parameter] ?? c.parameter,
                  c.value,
                  c.unit,
                ),
              )
            : [],
          actor: actorOf(actors, lab.createdByMembershipId),
          status: lab.supersededAt
            ? 'SUPERSEDED'
            : (lab.conformityStatus ?? 'NOT_RECORDED'),
          corrected: corrected.has(lab.id),
        });
        edges.push({ from: bottling.id, to: lab.id, quantity: null });
      }
    }

    return {
      lotId: lot.id,
      lotCode: lot.lotCode,
      productType: lot.productType as LotProductType | null,
      nodes,
      edges,
    };
  }
}
