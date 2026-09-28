/** Datos de las fuentes del embotellado (crianzas y destilaciones). */

type Num = { toNumber(): number } | number | null | undefined;

export function num(value: Num): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' ? value : value.toNumber();
}

export interface DistillationLike {
  heartLiters?: Num;
  outputVolumeLiters?: Num;
  heartAbvPercent?: Num;
  initialAlcoholPercentage?: Num;
  headsLiters?: Num;
  tailsLiters?: Num;
  additionalParams?: unknown;
}

/**
 * Corazón de una destilación: `heartLiters` (Ola 2) o, en los registros
 * anteriores, `outputVolumeLiters`; su grado, `heartAbvPercent` o el
 * `initialAlcoholPercentage` legado ("graduación del corazón", ver su DTO).
 */
export function distillationHeart(p: DistillationLike): {
  liters: number | null;
  abv: number | null;
} {
  return {
    liters: num(p.heartLiters) ?? num(p.outputVolumeLiters),
    abv: num(p.heartAbvPercent) ?? num(p.initialAlcoholPercentage),
  };
}

/** Cortes legados guardados en `additionalParams` (`headDiscardLiters`…). */
export function legacyCuts(additionalParams: unknown): {
  heads: number | null;
  heart: number | null;
  tails: number | null;
} {
  const p =
    typeof additionalParams === 'object' && additionalParams !== null
      ? (additionalParams as Record<string, unknown>)
      : {};
  const n = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  return {
    heads: n(p.headDiscardLiters),
    heart: n(p.heartYieldLiters),
    tails: n(p.tailDiscardLiters),
  };
}

/** Litros de un tanque: el volumen final si se registró; si no, el llenado. */
export function tankLiters(t: {
  finalVolumeLiters?: Num;
  volumeFilledLiters?: Num;
}): number | null {
  return num(t.finalVolumeLiters) ?? num(t.volumeFilledLiters);
}
