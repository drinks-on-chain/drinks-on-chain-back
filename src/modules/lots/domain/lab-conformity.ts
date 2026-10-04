import type { ErrorDetail } from '@shared/interfaces/api-response.interface';
import { ErrorCode } from '@shared/exceptions/error-codes';
import type { LabLimit } from './lot-rules';

export type LabConformityStatus =
  'CONFORMING' | 'NON_CONFORMING' | 'INCOMPLETE';
export type LabCheckResult = 'PASS' | 'FAIL' | 'MISSING' | 'UNIT_UNKNOWN';

export interface LabCheck {
  parameter: string;
  value: number | null;
  unit: string;
  limit: LabLimit | null;
  result: LabCheckResult;
}

/** Conformidad del laboratorio calculada con unidades (contrato O2 §8.3, EA-08). */
export interface LabConformity {
  status: LabConformityStatus;
  checks: LabCheck[];
  warnings: ErrorDetail[];
  rulesTakenAt: string;
}

/** Unidades de cada campo del análisis (§8.2), explícitas en la respuesta (`units`). */
export const LAB_UNITS = {
  actualAlcoholAbv: '% v/v a 20 °C',
  totalAlcoholAbv: '% v/v a 20 °C',
  totalAcidityTartaricGl: 'g/L como ácido tartárico',
  volatileAcidityAceticGl: 'g/L como ácido acético',
  freeSulfurDioxideMgL: 'mg/L',
  totalSulfurDioxideMgL: 'mg/L',
  reducingSugarsGl: 'g/L',
  totalDryExtractGl: 'g/L',
  sugarFreeDryExtractGl: 'g/L',
  overpressureBar: 'bar',
  methanolContentMgL: 'mg/L de producto',
  methanolMg100mlAa: 'mg/100 mL de alcohol anhidro',
  copperContentMgL: 'mg/L',
} as const;

/** Parámetros exigidos por producto (S-16). */
export const REQUIRED_LAB_PARAMETERS: Record<'WINE' | 'SINGANI', string[]> = {
  SINGANI: ['metanol', 'cobre', 'grado'],
  WINE: ['acidezVolatil', 'grado'],
};

/** Valores medidos que entran en la conformidad. */
export interface LabValues {
  actualAlcoholAbv: number | null;
  volatileAcidityAceticGl: number | null;
  methanolMg100mlAa: number | null;
  copperContentMgL: number | null;
}

type UnitKind = 'mg/100ml a.a.' | 'mg/l' | 'g/l' | '% v/v' | 'unknown';

/** Unidad normalizada de un límite del catálogo (`mg/100 ml a.a.`, `mg/l`, `g/l`). */
export function normalizeUnit(unit: string): UnitKind {
  const u = unit.toLowerCase().replace(/\s+/g, '').replace(/\.$/, '');
  if (/^mg\/100ml(a\.?a|alcoholanhidro)/.test(u)) return 'mg/100ml a.a.';
  if (u === 'mg/l' || u === 'mg/lt') return 'mg/l';
  if (u === 'g/l' || u === 'g/lt') return 'g/l';
  if (u.startsWith('%')) return '% v/v';
  return 'unknown';
}

/**
 * Metanol en mg/100 mL de alcohol anhidro a partir de mg/L de producto y el
 * grado (§8.2): `10 × mgL / grado`.
 */
export function methanolToAnhydrous(mgL: number, abv: number): number | null {
  if (!(abv > 0)) return null;
  return Math.round(((10 * mgL) / abv) * 1000) / 1000;
}

interface ParameterSource {
  value: number | null;
  unit: UnitKind;
  label: string;
}

function sourceOf(
  parameter: string,
  values: LabValues,
): ParameterSource | null {
  switch (parameter) {
    case 'metanol':
      return {
        value: values.methanolMg100mlAa,
        unit: 'mg/100ml a.a.',
        label: LAB_UNITS.methanolMg100mlAa,
      };
    case 'cobre':
      return { value: values.copperContentMgL, unit: 'mg/l', label: 'mg/L' };
    case 'acidezVolatil':
      return {
        value: values.volatileAcidityAceticGl,
        unit: 'g/l',
        label: 'g/L',
      };
    case 'grado':
      return {
        value: values.actualAlcoholAbv,
        unit: '% v/v',
        label: LAB_UNITS.actualAlcoholAbv,
      };
    default:
      return null;
  }
}

/** Convierte `value` de la unidad del parámetro a la del límite (o `null` si no se sabe). */
function convert(
  value: number,
  from: UnitKind,
  to: UnitKind,
  abv: number | null,
): number | null {
  if (from === to) return value;
  if (from === 'mg/l' && to === 'g/l') return value / 1000;
  if (from === 'g/l' && to === 'mg/l') return value * 1000;
  // Metanol: mg/100 mL a.a. → mg/L de producto con el grado
  if (from === 'mg/100ml a.a.' && to === 'mg/l' && abv && abv > 0) {
    return (value * abv) / 10;
  }
  return null;
}

/**
 * Conformidad contra los límites de la instantánea del lote. Falta un
 * parámetro exigido → `INCOMPLETE` (nunca conforme por omisión); unidad del
 * límite desconocida → `UNIT_UNKNOWN` e `INCOMPLETE`; un parámetro fuera de
 * su límite → `NON_CONFORMING`. Aviso (no bloqueo) si el grado medido
 * difiere más de 0,5 % vol del etiquetado (S-15).
 */
export function computeLabConformity(input: {
  productType: 'WINE' | 'SINGANI' | null;
  values: LabValues;
  limits: Record<string, LabLimit>;
  labeledAbv: number | null;
  rulesTakenAt: string;
}): LabConformity {
  const required = input.productType
    ? REQUIRED_LAB_PARAMETERS[input.productType]
    : ['grado'];
  const parameters = [
    ...required,
    ...Object.keys(input.limits).filter((p) => !required.includes(p)),
  ];
  const checks: LabCheck[] = [];
  for (const parameter of parameters) {
    const source = sourceOf(parameter, input.values);
    const limit = input.limits[parameter] ?? null;
    const isRequired = required.includes(parameter);
    if (!source) {
      // Límite configurado para un parámetro que el análisis no registra
      if (isRequired) {
        checks.push({
          parameter,
          value: null,
          unit: limit?.unidad ?? '',
          limit,
          result: 'MISSING',
        });
      }
      continue;
    }
    if (source.value === null || source.value === undefined) {
      if (isRequired) {
        checks.push({
          parameter,
          value: null,
          unit: source.label,
          limit,
          result: 'MISSING',
        });
      }
      continue;
    }
    if (!limit) {
      checks.push({
        parameter,
        value: source.value,
        unit: source.label,
        limit: null,
        result: 'PASS',
      });
      continue;
    }
    const target = normalizeUnit(limit.unidad);
    const value =
      target === 'unknown'
        ? null
        : convert(
            source.value,
            source.unit,
            target,
            input.values.actualAlcoholAbv,
          );
    if (value === null) {
      checks.push({
        parameter,
        value: source.value,
        unit: source.label,
        limit,
        result: 'UNIT_UNKNOWN',
      });
      continue;
    }
    const fail =
      (limit.max !== undefined && value > limit.max) ||
      (limit.min !== undefined && value < limit.min);
    checks.push({
      parameter,
      value: source.value,
      unit: source.label,
      limit,
      result: fail ? 'FAIL' : 'PASS',
    });
  }

  let status: LabConformityStatus;
  if (checks.some((c) => c.result === 'FAIL')) status = 'NON_CONFORMING';
  else if (
    checks.some((c) => c.result === 'MISSING' || c.result === 'UNIT_UNKNOWN')
  )
    status = 'INCOMPLETE';
  else status = 'CONFORMING';

  const warnings: ErrorDetail[] = [];
  const measured = input.values.actualAlcoholAbv;
  if (
    measured !== null &&
    input.labeledAbv !== null &&
    Math.abs(measured - input.labeledAbv) > 0.5
  ) {
    warnings.push({
      field: 'actualAlcoholAbv',
      message: `El grado medido (${measured} % vol) difiere más de 0,5 % vol del embotellado (${input.labeledAbv} % vol)`,
      code: 'LAB_ABV_DEVIATION',
      expected: input.labeledAbv,
      actual: measured,
      meta: { toleranceAbv: 0.5 },
    });
  }
  for (const c of checks.filter((x) => x.result === 'UNIT_UNKNOWN')) {
    warnings.push({
      field: null,
      message: `Unidad del límite "${c.parameter}" desconocida (${c.limit?.unidad ?? 'sin unidad'}): revisa la configuración`,
      code: ErrorCode.VALIDATION_ERROR,
      meta: { parameter: c.parameter },
    });
  }

  return { status, checks, warnings, rulesTakenAt: input.rulesTakenAt };
}
