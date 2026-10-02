import { ErrorCode } from '@shared/exceptions/error-codes';
import type { ErrorDetail } from '@shared/interfaces/api-response.interface';
import { violation } from './trace-errors';

export interface DistillationCuts {
  headsLiters: number;
  heartLiters: number;
  tailsLiters: number;
  vinasseLiters?: number | null;
}

const round = (n: number): number => Math.round(n * 1000) / 1000;

/** Suma de los cortes (cabezas + corazón + colas + vinaza). */
export function cutsTotal(cuts: DistillationCuts): number {
  return round(
    cuts.headsLiters +
      cuts.heartLiters +
      cuts.tailsLiters +
      (cuts.vinasseLiters ?? 0),
  );
}

/**
 * Balance de masa de la destilación (contrato O2 §5.2): cabezas + corazón +
 * colas (+ vinaza) ≤ entrada. Devuelve la violación
 * `TRC_MASS_BALANCE_EXCEEDED` o `null`.
 */
export function massBalanceViolation(
  inputLiters: number,
  cuts: DistillationCuts,
  field = 'cuts',
): ErrorDetail | null {
  const total = cutsTotal(cuts);
  if (total <= inputLiters + 1e-6) return null;
  return violation(
    ErrorCode.TRC_MASS_BALANCE_EXCEEDED,
    `Los cortes suman ${total} L y la entrada fue de ${inputLiters} L`,
    {
      field,
      expected: inputLiters,
      actual: total,
      meta: { inputLiters, outputLiters: total, unit: 'L' },
    },
  );
}
