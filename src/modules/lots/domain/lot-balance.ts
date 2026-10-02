import type { BottlingBalance } from './bottling-balance';
import type { LotProductType } from './lot-stage';

/**
 * Conciliación kilos → litros → botellas del lote (contrato O2 §11.3) y las
 * cifras del reporte de producción (§11.4). Funciones puras: quien llama carga
 * los registros y pasa números. Lo que no está registrado queda en `null`
 * (nunca se inventa una merma de cero).
 */

export interface BalanceHarvestInput {
  netKg: number;
  /** `PENDING_INSPECTION` | `APPROVED` | `REJECTED` | `QUARANTINE`. */
  status: string;
}

export interface BalanceTankInput {
  /** Mosto con el que se llenó (`volumeFilledLiters`). */
  filledLiters: number | null;
  /** Volumen final de la fermentación (`finalVolumeLiters`). */
  finalLiters: number | null;
  /** Kilos de uva que entraron (Σ `fermentation_tank_inputs.kg`). */
  inputKg: number;
  /** Litros que salieron hacia crianza y destilaciones. */
  drawnLiters: number;
  /** El tanque ya se trasegó entero (`TRANSFERRED` o `CLEANED`). */
  transferred: boolean;
}

export interface BalanceAgingInput {
  liters: number | null;
  /** Litros del tanque de origen (final o llenado). */
  tankLiters: number | null;
  discarded: boolean;
}

export interface BalanceDistillationInput {
  inputLiters: number | null;
  headsLiters: number | null;
  heartLiters: number | null;
  tailsLiters: number | null;
  vinasseLiters: number | null;
  heartAbvPercent: number | null;
  closed: boolean;
  discarded: boolean;
}

export interface LotBalanceInput {
  productType: LotProductType | null;
  harvests: readonly BalanceHarvestInput[];
  tanks: readonly BalanceTankInput[];
  agings: readonly BalanceAgingInput[];
  distillations: readonly BalanceDistillationInput[];
  /** Balance del embotellado registrado (`null` sin embotellar). */
  bottling: BottlingBalance | null;
  /** Códigos de botella activos (`null` sin embotellar). */
  activeBottles: number | null;
  plannedFormatCl: number | null;
  targetAbvPercent: number | null;
  estimatedBottles: number | null;
  /** `rules.bottling.maxLossPercent` de la instantánea. */
  maxLossPercent: number;
}

export type ProjectionBasis =
  'DECLARED' | 'MUST' | 'BASE_WINE' | 'DISTILLATE' | 'BOTTLED';

export interface LotBalance {
  harvest: {
    netKg: number;
    approvedKg: number;
    rejectedKg: number;
    pendingKg: number;
  };
  must: { filledLiters: number; litersPerKg: number | null };
  fermentation: {
    finalLiters: number | null;
    lossLiters: number | null;
    lossPercent: number | null;
  };
  aging?: { liters: number; lossLiters: number };
  distillation?: {
    inputLiters: number;
    headsLiters: number;
    heartLiters: number;
    tailsLiters: number;
    heartAbvPercent: number | null;
    pureAlcoholLiters: number | null;
  };
  bottling: BottlingBalance | null;
  projection: { bottles: number | null; basis: ProjectionBasis };
}

export const round = (value: number, decimals = 3): number => {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};

const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);

const percent = (part: number, whole: number): number | null =>
  whole > 0 ? round((part / whole) * 100, 2) : null;

/** Kilos de uva que entraron a tanques (base del rendimiento en mosto). */
export function crushedKg(tanks: readonly BalanceTankInput[]): number {
  return round(sum(tanks.map((t) => t.inputKg)));
}

/**
 * Merma de trasiego: lo que quedó en los tanques ya trasegados sin pasar a
 * crianza ni a destilación. `null` si ningún tanque trasegado tiene volumen.
 */
export function transferLoss(
  tanks: readonly BalanceTankInput[],
): { liters: number; percent: number | null } | null {
  const moved = tanks.filter(
    (t) =>
      t.transferred &&
      t.drawnLiters > 0 &&
      (t.finalLiters ?? t.filledLiters) !== null,
  );
  if (moved.length === 0) return null;
  const base = sum(
    moved.map((t) => (t.finalLiters ?? t.filledLiters) as number),
  );
  const liters = Math.max(0, base - sum(moved.map((t) => t.drawnLiters)));
  return { liters: round(liters), percent: percent(liters, base) };
}

/**
 * Merma de la destilación: entrada menos cabezas, corazón, colas y vinazas,
 * sobre las destilaciones cerradas con su entrada registrada.
 */
export function distillationLossPercent(
  distillations: readonly BalanceDistillationInput[],
): number | null {
  const closed = distillations.filter(
    (d) =>
      !d.discarded &&
      d.closed &&
      d.inputLiters !== null &&
      d.heartLiters !== null,
  );
  if (closed.length === 0) return null;
  const input = sum(closed.map((d) => d.inputLiters as number));
  const output = sum(
    closed.map(
      (d) =>
        (d.headsLiters ?? 0) +
        (d.heartLiters ?? 0) +
        (d.tailsLiters ?? 0) +
        (d.vinasseLiters ?? 0),
    ),
  );
  return percent(Math.max(0, input - output), input);
}

/**
 * Proyección de botellas (S-19): vino = litros de la última etapa ×
 * (1 − merma máxima) ÷ formato; singani = corazón × grado ÷ grado previsto ×
 * (1 − merma máxima) ÷ formato; sin datos, la estimación declarada. Con el
 * lote embotellado, sus códigos activos.
 */
export function projectBottles(
  input: LotBalanceInput,
): LotBalance['projection'] {
  if (input.bottling !== null || input.activeBottles !== null) {
    return { bottles: input.activeBottles, basis: 'BOTTLED' };
  }
  const format = input.plannedFormatCl;
  const factor = 1 - input.maxLossPercent / 100;
  if (format && format > 0) {
    const perBottle = format / 100;
    if (input.productType === 'SINGANI') {
      const closed = input.distillations.filter(
        (d) => !d.discarded && d.closed,
      );
      const target = input.targetAbvPercent;
      if (
        target &&
        target > 0 &&
        closed.length > 0 &&
        closed.every(
          (d) => d.heartLiters !== null && d.heartAbvPercent !== null,
        )
      ) {
        const pure = sum(
          closed.map(
            (d) =>
              ((d.heartLiters as number) * (d.heartAbvPercent as number)) / 100,
          ),
        );
        return {
          bottles: Math.floor((((pure * 100) / target) * factor) / perBottle),
          basis: 'DISTILLATE',
        };
      }
    } else if (input.productType === 'WINE') {
      const agings = input.agings.filter((a) => !a.discarded);
      if (agings.length > 0 && agings.every((a) => a.liters !== null)) {
        const liters = sum(agings.map((a) => a.liters as number));
        return {
          bottles: Math.floor((liters * factor) / perBottle),
          basis: 'BASE_WINE',
        };
      }
      const liters = input.tanks.map((t) => t.finalLiters ?? t.filledLiters);
      if (liters.length > 0 && liters.every((v) => v !== null)) {
        return {
          bottles: Math.floor((sum(liters as number[]) * factor) / perBottle),
          basis: input.tanks.every((t) => t.finalLiters !== null)
            ? 'BASE_WINE'
            : 'MUST',
        };
      }
    }
  }
  return { bottles: input.estimatedBottles, basis: 'DECLARED' };
}

export function computeLotBalance(input: LotBalanceInput): LotBalance {
  const kg = (statuses: readonly string[]) =>
    round(
      sum(
        input.harvests
          .filter((h) => statuses.includes(h.status))
          .map((h) => h.netKg),
      ),
    );
  const netKg = round(sum(input.harvests.map((h) => h.netKg)));

  const filledLiters = round(sum(input.tanks.map((t) => t.filledLiters ?? 0)));
  const crushed = crushedKg(input.tanks);
  const withFinal = input.tanks.filter(
    (t) => t.finalLiters !== null && t.filledLiters !== null,
  );
  const finals = input.tanks.filter((t) => t.finalLiters !== null);
  const fermentationLoss =
    withFinal.length > 0
      ? Math.max(
          0,
          sum(
            withFinal.map(
              (t) => (t.filledLiters as number) - (t.finalLiters as number),
            ),
          ),
        )
      : null;

  const balance: LotBalance = {
    harvest: {
      netKg,
      approvedKg: kg(['APPROVED']),
      rejectedKg: kg(['REJECTED']),
      pendingKg: kg(['PENDING_INSPECTION', 'QUARANTINE']),
    },
    must: {
      filledLiters,
      litersPerKg:
        filledLiters > 0 && crushed > 0
          ? round(filledLiters / crushed, 3)
          : null,
    },
    fermentation: {
      finalLiters:
        finals.length > 0
          ? round(sum(finals.map((t) => t.finalLiters as number)))
          : null,
      lossLiters: fermentationLoss !== null ? round(fermentationLoss) : null,
      lossPercent:
        fermentationLoss !== null
          ? percent(
              fermentationLoss,
              sum(withFinal.map((t) => t.filledLiters as number)),
            )
          : null,
    },
    bottling: input.bottling,
    projection: projectBottles(input),
  };

  const agings = input.agings.filter((a) => !a.discarded);
  if (agings.length > 0) {
    balance.aging = {
      liters: round(sum(agings.map((a) => a.liters ?? 0))),
      lossLiters: round(
        sum(
          agings.map((a) =>
            a.liters !== null && a.tankLiters !== null
              ? Math.max(0, a.tankLiters - a.liters)
              : 0,
          ),
        ),
      ),
    };
  }

  const distillations = input.distillations.filter((d) => !d.discarded);
  if (distillations.length > 0) {
    const hearts = distillations.filter((d) => d.heartLiters !== null);
    const heartLiters = sum(hearts.map((d) => d.heartLiters as number));
    const graded =
      hearts.length > 0 && hearts.every((d) => d.heartAbvPercent !== null);
    const pure = graded
      ? sum(
          hearts.map(
            (d) =>
              ((d.heartLiters as number) * (d.heartAbvPercent as number)) / 100,
          ),
        )
      : null;
    balance.distillation = {
      inputLiters: round(sum(distillations.map((d) => d.inputLiters ?? 0))),
      headsLiters: round(sum(distillations.map((d) => d.headsLiters ?? 0))),
      heartLiters: round(heartLiters),
      tailsLiters: round(sum(distillations.map((d) => d.tailsLiters ?? 0))),
      heartAbvPercent:
        pure !== null && heartLiters > 0
          ? round((pure / heartLiters) * 100, 2)
          : null,
      pureAlcoholLiters: pure !== null ? round(pure) : null,
    };
  }
  return balance;
}

// ── Reporte de producción (§11.4) ──────────────────────────────────────────

export interface ProductionFigures {
  netKg: number;
  mustLiters: number | null;
  baseWineLiters: number | null;
  heartLiters: number | null;
  bottledLiters: number | null;
  bottles: number | null;
  lossPercentByStage: {
    fermentation: number | null;
    transfer: number | null;
    distillation: number | null;
    bottling: number | null;
  };
  litersPerKg: number | null;
  bottlesPerTonne: number | null;
}

/**
 * Cifras de una fila del reporte a partir del balance del lote.
 * `bottlesPackaged` es lo embotellado (el hecho de producción), no los códigos
 * que siguen activos.
 */
export function productionFigures(
  input: LotBalanceInput,
  balance: LotBalance,
  bottlesPackaged: number | null,
): ProductionFigures {
  const hasVolume = input.tanks.some((t) => t.filledLiters !== null);
  return {
    netKg: balance.harvest.netKg,
    mustLiters: hasVolume ? balance.must.filledLiters : null,
    baseWineLiters: balance.fermentation.finalLiters,
    heartLiters:
      balance.distillation &&
      input.distillations.some((d) => !d.discarded && d.heartLiters !== null)
        ? balance.distillation.heartLiters
        : null,
    bottledLiters: balance.bottling?.bottledLiters ?? null,
    bottles: bottlesPackaged,
    lossPercentByStage: {
      fermentation: balance.fermentation.lossPercent,
      transfer: transferLoss(input.tanks)?.percent ?? null,
      distillation: distillationLossPercent(input.distillations),
      bottling: balance.bottling?.lossPercent ?? null,
    },
    litersPerKg: balance.must.litersPerKg,
    bottlesPerTonne:
      bottlesPackaged !== null && balance.harvest.netKg > 0
        ? round(bottlesPackaged / (balance.harvest.netKg / 1000), 2)
        : null,
  };
}

export interface ProductionTotals {
  lots: number;
  netKg: number;
  mustLiters: number;
  baseWineLiters: number;
  heartLiters: number;
  bottledLiters: number;
  bottles: number;
  litersPerKg: number | null;
  bottlesPerTonne: number | null;
}

/** Totales de un grupo de filas: sumas y ratios agregados (Σ ÷ Σ). */
export function productionTotals(
  rows: readonly ProductionFigures[],
): ProductionTotals {
  const netKg = sum(rows.map((r) => r.netKg));
  const mustLiters = sum(rows.map((r) => r.mustLiters ?? 0));
  const bottles = sum(rows.map((r) => r.bottles ?? 0));
  return {
    lots: rows.length,
    netKg: round(netKg),
    mustLiters: round(mustLiters),
    baseWineLiters: round(sum(rows.map((r) => r.baseWineLiters ?? 0))),
    heartLiters: round(sum(rows.map((r) => r.heartLiters ?? 0))),
    bottledLiters: round(sum(rows.map((r) => r.bottledLiters ?? 0))),
    bottles,
    litersPerKg: netKg > 0 ? round(mustLiters / netKg, 3) : null,
    bottlesPerTonne: netKg > 0 ? round(bottles / (netKg / 1000), 2) : null,
  };
}
