import {
  DEFAULT_LAB_LIMITS,
  settingEntry,
} from '@modules/settings/settings.catalog';
import type { SettingsSnapshot } from '@modules/settings/settings.types';

/** Claves del catálogo con `appliesAt: 'LOT'` que usa el lote (docs-back/05 §4). */
export const LOT_RULE_KEYS = {
  minAltitudeMasl: 'trazabilidad.singani.altitudMinimaMsnm',
  requiredVarieties: 'trazabilidad.singani.variedadesExigidas',
  minRestDays: 'trazabilidad.singani.reposoMinimoDias',
  minAgingMonths: 'trazabilidad.vino.crianzaMinimaMeses',
  requireApproved: 'trazabilidad.fitosanitario.exigirAprobado',
  maxLossPercent: 'trazabilidad.embotellado.mermaMaximaPorcentaje',
  labLimits: 'trazabilidad.laboratorio.limites',
} as const;

export interface LabLimit {
  max?: number;
  min?: number;
  unidad: string;
}

export type LotRulesOrigin = 'LOT_CREATION' | 'MIGRATION';

/** Instantánea de reglas del lote (contrato O2 §2.3). No se edita nunca. */
export interface LotRules {
  takenAt: string;
  origin: LotRulesOrigin;
  singani: {
    minAltitudeMasl: number;
    requiredVarieties: string[];
    minRestDays: number;
  };
  wine: { minAgingMonths: number };
  phytosanitary: { requireApproved: boolean };
  bottling: { maxLossPercent: number };
  lab: { limits: Record<string, LabLimit> };
  /** Claves con un valor bajo el mínimo legal autorizado (A-31). */
  legalExceptions: string[];
  sources: Record<string, 'GLOBAL' | 'WINERY'>;
  /** Copia literal de la instantánea (compatibilidad futura). */
  values: Record<string, unknown>;
}

function defaultOf<T>(key: string): T {
  return settingEntry(key)?.default as T;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringList(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
    ? [...(value as string[])]
    : fallback;
}

function labLimits(value: unknown): Record<string, LabLimit> {
  const source =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : (DEFAULT_LAB_LIMITS as Record<string, unknown>);
  const limits: Record<string, LabLimit> = {};
  for (const [key, raw] of Object.entries(source)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const limit: LabLimit = {
      unidad: typeof r.unidad === 'string' ? r.unidad : '',
    };
    if (typeof r.max === 'number') limit.max = r.max;
    if (typeof r.min === 'number') limit.min = r.min;
    limits[key] = limit;
  }
  return limits;
}

/** Reglas del lote a partir de la instantánea de `SettingsService`. */
export function buildLotRules(
  snapshot: SettingsSnapshot,
  origin: LotRulesOrigin,
): LotRules {
  const v = snapshot.values;
  const K = LOT_RULE_KEYS;
  const sources: LotRules['sources'] = {};
  for (const [key, source] of Object.entries(snapshot.sources)) {
    sources[key] = source === 'WINERY' ? 'WINERY' : 'GLOBAL';
  }
  return {
    takenAt: snapshot.takenAt,
    origin,
    singani: {
      minAltitudeMasl: numberOr(
        v[K.minAltitudeMasl],
        defaultOf<number>(K.minAltitudeMasl),
      ),
      requiredVarieties: stringList(
        v[K.requiredVarieties],
        defaultOf<string[]>(K.requiredVarieties),
      ),
      minRestDays: numberOr(v[K.minRestDays], defaultOf<number>(K.minRestDays)),
    },
    wine: {
      minAgingMonths: numberOr(
        v[K.minAgingMonths],
        defaultOf<number>(K.minAgingMonths),
      ),
    },
    phytosanitary: {
      requireApproved:
        typeof v[K.requireApproved] === 'boolean'
          ? (v[K.requireApproved] as boolean)
          : defaultOf<boolean>(K.requireApproved),
    },
    bottling: {
      maxLossPercent: numberOr(
        v[K.maxLossPercent],
        defaultOf<number>(K.maxLossPercent),
      ),
    },
    lab: { limits: labLimits(v[K.labLimits]) },
    legalExceptions: [...snapshot.legalExceptions],
    sources,
    values: { ...v },
  };
}

/** Lee la instantánea guardada en `lots.rules` (JSON). */
export function parseLotRules(json: unknown): LotRules {
  const raw = (json ?? {}) as Partial<LotRules>;
  const values = (raw.values ?? {}) as Record<string, unknown>;
  const rebuilt = buildLotRules(
    {
      wineryId: '',
      takenAt: raw.takenAt ?? new Date(0).toISOString(),
      values: values as SettingsSnapshot['values'],
      sources: (raw.sources ?? {}) as SettingsSnapshot['sources'],
      legalExceptions: raw.legalExceptions ?? [],
    },
    raw.origin === 'MIGRATION' ? 'MIGRATION' : 'LOT_CREATION',
  );
  // Lo guardado manda sobre lo reconstruido (la instantánea no cambia)
  return {
    ...rebuilt,
    singani: { ...rebuilt.singani, ...(raw.singani ?? {}) },
    wine: { ...rebuilt.wine, ...(raw.wine ?? {}) },
    phytosanitary: { ...rebuilt.phytosanitary, ...(raw.phytosanitary ?? {}) },
    bottling: { ...rebuilt.bottling, ...(raw.bottling ?? {}) },
    lab: raw.lab?.limits ? { limits: labLimits(raw.lab.limits) } : rebuilt.lab,
  };
}

/** Mínimo legal (A-31) de una clave del catálogo, si lo tiene. */
export function legalMinimumOf(key: string): number | string[] | null {
  const legal = settingEntry(key)?.legalMinimum;
  if (legal === undefined || legal === null) return null;
  return typeof legal === 'number' ? legal : [...legal];
}
