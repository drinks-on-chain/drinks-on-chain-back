import { LOT_RULE_KEYS, LotRules } from './lot-rules';
import { addDays, addMonths, daysBetween, laterOf } from './dates';

/** Candado de una fuente del lote (contrato O2 §2.1). */
export interface LotLock {
  kind: 'AGING' | 'REST';
  sourceId: string;
  /** `YYYY-MM-DD` en America/La_Paz. */
  unlockDate: string;
  released: boolean;
  daysRemaining: number;
  rule: {
    settingKey: string;
    minimum: number;
    applied: number;
    unit: 'meses' | 'días';
    legalException: boolean;
  };
}

export interface AgingLockInput {
  id: string;
  /** Inicio de la crianza (`YYYY-MM-DD`). */
  startDate: string;
  plannedMonths: number;
  /** `lock_until_date` guardado (registros anteriores a la Ola 2). */
  storedUnlockDate: string | null;
}

export interface RestLockInput {
  id: string;
  /** Fin de la destilación (`YYYY-MM-DD`); `null` = abierta (sin candado todavía). */
  processEndDate: string | null;
  /** `mandatory_rest_until` guardado (registros anteriores a la Ola 2). */
  storedUnlockDate: string | null;
}

/**
 * Candado de crianza: inicio + meses planificados (nunca menos que el mínimo
 * de la instantánea), en meses de calendario. Con un registro anterior a la
 * Ola 2 manda la fecha más tardía entre la calculada y la guardada.
 */
export function agingLock(
  input: AgingLockInput,
  rules: LotRules,
  today: string,
): LotLock {
  const minimum = rules.wine.minAgingMonths;
  const applied = Math.max(input.plannedMonths, minimum);
  const unlockDate = laterOf(
    addMonths(input.startDate, applied),
    input.storedUnlockDate,
  ) as string;
  return finish('AGING', input.id, unlockDate, today, {
    settingKey: LOT_RULE_KEYS.minAgingMonths,
    minimum,
    applied,
    unit: 'meses',
    legalException: rules.legalExceptions.includes(
      LOT_RULE_KEYS.minAgingMonths,
    ),
  });
}

/**
 * Candado de reposo del singani: fin de la destilación + reposo mínimo de la
 * instantánea (no más 180 días fijos). `null` si la destilación sigue abierta.
 */
export function restLock(
  input: RestLockInput,
  rules: LotRules,
  today: string,
): LotLock | null {
  if (!input.processEndDate) return null;
  const minimum = rules.singani.minRestDays;
  const unlockDate = laterOf(
    addDays(input.processEndDate, minimum),
    input.storedUnlockDate,
  ) as string;
  return finish('REST', input.id, unlockDate, today, {
    settingKey: LOT_RULE_KEYS.minRestDays,
    minimum,
    applied: minimum,
    unit: 'días',
    legalException: rules.legalExceptions.includes(LOT_RULE_KEYS.minRestDays),
  });
}

function finish(
  kind: LotLock['kind'],
  sourceId: string,
  unlockDate: string,
  today: string,
  rule: LotLock['rule'],
): LotLock {
  const remaining = daysBetween(today, unlockDate);
  return {
    kind,
    sourceId,
    unlockDate,
    released: remaining <= 0,
    daysRemaining: Math.max(0, remaining),
    rule,
  };
}

/** Próximo candado sin liberar (el que antes se libera), o `null`. */
export function nextLock(locks: readonly LotLock[]): LotLock | null {
  const pending = locks.filter((l) => !l.released);
  if (pending.length === 0) return null;
  return pending.reduce((a, b) => (a.unlockDate <= b.unlockDate ? a : b));
}

/** Fecha en que el lote queda listo por candados (el último en liberarse). */
export function readyDateFromLocks(locks: readonly LotLock[]): string | null {
  if (locks.length === 0) return null;
  return locks.reduce((a, b) => (a.unlockDate >= b.unlockDate ? a : b))
    .unlockDate;
}
