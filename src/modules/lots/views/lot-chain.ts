import { Prisma } from '@prisma/client';
import {
  BottlingBalance,
  computeBottlingBalance,
} from '../domain/bottling-balance';
import { LotBalanceInput } from '../domain/lot-balance';
import { parseLotRules } from '../domain/lot-rules';
import type { LotProductType } from '../domain/lot-stage';
import { distillationHeart, legacyCuts, num } from '../domain/sources';

/**
 * Cadena del lote para las cifras (balance §11.3, reporte §11.4): solo las
 * columnas numéricas. Se usa con muchos lotes a la vez (hasta 10 000).
 */
export const LOT_FIGURES_INCLUDE = {
  harvestBatches: {
    select: { id: true, netWeightKg: true, phytosanitaryStatus: true },
  },
  fermentationTanks: {
    select: {
      id: true,
      status: true,
      volumeFilledLiters: true,
      finalVolumeLiters: true,
      inputs: { select: { kg: true } },
    },
  },
  wineAgingBatches: {
    select: {
      id: true,
      fermentationTankId: true,
      volumeLiters: true,
      discardedAt: true,
    },
  },
  productionBatches: {
    select: {
      id: true,
      fermentationTankId: true,
      processEndDate: true,
      inputVolumeLiters: true,
      outputVolumeLiters: true,
      initialAlcoholPercentage: true,
      headsLiters: true,
      heartLiters: true,
      tailsLiters: true,
      vinasseLiters: true,
      heartAbvPercent: true,
      additionalParams: true,
      discardedAt: true,
    },
  },
  bottlingBatch: {
    select: {
      id: true,
      totalBottlesPackaged: true,
      packagingFormatCl: true,
      finalAlcoholAbv: true,
      waterDilutionLiters: true,
      availableLiters: true,
      leftoverLiters: true,
      bottlingDate: true,
      labAnalyses: {
        where: { supersededAt: null },
        orderBy: { createdAt: 'desc' as const },
        take: 1,
        select: { conformityStatus: true },
      },
    },
  },
  _count: { select: { bottleUnits: { where: { status: 'ACTIVE' } } } },
} satisfies Prisma.LotInclude;

export type LotWithFigures = Prisma.LotGetPayload<{
  include: typeof LOT_FIGURES_INCLUDE;
}>;

type Num = { toNumber(): number } | number | null | undefined;

/** Lo mínimo de la cadena que necesitan las cifras (lo cumple cualquier carga más completa). */
export interface LotFiguresLike {
  productType: string | null;
  rules: unknown;
  plannedFormatCl: number | null;
  targetAbvPercent: Num;
  estimatedBottles: number | null;
  harvestBatches: readonly { netWeightKg: Num; phytosanitaryStatus: string }[];
  fermentationTanks: readonly {
    id: string;
    status: string;
    volumeFilledLiters: Num;
    finalVolumeLiters: Num;
    inputs: readonly { kg: Num }[];
  }[];
  wineAgingBatches: readonly {
    fermentationTankId: string;
    volumeLiters: Num;
    discardedAt: Date | null;
  }[];
  productionBatches: readonly {
    fermentationTankId: string;
    processEndDate: Date | null;
    inputVolumeLiters: Num;
    outputVolumeLiters: Num;
    initialAlcoholPercentage: Num;
    headsLiters: Num;
    heartLiters: Num;
    tailsLiters: Num;
    vinasseLiters: Num;
    heartAbvPercent: Num;
    additionalParams: unknown;
    discardedAt: Date | null;
  }[];
  bottlingBatch: {
    totalBottlesPackaged: number;
    packagingFormatCl: number;
    finalAlcoholAbv: Num;
    waterDilutionLiters: Num;
    availableLiters: Num;
    leftoverLiters: Num;
  } | null;
  _count: { bottleUnits: number };
}

/** Cortes de una destilación: columnas de la Ola 2 o, en los legados, `additionalParams`. */
export function distillationCuts(
  p: LotFiguresLike['productionBatches'][number],
) {
  const legacy = legacyCuts(p.additionalParams);
  const heart = distillationHeart(p);
  return {
    headsLiters: num(p.headsLiters) ?? legacy.heads,
    heartLiters: heart.liters,
    tailsLiters: num(p.tailsLiters) ?? legacy.tails,
    vinasseLiters: num(p.vinasseLiters),
    heartAbvPercent: heart.abv,
  };
}

/**
 * Balance del embotellado registrado del lote (mismas reglas que la respuesta
 * del embotellado, §6.1): lo disponible guardado o, en registros anteriores,
 * la suma de sus fuentes. `null` sin embotellar o sin volumen conocido.
 */
export function storedBottlingBalance(
  lot: LotFiguresLike,
): BottlingBalance | null {
  const bottling = lot.bottlingBatch;
  if (!bottling) return null;
  const productType: LotProductType =
    lot.productType === 'SINGANI' ? 'SINGANI' : 'WINE';
  const hearts = lot.productionBatches
    .filter((p) => !p.discardedAt && p.processEndDate)
    .map((p) => distillationHeart(p));
  const agings = lot.wineAgingBatches
    .filter((a) => !a.discardedAt)
    .map((a) => num(a.volumeLiters));
  const sourceLiters =
    productType === 'SINGANI'
      ? hearts.length > 0 && hearts.every((h) => h.liters !== null)
        ? hearts.reduce((s, h) => s + (h.liters as number), 0)
        : null
      : agings.length > 0 && agings.every((v) => v !== null)
        ? (agings as number[]).reduce((s, v) => s + v, 0)
        : null;
  const available = num(bottling.availableLiters) ?? sourceLiters;
  if (available === null) return null;
  const pure =
    productType === 'SINGANI' &&
    hearts.length > 0 &&
    hearts.every((h) => h.liters !== null && h.abv !== null)
      ? hearts.reduce(
          (s, h) => s + ((h.liters as number) * (h.abv as number)) / 100,
          0,
        )
      : null;
  return computeBottlingBalance({
    productType,
    availableLiters: available,
    waterDilutionLiters: num(bottling.waterDilutionLiters) ?? 0,
    bottles: bottling.totalBottlesPackaged,
    formatCl: bottling.packagingFormatCl,
    leftoverLiters: num(bottling.leftoverLiters) ?? 0,
    maxLossPercent: parseLotRules(lot.rules).bottling.maxLossPercent,
    finalAbv: num(bottling.finalAlcoholAbv) ?? 0,
    pureAlcoholAvailableLiters: pure,
  });
}

const TRANSFERRED = new Set(['TRANSFERRED', 'CLEANED']);

/** Números del lote para `computeLotBalance`. */
export function balanceInputOf(lot: LotFiguresLike): LotBalanceInput {
  const tankLiters = new Map(
    lot.fermentationTanks.map((t) => [
      t.id,
      num(t.finalVolumeLiters) ?? num(t.volumeFilledLiters),
    ]),
  );
  const drawn = new Map<string, number>();
  const draw = (tankId: string, liters: number | null) =>
    drawn.set(tankId, (drawn.get(tankId) ?? 0) + (liters ?? 0));
  for (const a of lot.wineAgingBatches) {
    draw(a.fermentationTankId, num(a.volumeLiters));
  }
  for (const p of lot.productionBatches) {
    draw(p.fermentationTankId, num(p.inputVolumeLiters));
  }
  return {
    productType: lot.productType as LotProductType | null,
    harvests: lot.harvestBatches.map((h) => ({
      netKg: num(h.netWeightKg) ?? 0,
      status: h.phytosanitaryStatus,
    })),
    tanks: lot.fermentationTanks.map((t) => ({
      filledLiters: num(t.volumeFilledLiters),
      finalLiters: num(t.finalVolumeLiters),
      inputKg: t.inputs.reduce((s, i) => s + (num(i.kg) ?? 0), 0),
      drawnLiters: drawn.get(t.id) ?? 0,
      transferred: TRANSFERRED.has(t.status),
    })),
    agings: lot.wineAgingBatches.map((a) => ({
      liters: num(a.volumeLiters),
      tankLiters: tankLiters.get(a.fermentationTankId) ?? null,
      discarded: a.discardedAt !== null,
    })),
    distillations: lot.productionBatches.map((p) => ({
      inputLiters: num(p.inputVolumeLiters),
      ...distillationCuts(p),
      closed: p.processEndDate !== null,
      discarded: p.discardedAt !== null,
    })),
    bottling: storedBottlingBalance(lot),
    activeBottles: lot.bottlingBatch ? lot._count.bottleUnits : null,
    plannedFormatCl: lot.plannedFormatCl,
    targetAbvPercent: num(lot.targetAbvPercent),
    estimatedBottles: lot.estimatedBottles,
    maxLossPercent: parseLotRules(lot.rules).bottling.maxLossPercent,
  };
}
