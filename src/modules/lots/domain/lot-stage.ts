export type LotStage =
  | 'ORIGIN'
  | 'HARVEST'
  | 'FERMENTING'
  | 'AGING'
  | 'DISTILLING'
  | 'RESTING'
  | 'BOTTLED'
  | 'CERTIFIED'
  | 'ANCHORED'
  | 'REJECTED'
  | 'DISCARDED';

export type LotProductType = 'WINE' | 'SINGANI';

/** Etapas terminales en esta ola: toda escritura → 409 `TRC_LOT_TERMINAL`. */
export const TERMINAL_STAGES: readonly LotStage[] = [
  'REJECTED',
  'DISCARDED',
  'CERTIFIED',
  'ANCHORED',
];

/** Registros del lote con lo que decide su etapa. */
export interface LotStageInput {
  discarded: boolean;
  dossierClosed: boolean;
  /** El expediente cerrado ya está anclado en la red (contrato O3 §7.2). */
  anchored?: boolean;
  productType: LotProductType | null;
  harvestStatuses: readonly string[];
  tanks: readonly { status: string }[];
  agings: readonly { discarded: boolean }[];
  distillations: readonly { closed: boolean; discarded: boolean }[];
  bottled: boolean;
}

/**
 * Etapa calculada a partir de los registros (contrato O2 §2.2); ninguna ruta
 * la fija a mano salvo el descarte.
 */
export function deriveLotStage(input: LotStageInput): LotStage {
  if (input.discarded) return 'DISCARDED';
  if (input.dossierClosed) return input.anchored ? 'ANCHORED' : 'CERTIFIED';
  if (input.bottled) return 'BOTTLED';
  const distillations = input.distillations.filter((d) => !d.discarded);
  const agings = input.agings.filter((a) => !a.discarded);
  if (distillations.length > 0 && input.productType !== 'WINE') {
    return distillations.some((d) => !d.closed) ? 'DISTILLING' : 'RESTING';
  }
  if (agings.length > 0) return 'AGING';
  if (distillations.length > 0) {
    return distillations.some((d) => !d.closed) ? 'DISTILLING' : 'RESTING';
  }
  if (input.tanks.length > 0) return 'FERMENTING';
  if (input.harvestStatuses.length > 0) {
    return input.harvestStatuses.every((s) => s === 'REJECTED')
      ? 'REJECTED'
      : 'HARVEST';
  }
  return 'ORIGIN';
}

/** Tipo de producto del destino de un tanque (`WINE_AGING` ↔ `WINE`). */
export function productTypeOfDestination(
  destination: string | null | undefined,
): LotProductType | null {
  if (destination === 'WINE_AGING') return 'WINE';
  if (destination === 'SINGANI_DIST') return 'SINGANI';
  return null;
}
