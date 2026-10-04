import { ErrorCode } from '@shared/exceptions/error-codes';
import type { ErrorDetail } from '@shared/interfaces/api-response.interface';
import { LOT_RULE_KEYS, LotRules, legalMinimumOf } from './lot-rules';
import { violation } from './trace-errors';

export type DoStatus =
  'ELIGIBLE' | 'ELIGIBLE_BY_EXCEPTION' | 'NOT_ELIGIBLE' | 'NOT_APPLICABLE';

export interface DoCheck {
  rule: 'ALTITUDE' | 'VARIETY';
  settingKey: string;
  required: number | string[];
  legalMinimum: number | string[];
  actual: number | string;
  pass: boolean;
  terroirId: string;
}

/** Aptitud D.O. Singani calculada en el servidor (contrato O2 §2.1, EA-03). */
export interface DoEvaluation {
  status: DoStatus;
  checks: DoCheck[];
  rulesSource: 'LOT_SNAPSHOT' | 'EFFECTIVE_SETTINGS';
  evaluatedAt: string;
}

/** Reglas D.O. que se aplican (instantánea del lote o valores efectivos). */
export interface DoRules {
  minAltitudeMasl: number;
  requiredVarieties: string[];
  legalExceptions: string[];
}

export interface DoTerroir {
  id: string;
  altitudeMasl: number;
  varietyName: string;
  parcelName?: string;
}

/**
 * Normaliza una cepa para compararla (§3.1): sin distinguir mayúsculas,
 * tildes ni espacios repetidos (`Moscatel de Alejandria` = `Moscatel de
 * Alejandría`). Los sinónimos son la pregunta P-7: no se aceptan.
 */
export function normalizeVariety(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function doRulesFromLot(rules: LotRules): DoRules {
  return {
    minAltitudeMasl: rules.singani.minAltitudeMasl,
    requiredVarieties: rules.singani.requiredVarieties,
    legalExceptions: rules.legalExceptions,
  };
}

function varietyIn(variety: string, list: readonly string[]): boolean {
  const target = normalizeVariety(variety);
  return list.some((v) => normalizeVariety(v) === target);
}

/**
 * Evalúa la D.O. de un conjunto de parcelas. `ELIGIBLE_BY_EXCEPTION`: cumple
 * solo gracias a un valor de la bodega bajo el mínimo legal autorizado
 * (A-31). Sin parcelas que evaluar → `NOT_APPLICABLE`.
 */
export function evaluateDo(
  terroirs: readonly DoTerroir[],
  rules: DoRules,
  rulesSource: DoEvaluation['rulesSource'],
  evaluatedAt: Date = new Date(),
): DoEvaluation {
  const legalAltitude =
    (legalMinimumOf(LOT_RULE_KEYS.minAltitudeMasl) as number | null) ??
    rules.minAltitudeMasl;
  const legalVarieties =
    (legalMinimumOf(LOT_RULE_KEYS.requiredVarieties) as string[] | null) ??
    rules.requiredVarieties;

  const checks: DoCheck[] = [];
  let byException = false;
  const seen = new Set<string>();
  for (const t of terroirs) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    const altitudePass = t.altitudeMasl >= rules.minAltitudeMasl;
    const varietyPass = varietyIn(t.varietyName, rules.requiredVarieties);
    checks.push(
      {
        rule: 'ALTITUDE',
        settingKey: LOT_RULE_KEYS.minAltitudeMasl,
        required: rules.minAltitudeMasl,
        legalMinimum: legalAltitude,
        actual: t.altitudeMasl,
        pass: altitudePass,
        terroirId: t.id,
      },
      {
        rule: 'VARIETY',
        settingKey: LOT_RULE_KEYS.requiredVarieties,
        required: [...rules.requiredVarieties],
        legalMinimum: [...legalVarieties],
        actual: t.varietyName,
        pass: varietyPass,
        terroirId: t.id,
      },
    );
    if (
      altitudePass &&
      t.altitudeMasl < legalAltitude &&
      rules.legalExceptions.includes(LOT_RULE_KEYS.minAltitudeMasl)
    ) {
      byException = true;
    }
    if (
      varietyPass &&
      !varietyIn(t.varietyName, legalVarieties) &&
      rules.legalExceptions.includes(LOT_RULE_KEYS.requiredVarieties)
    ) {
      byException = true;
    }
  }

  let status: DoStatus;
  if (checks.length === 0) status = 'NOT_APPLICABLE';
  else if (checks.some((c) => !c.pass)) status = 'NOT_ELIGIBLE';
  else status = byException ? 'ELIGIBLE_BY_EXCEPTION' : 'ELIGIBLE';

  return {
    status,
    checks,
    rulesSource,
    evaluatedAt: evaluatedAt.toISOString(),
  };
}

export function isDoEligible(status: DoStatus): boolean {
  return status === 'ELIGIBLE' || status === 'ELIGIBLE_BY_EXCEPTION';
}

/**
 * Un detalle por regla incumplida (`TRC_DO_TERROIR_NOT_ELIGIBLE` o
 * `TRC_DO_NOT_ELIGIBLE`), con la regla, lo exigido y lo registrado.
 */
export function doViolations(
  evaluation: DoEvaluation,
  code:
    | typeof ErrorCode.TRC_DO_TERROIR_NOT_ELIGIBLE
    | typeof ErrorCode.TRC_DO_NOT_ELIGIBLE,
  names: Record<string, string> = {},
  extraMeta: (terroirId: string) => Record<string, unknown> = () => ({}),
): ErrorDetail[] {
  return evaluation.checks
    .filter((c) => !c.pass)
    .map((c) => {
      const parcel = names[c.terroirId] ?? 'La parcela';
      const message =
        c.rule === 'ALTITUDE'
          ? `D.O. Singani: ${parcel} está a ${c.actual} msnm; el mínimo del lote es ${c.required as number} msnm`
          : `D.O. Singani: la cepa "${c.actual}" de ${parcel} no está entre las exigidas (${(c.required as string[]).join(', ')})`;
      return violation(code, message, {
        field:
          code === ErrorCode.TRC_DO_TERROIR_NOT_ELIGIBLE ? 'terroirId' : null,
        rule: c.settingKey,
        expected: c.required,
        actual: c.actual,
        meta: {
          terroirId: c.terroirId,
          check: c.rule,
          ...extraMeta(c.terroirId),
        },
      });
    });
}
