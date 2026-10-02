import { ErrorCode } from '@shared/exceptions/error-codes';
import type { ErrorDetail } from '@shared/interfaces/api-response.interface';
import { calendarDay } from './dates';
import { violation } from './trace-errors';

/** Registros que admiten una corrección compensatoria (contrato O2 §9). */
export type CorrectionTargetType =
  | 'TERROIR'
  | 'HARVEST_BATCH'
  | 'MATURITY_ANALYSIS'
  | 'PHYTO_DECISION'
  | 'FERMENTATION_TANK'
  | 'FERMENTATION_LOG'
  | 'TREATMENT'
  | 'WINE_AGING'
  | 'PRODUCTION_BATCH'
  | 'BOTTLING'
  | 'LAB_ANALYSIS';

export type CorrectionKind = 'AMEND' | 'VOID';

type FieldSpec =
  | {
      kind: 'number';
      /** Mínimo (inclusive salvo `exclusiveMin`). */
      min?: number;
      max?: number;
      exclusiveMin?: boolean;
      integer?: boolean;
      nullable?: boolean;
    }
  | { kind: 'text'; maxLength: number; nullable?: boolean }
  /** Fecha de calendario (`YYYY-MM-DD` en America/La_Paz). */
  | { kind: 'date' }
  /** Instante ISO 8601. */
  | { kind: 'instant' }
  /** Remanente del embotellado: `{ liters, disposition, notes? }` o `null`. */
  | { kind: 'leftover' };

const positive = { kind: 'number', min: 0, exclusiveMin: true } as const;
const nonNegative = { kind: 'number', min: 0 } as const;
const notes = { kind: 'text', maxLength: 4000, nullable: true } as const;
const optionalMeasure = { kind: 'number', min: 0, nullable: true } as const;

/**
 * Campos corregibles por tipo de registro: **lista cerrada** (§9). Cualquier
 * otro campo → 422 `TRC_CORRECTION_FIELD_NOT_CORRECTABLE`. No son corregibles
 * el lote de pertenencia, el tipo de producto, el código de lote, los códigos
 * de botella ni el número de botellas.
 */
export const CORRECTABLE_FIELDS: Record<
  CorrectionTargetType,
  Record<string, FieldSpec>
> = {
  TERROIR: {
    altitudeMasl: positive,
    varietyName: { kind: 'text', maxLength: 200 },
    rawMaterialType: { kind: 'text', maxLength: 100 },
  },
  HARVEST_BATCH: {
    grossWeightKg: positive,
    tareWeightKg: nonNegative,
    intakeDate: { kind: 'date' },
    temperatureAtIntakeC: {
      kind: 'number',
      min: -20,
      max: 60,
      nullable: true,
    },
    notes,
  },
  MATURITY_ANALYSIS: {
    brixDegrees: { kind: 'number', min: 0, max: 40 },
    ph: { kind: 'number', min: 2, max: 5 },
    acidityGl: { kind: 'number', min: 0, max: 30 },
    measuredAt: { kind: 'instant' },
    notes,
  },
  // Un dictamen no se enmienda: se anula (`VOID`) y se dicta otro
  PHYTO_DECISION: {},
  FERMENTATION_TANK: {
    volumeFilledLiters: positive,
    finalVolumeLiters: positive,
    startDate: { kind: 'instant' },
    endDate: { kind: 'instant' },
  },
  FERMENTATION_LOG: {
    temperatureCelsius: { kind: 'number', min: -20, max: 60 },
    specificGravity: { ...positive, nullable: true },
    phValue: { ...positive, nullable: true },
    co2Observations: { kind: 'text', maxLength: 100, nullable: true },
    recordedAt: { kind: 'instant' },
    notes,
  },
  TREATMENT: {
    dosageAppliedGPerHl: positive,
    totalAppliedG: { ...positive, nullable: true },
    additiveName: { kind: 'text', maxLength: 200 },
    additiveSupplier: { kind: 'text', maxLength: 200, nullable: true },
    appliedAt: { kind: 'instant' },
    notes,
  },
  WINE_AGING: {
    plannedMonths: { kind: 'number', min: 1, integer: true },
    volumeLiters: positive,
    startDate: { kind: 'date' },
  },
  PRODUCTION_BATCH: {
    inputVolumeLiters: positive,
    headsLiters: nonNegative,
    heartLiters: positive,
    tailsLiters: nonNegative,
    vinasseLiters: optionalMeasure,
    heartAbvPercent: { ...positive, max: 100 },
    processStartDate: { kind: 'date' },
    processEndDate: { kind: 'date' },
  },
  BOTTLING: {
    finalAlcoholAbv: { ...positive, max: 100 },
    bottleType: { kind: 'text', maxLength: 100, nullable: true },
    leftover: { kind: 'leftover' },
  },
  LAB_ANALYSIS: {
    testPerformedAt: { kind: 'date' },
    actualAlcoholAbv: { ...positive, max: 100 },
    totalAlcoholAbv: { ...positive, max: 100, nullable: true },
    totalAcidityTartaricGl: positive,
    volatileAcidityAceticGl: positive,
    freeSulfurDioxideMgL: optionalMeasure,
    totalSulfurDioxideMgL: optionalMeasure,
    reducingSugarsGl: optionalMeasure,
    totalDryExtractGl: optionalMeasure,
    sugarFreeDryExtractGl: optionalMeasure,
    overpressureBar: optionalMeasure,
    methanolContentMgL: optionalMeasure,
    methanolMg100mlAa: optionalMeasure,
    copperContentMgL: optionalMeasure,
  },
};

/** Registros que se pueden anular (`VOID`: dejan de contar). */
export const VOIDABLE_TARGETS: readonly CorrectionTargetType[] = [
  'MATURITY_ANALYSIS',
  'PHYTO_DECISION',
  'FERMENTATION_LOG',
  'TREATMENT',
  'LAB_ANALYSIS',
];

/**
 * S-17: una corrección la hace quien tiene el rol para **crear** ese registro
 * (matriz del contrato O2 §14).
 */
export const CORRECTION_ROLES: Record<CorrectionTargetType, readonly string[]> =
  {
    TERROIR: ['OWNER', 'AGRONOMIST'],
    HARVEST_BATCH: ['OWNER', 'ENOLOGIST', 'AGRONOMIST', 'OPERATOR'],
    MATURITY_ANALYSIS: ['OWNER', 'ENOLOGIST', 'AGRONOMIST'],
    PHYTO_DECISION: ['OWNER', 'ENOLOGIST', 'AGRONOMIST'],
    FERMENTATION_TANK: ['OWNER', 'ENOLOGIST'],
    FERMENTATION_LOG: ['OWNER', 'ENOLOGIST', 'AGRONOMIST', 'OPERATOR'],
    TREATMENT: ['OWNER', 'ENOLOGIST'],
    WINE_AGING: ['OWNER', 'ENOLOGIST'],
    PRODUCTION_BATCH: ['OWNER', 'ENOLOGIST'],
    BOTTLING: ['OWNER', 'ENOLOGIST'],
    LAB_ANALYSIS: ['OWNER', 'ENOLOGIST'],
  };

export function canCorrect(
  type: CorrectionTargetType,
  role: string | null | undefined,
): boolean {
  return !!role && CORRECTION_ROLES[type].includes(role);
}

export interface LeftoverValue {
  liters: number;
  disposition: 'RETAINED' | 'DISCARDED';
  notes: string | null;
}

/** Valor ya validado: número, texto, día (`YYYY-MM-DD`), instante o remanente. */
export type CorrectionValue = number | string | Date | LeftoverValue | null;

export interface ParsedChanges {
  values: Record<string, CorrectionValue>;
  /** Campos fuera de la lista cerrada (`TRC_CORRECTION_FIELD_NOT_CORRECTABLE`). */
  notCorrectable: ErrorDetail[];
  /** Valores con tipo o rango inválido (`VALIDATION_ERROR`). */
  invalid: ErrorDetail[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T.*)?$/;

function parseValue(
  field: string,
  spec: FieldSpec,
  raw: unknown,
): { value: CorrectionValue } | { error: string } {
  const nullable = 'nullable' in spec && spec.nullable === true;
  if (raw === null) {
    if (nullable || spec.kind === 'leftover') return { value: null };
    return { error: `${field} no puede quedar vacío` };
  }
  switch (spec.kind) {
    case 'number': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        return { error: `${field} debe ser un número` };
      }
      if (spec.integer && !Number.isInteger(raw)) {
        return { error: `${field} debe ser un número entero` };
      }
      if (spec.min !== undefined) {
        if (spec.exclusiveMin ? raw <= spec.min : raw < spec.min) {
          return {
            error: `${field} debe ser ${spec.exclusiveMin ? 'mayor que' : 'como mínimo'} ${spec.min}`,
          };
        }
      }
      if (spec.max !== undefined && raw > spec.max) {
        return { error: `${field} debe ser como máximo ${spec.max}` };
      }
      return { value: raw };
    }
    case 'text': {
      if (typeof raw !== 'string') return { error: `${field} debe ser texto` };
      const text = raw.trim();
      if (text.length === 0) {
        return nullable
          ? { value: null }
          : { error: `${field} no puede quedar vacío` };
      }
      if (text.length > spec.maxLength) {
        return {
          error: `${field} admite como máximo ${spec.maxLength} caracteres`,
        };
      }
      return { value: text };
    }
    case 'date':
    case 'instant': {
      if (typeof raw !== 'string' || !ISO_DATE.test(raw)) {
        return { error: `${field} debe ser una fecha ISO 8601` };
      }
      const instant = new Date(raw);
      if (Number.isNaN(instant.getTime())) {
        return { error: `${field} debe ser una fecha ISO 8601` };
      }
      return { value: spec.kind === 'date' ? calendarDay(raw) : instant };
    }
    case 'leftover': {
      if (typeof raw !== 'object' || Array.isArray(raw)) {
        return {
          error: `${field} debe ser { liters, disposition, notes? } o null`,
        };
      }
      const r = raw as Record<string, unknown>;
      if (
        typeof r.liters !== 'number' ||
        !Number.isFinite(r.liters) ||
        r.liters < 0
      ) {
        return { error: `${field}.liters debe ser un número ≥ 0` };
      }
      if (r.disposition !== 'RETAINED' && r.disposition !== 'DISCARDED') {
        return { error: `${field}.disposition debe ser RETAINED o DISCARDED` };
      }
      if (
        r.notes !== undefined &&
        r.notes !== null &&
        typeof r.notes !== 'string'
      ) {
        return { error: `${field}.notes debe ser texto` };
      }
      return {
        value: {
          liters: r.liters,
          disposition: r.disposition,
          notes: typeof r.notes === 'string' ? r.notes.trim() || null : null,
        },
      };
    }
  }
}

/**
 * Valida `changes` de una corrección `AMEND` contra la lista cerrada del tipo
 * de registro: campos desconocidos y valores inválidos, por separado.
 */
export function parseCorrectionChanges(
  type: CorrectionTargetType,
  changes: Record<string, unknown>,
): ParsedChanges {
  const specs = CORRECTABLE_FIELDS[type];
  const correctable = Object.keys(specs);
  const out: ParsedChanges = { values: {}, notCorrectable: [], invalid: [] };
  for (const [field, raw] of Object.entries(changes)) {
    const spec = specs[field];
    if (!spec) {
      out.notCorrectable.push(
        violation(
          ErrorCode.TRC_CORRECTION_FIELD_NOT_CORRECTABLE,
          correctable.length > 0
            ? `El campo ${field} no se puede corregir (corregibles: ${correctable.join(', ')})`
            : `El campo ${field} no se puede corregir: este registro solo se anula (VOID)`,
          { field: `changes.${field}`, meta: { field, correctable } },
        ),
      );
      continue;
    }
    const parsed = parseValue(field, spec, raw);
    if ('error' in parsed) {
      out.invalid.push({ field: `changes.${field}`, message: parsed.error });
    } else {
      out.values[field] = parsed.value;
    }
  }
  return out;
}

/** Valor de un registro para `changes[].before|after` (JSON estable). */
export function toChangeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (
    typeof value === 'object' &&
    typeof (value as { toNumber?: unknown }).toNumber === 'function'
  ) {
    return (value as { toNumber(): number }).toNumber();
  }
  return value;
}

/** `true` si el valor nuevo no cambia nada (misma cifra, mismo día, mismo texto). */
export function sameValue(before: unknown, after: unknown): boolean {
  const a = toChangeValue(before);
  const b = toChangeValue(after);
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) < 1e-9;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}
