import { ErrorCode } from '@shared/exceptions/error-codes';
import type { ErrorDetail } from '@shared/interfaces/api-response.interface';
import { LOT_RULE_KEYS } from './lot-rules';
import { violation } from './trace-errors';

/** Balance del embotellado (contrato O2 §6.1). */
export interface BottlingBalance {
  availableLiters: number;
  waterDilutionLiters: number;
  bottledLiters: number;
  leftoverLiters: number;
  lossLiters: number;
  lossPercent: number;
  maxLossPercent: number;
  pureAlcohol: { availableLiters: number; bottledLiters: number } | null;
  maxBottles: number;
}

export interface BottlingBalanceInput {
  productType: 'WINE' | 'SINGANI';
  /** Σ litros disponibles de las fuentes. */
  availableLiters: number;
  waterDilutionLiters: number;
  bottles: number;
  formatCl: number;
  leftoverLiters: number;
  maxLossPercent: number;
  finalAbv: number;
  /** Singani: alcohol puro del corazón disponible (litros × grado). */
  pureAlcoholAvailableLiters: number | null;
}

/** Tolerancia de medida del balance de alcohol (S-11). */
export const ALCOHOL_BALANCE_TOLERANCE = 0.005;

const round = (n: number, d = 3): number => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};

export function computeBottlingBalance(
  input: BottlingBalanceInput,
): BottlingBalance {
  const bottledLiters = (input.bottles * input.formatCl) / 100;
  const inputLiters = input.availableLiters + input.waterDilutionLiters;
  const lossLiters = inputLiters - bottledLiters - input.leftoverLiters;
  const lossPercent = inputLiters > 0 ? (lossLiters / inputLiters) * 100 : 0;
  const room = Math.max(0, inputLiters - input.leftoverLiters);
  // Tolerancia de redondeo (0,001 L) para no perder una botella por decimales
  const maxBottles = Math.floor(((room + 1e-6) * 100) / input.formatCl);
  return {
    availableLiters: round(input.availableLiters),
    waterDilutionLiters: round(input.waterDilutionLiters),
    bottledLiters: round(bottledLiters),
    leftoverLiters: round(input.leftoverLiters),
    lossLiters: round(lossLiters),
    lossPercent: round(lossPercent, 2),
    maxLossPercent: input.maxLossPercent,
    pureAlcohol:
      input.productType === 'SINGANI' &&
      input.pureAlcoholAvailableLiters !== null
        ? {
            availableLiters: round(input.pureAlcoholAvailableLiters),
            bottledLiters: round((bottledLiters * input.finalAbv) / 100),
          }
        : null,
    maxBottles,
  };
}

/**
 * Violaciones de las reglas 4–6 del §6.2 (balance de volumen y merma,
 * balance de alcohol, vino sin agua), en ese orden.
 */
export function bottlingBalanceViolations(
  input: BottlingBalanceInput,
  balance: BottlingBalance,
): ErrorDetail[] {
  const out: ErrorDetail[] = [];
  const meta = { ...balance } as unknown as Record<string, unknown>;
  const epsilon = 1e-6;
  if (
    balance.bottledLiters + balance.leftoverLiters >
    balance.availableLiters + balance.waterDilutionLiters + epsilon
  ) {
    out.push(
      violation(
        ErrorCode.TRC_BOTTLING_EXCEEDS_VOLUME,
        `${input.bottles} botellas de ${input.formatCl} cL son ${balance.bottledLiters} L y solo hay ${round(balance.availableLiters + balance.waterDilutionLiters - balance.leftoverLiters)} L disponibles: caben como máximo ${balance.maxBottles} botellas`,
        {
          field: 'totalBottlesPackaged',
          expected: balance.maxBottles,
          actual: input.bottles,
          meta,
        },
      ),
    );
  } else if (balance.lossPercent > input.maxLossPercent + epsilon) {
    out.push(
      violation(
        ErrorCode.TRC_BOTTLING_LOSS_ABOVE_TOLERANCE,
        `La merma sería del ${balance.lossPercent} % (${balance.lossLiters} L) y la tolerada por el lote es del ${input.maxLossPercent} %: declara el remanente o revisa las botellas`,
        {
          field: 'totalBottlesPackaged',
          rule: LOT_RULE_KEYS.maxLossPercent,
          expected: input.maxLossPercent,
          actual: balance.lossPercent,
          meta,
        },
      ),
    );
  }
  if (
    input.productType === 'SINGANI' &&
    balance.pureAlcohol &&
    balance.pureAlcohol.bottledLiters >
      balance.pureAlcohol.availableLiters * (1 + ALCOHOL_BALANCE_TOLERANCE) +
        epsilon
  ) {
    out.push(
      violation(
        ErrorCode.TRC_ALCOHOL_BALANCE_EXCEEDED,
        `Las botellas llevarían ${balance.pureAlcohol.bottledLiters} L de alcohol puro y el corazón solo tiene ${balance.pureAlcohol.availableLiters} L (tolerancia 0,5 %)`,
        {
          field: 'finalAlcoholAbv',
          expected: balance.pureAlcohol.availableLiters,
          actual: balance.pureAlcohol.bottledLiters,
          meta: {
            tolerancePercent: ALCOHOL_BALANCE_TOLERANCE * 100,
            unit: 'L',
          },
        },
      ),
    );
  }
  if (input.productType === 'WINE' && input.waterDilutionLiters > 0) {
    out.push(
      violation(
        ErrorCode.TRC_DILUTION_NOT_ALLOWED,
        'No se admite agua en un vino',
        {
          field: 'waterDilutionLiters',
          expected: 0,
          actual: input.waterDilutionLiters,
        },
      ),
    );
  }
  return out;
}
