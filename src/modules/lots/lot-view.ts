import { Prisma } from '@prisma/client';
import type { ErrorDetail } from '@shared/interfaces/api-response.interface';
import { dateOnly, laPazDate } from './domain/dates';
import {
  doRulesFromLot,
  DoEvaluation,
  evaluateDo,
} from './domain/do-evaluation';
import { parseLotRules, LotRules } from './domain/lot-rules';
import {
  agingLock,
  LotLock,
  nextLock,
  readyDateFromLocks,
  restLock,
} from './domain/locks';
import type { LotProductType, LotStage } from './domain/lot-stage';
import { distillationHeart, num, tankLiters } from './domain/sources';
import { actorOf, TraceActor } from './trace-actors';
import {
  NO_LOT_TOKENIZATION,
  type LotTokenizationState,
} from '@modules/tokenization/tokenization.constants';

/** Lo que se carga de un lote para responder `Lot` / `LotSummary`. */
export const LOT_VIEW_INCLUDE = {
  harvestBatches: {
    select: {
      id: true,
      phytosanitaryStatus: true,
      terroir: {
        select: {
          id: true,
          parcelName: true,
          altitudeMasl: true,
          varietyName: true,
        },
      },
    },
    orderBy: { intakeDate: 'asc' },
  },
  fermentationTanks: {
    select: {
      id: true,
      status: true,
      destinationType: true,
      volumeFilledLiters: true,
      finalVolumeLiters: true,
      wineAgingBatch: { select: { id: true } },
      productionBatches: { select: { id: true } },
    },
    orderBy: { startDate: 'asc' },
  },
  wineAgingBatches: {
    select: {
      id: true,
      startDate: true,
      createdAt: true,
      plannedMonths: true,
      lockUntilDate: true,
      agingStatus: true,
      discardedAt: true,
      volumeLiters: true,
    },
    orderBy: { createdAt: 'asc' },
  },
  productionBatches: {
    select: {
      id: true,
      processEndDate: true,
      mandatoryRestUntil: true,
      restStatus: true,
      discardedAt: true,
      heartLiters: true,
      outputVolumeLiters: true,
      heartAbvPercent: true,
      initialAlcoholPercentage: true,
    },
    orderBy: { processStartDate: 'asc' },
  },
  bottlingBatch: {
    select: {
      id: true,
      totalBottlesPackaged: true,
      // El vigente: ni sustituido por un reanálisis ni anulado (§9)
      labAnalyses: {
        where: { supersededAt: null, voidedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { id: true, conformityStatus: true },
      },
    },
  },
  labAnalyses: { select: { id: true }, orderBy: { createdAt: 'asc' } },
  dossier: { select: { status: true } },
  complianceIssues: { orderBy: { detectedAt: 'asc' } },
  events: {
    where: { type: { in: ['ESTIMATE_CHANGED', 'LOT_CREATED'] } },
    orderBy: { seq: 'asc' },
    select: {
      type: true,
      data: true,
      recordedAt: true,
      actorMembershipId: true,
    },
  },
  _count: { select: { bottleUnits: { where: { status: 'ACTIVE' } } } },
} satisfies Prisma.LotInclude;

export type LotWithView = Prisma.LotGetPayload<{
  include: typeof LOT_VIEW_INCLUDE;
}>;

export interface ComplianceIssueView {
  id: string;
  code: string;
  message: string;
  source: 'MIGRATION' | 'CORRECTION' | 'RULES_REEVALUATION';
  details: ErrorDetail[];
  detectedAt: string;
  resolvedAt: string | null;
}

export interface LotSummaryView {
  id: string;
  wineryId: string;
  reference: string;
  lotCode: string | null;
  name: string;
  productType: LotProductType | null;
  stage: LotStage;
  stageChangedAt: string;
  awaitingBifurcation: boolean;
  harvestYear: number;
  estimatedBottles: number | null;
  projectedBottles: number | null;
  bottles: number | null;
  nextLock: LotLock | null;
  phyto: {
    pending: number;
    quarantine: number;
    approved: number;
    rejected: number;
  };
  labStatus: 'NOT_RECORDED' | 'CONFORMING' | 'NON_CONFORMING' | 'INCOMPLETE';
  dossierStatus: 'OPEN' | 'CLOSED';
  complianceIssuesOpen: number;
  /** Marca de tokenización (contrato O3 §5.3): no es una etapa del lote. */
  tokenization: LotTokenizationMark;
  createdAt: string;
  updatedAt: string;
}

export interface LotTokenizationMark {
  state: LotTokenizationState;
  quota: number;
  minted: number;
  collectionId: string | null;
}

export interface LotView extends LotSummaryView {
  plannedTerroirIds: string[];
  plannedFormatCl: number | null;
  targetAbvPercent: number | null;
  targetReadyDate: string | null;
  estimatedReadyDate: string | null;
  estimatedReadyBasis: 'LOCK' | 'DECLARED' | null;
  estimatedBottlesHistory: {
    value: number;
    at: string;
    by: TraceActor | null;
    reason: string | null;
  }[];
  locks: LotLock[];
  rules: LotRules;
  denomination: DoEvaluation;
  complianceIssues: ComplianceIssueView[];
  links: {
    harvestBatchIds: string[];
    tankIds: string[];
    wineAgingBatchIds: string[];
    productionBatchIds: string[];
    bottlingBatchId: string | null;
    labAnalysisIds: string[];
  };
  discarded: { at: string; by: TraceActor | null; reason: string } | null;
  notes: string | null;
  createdBy: TraceActor | null;
}

/** Membresías que aparecen en la vista (para resolverlas de una vez). */
export function lotActorIds(lot: LotWithView): string[] {
  return [
    lot.createdByMembershipId,
    lot.discardedByMembershipId,
    ...lot.events.map((e) => e.actorMembershipId),
  ].filter((id): id is string => !!id);
}

/** Candados del lote con la instantánea y el día de hoy (reloj de la base). */
export function lotLocks(
  lot: LotWithView,
  rules: LotRules,
  today: string,
): LotLock[] {
  const locks: LotLock[] = [];
  for (const a of lot.wineAgingBatches) {
    if (a.discardedAt) continue;
    locks.push(
      agingLock(
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
      ),
    );
  }
  for (const p of lot.productionBatches) {
    if (p.discardedAt) continue;
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
    if (lock) locks.push(lock);
  }
  return locks;
}

function projectedBottles(lot: LotWithView, rules: LotRules): number | null {
  const factor = 1 - rules.bottling.maxLossPercent / 100;
  if (lot.bottlingBatch) return lot._count.bottleUnits;
  const format = lot.plannedFormatCl;
  if (format && format > 0) {
    const perBottle = format / 100;
    if (lot.productType === 'SINGANI') {
      const target = num(lot.targetAbvPercent);
      const hearts = lot.productionBatches
        .filter((p) => !p.discardedAt && p.processEndDate)
        .map((p) => distillationHeart(p));
      if (
        target &&
        hearts.length > 0 &&
        hearts.every((h) => h.liters !== null && h.abv !== null)
      ) {
        const pure = hearts.reduce(
          (s, h) => s + ((h.liters as number) * (h.abv as number)) / 100,
          0,
        );
        return Math.floor((((pure * 100) / target) * factor) / perBottle);
      }
    } else if (lot.productType === 'WINE') {
      const aging = lot.wineAgingBatches
        .filter((a) => !a.discardedAt)
        .map((a) => num(a.volumeLiters));
      if (aging.length > 0 && aging.every((v) => v !== null)) {
        const liters = (aging as number[]).reduce((s, v) => s + v, 0);
        return Math.floor((liters * factor) / perBottle);
      }
      const tanks = lot.fermentationTanks.map((t) => tankLiters(t));
      if (tanks.length > 0 && tanks.every((v) => v !== null)) {
        const liters = (tanks as number[]).reduce((s, v) => s + v, 0);
        return Math.floor((liters * factor) / perBottle);
      }
    }
  }
  return lot.estimatedBottles ?? null;
}

export function toLotSummary(lot: LotWithView, today: string): LotSummaryView {
  const rules = parseLotRules(lot.rules);
  const locks = lotLocks(lot, rules, today);
  const count = (status: string) =>
    lot.harvestBatches.filter((h) => h.phytosanitaryStatus === status).length;
  const lab = lot.bottlingBatch?.labAnalyses[0];
  const labStatus: LotSummaryView['labStatus'] =
    lab?.conformityStatus === 'CONFORMING' ||
    lab?.conformityStatus === 'NON_CONFORMING' ||
    lab?.conformityStatus === 'INCOMPLETE'
      ? lab.conformityStatus
      : 'NOT_RECORDED';
  const used = new Set([
    ...lot.fermentationTanks.flatMap((t) => [
      ...(t.wineAgingBatch ? [t.id] : []),
      ...(t.productionBatches.length > 0 ? [t.id] : []),
    ]),
  ]);
  const stage = lot.stage as LotStage;
  return {
    id: lot.id,
    wineryId: lot.wineryId,
    reference: lot.reference,
    lotCode: lot.lotCode,
    name: lot.name,
    productType: lot.productType as LotProductType | null,
    stage,
    stageChangedAt: lot.stageChangedAt.toISOString(),
    awaitingBifurcation:
      stage === 'FERMENTING' &&
      lot.fermentationTanks.some(
        (t) =>
          t.status === 'COMPLETED' && !t.destinationType && !used.has(t.id),
      ),
    harvestYear: lot.harvestYear,
    estimatedBottles: lot.estimatedBottles,
    projectedBottles: projectedBottles(lot, rules),
    bottles: lot.bottlingBatch ? lot._count.bottleUnits : null,
    nextLock: nextLock(locks),
    phyto: {
      pending: count('PENDING_INSPECTION'),
      quarantine: count('QUARANTINE'),
      approved: count('APPROVED'),
      rejected: count('REJECTED'),
    },
    labStatus,
    dossierStatus: lot.dossier?.status === 'CLOSED' ? 'CLOSED' : 'OPEN',
    complianceIssuesOpen: lot.complianceIssues.filter((i) => !i.resolvedAt)
      .length,
    // Apertura de la Ola 3: ningún lote tiene solicitud ni colección todavía
    // (sus rutas llegan con los pasos 3.3 y 3.4, que calculan esta marca)
    tokenization: { ...NO_LOT_TOKENIZATION },
    createdAt: lot.createdAt.toISOString(),
    updatedAt: lot.updatedAt.toISOString(),
  };
}

export function toLotView(
  lot: LotWithView,
  today: string,
  actors: Map<string, TraceActor>,
  now: Date = new Date(),
): LotView {
  const summary = toLotSummary(lot, today);
  const rules = parseLotRules(lot.rules);
  const locks = lotLocks(lot, rules, today);
  const readyByLock = readyDateFromLocks(locks);
  const targetReady = lot.targetReadyDate
    ? dateOnly(lot.targetReadyDate)
    : null;
  const history: LotView['estimatedBottlesHistory'] = [];
  for (const e of lot.events) {
    const data = (e.data ?? {}) as Record<string, unknown>;
    const value = e.type === 'LOT_CREATED' ? data.estimatedBottles : data.value;
    if (typeof value !== 'number') continue;
    history.push({
      value,
      at: e.recordedAt.toISOString(),
      by: actorOf(actors, e.actorMembershipId),
      reason: typeof data.reason === 'string' ? data.reason : null,
    });
  }
  const denomination: DoEvaluation =
    lot.productType === 'SINGANI'
      ? evaluateDo(
          lot.harvestBatches.map((h) => ({
            id: h.terroir.id,
            altitudeMasl: h.terroir.altitudeMasl.toNumber(),
            varietyName: h.terroir.varietyName,
          })),
          doRulesFromLot(rules),
          'LOT_SNAPSHOT',
          now,
        )
      : {
          status: 'NOT_APPLICABLE',
          checks: [],
          rulesSource: 'LOT_SNAPSHOT',
          evaluatedAt: now.toISOString(),
        };
  return {
    ...summary,
    plannedTerroirIds: lot.plannedTerroirIds,
    plannedFormatCl: lot.plannedFormatCl,
    targetAbvPercent: num(lot.targetAbvPercent),
    targetReadyDate: targetReady,
    estimatedReadyDate: readyByLock ?? targetReady,
    estimatedReadyBasis: readyByLock ? 'LOCK' : targetReady ? 'DECLARED' : null,
    estimatedBottlesHistory: history,
    locks,
    rules,
    denomination,
    complianceIssues: lot.complianceIssues.map((i) => ({
      id: i.id,
      code: i.code,
      message: i.message,
      source: i.source as ComplianceIssueView['source'],
      details: (i.details ?? []) as unknown as ErrorDetail[],
      detectedAt: i.detectedAt.toISOString(),
      resolvedAt: i.resolvedAt ? i.resolvedAt.toISOString() : null,
    })),
    links: {
      harvestBatchIds: lot.harvestBatches.map((h) => h.id),
      tankIds: lot.fermentationTanks.map((t) => t.id),
      wineAgingBatchIds: lot.wineAgingBatches.map((a) => a.id),
      productionBatchIds: lot.productionBatches.map((p) => p.id),
      bottlingBatchId: lot.bottlingBatch?.id ?? null,
      labAnalysisIds: lot.labAnalyses.map((l) => l.id),
    },
    discarded:
      lot.discardedAt && lot.discardReason
        ? {
            at: lot.discardedAt.toISOString(),
            by: actorOf(actors, lot.discardedByMembershipId),
            reason: lot.discardReason,
          }
        : null,
    notes: lot.notes,
    createdBy: actorOf(actors, lot.createdByMembershipId),
  };
}
