import { ErrorCode } from '@shared/exceptions/error-codes';
import {
  ruleError,
  TraceRuleException,
  violation,
} from './domain/trace-errors';

/** Tolerancia de los instantes futuros (contrato O2 §0). */
export const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

interface Clock {
  now: Date;
  today: string;
}

/** 422 `TRC_DATE_IN_FUTURE` de un día de calendario posterior a hoy (La Paz). */
export function futureDay(
  field: string,
  day: string,
  today: string,
): TraceRuleException {
  return ruleError(
    ErrorCode.TRC_DATE_IN_FUTURE,
    'La fecha no puede ser futura',
    [
      violation(ErrorCode.TRC_DATE_IN_FUTURE, 'Fecha futura', {
        field,
        expected: today,
        actual: day,
        meta: { field },
      }),
    ],
  );
}

export function assertDayNotFuture(
  field: string,
  day: string,
  clock: Clock,
): void {
  if (day > clock.today) throw futureDay(field, day, clock.today);
}

/** Un instante no puede ser futuro (5 min de tolerancia, reloj de la base). */
export function assertInstantNotFuture(
  field: string,
  value: Date,
  clock: Clock,
): void {
  if (value.getTime() > clock.now.getTime() + FUTURE_TOLERANCE_MS) {
    throw ruleError(
      ErrorCode.TRC_DATE_IN_FUTURE,
      'La fecha no puede ser futura',
      [
        violation(ErrorCode.TRC_DATE_IN_FUTURE, 'Fecha futura', {
          field,
          expected: clock.now.toISOString(),
          actual: value.toISOString(),
          meta: { field },
        }),
      ],
    );
  }
}

/** 422 `TRC_DATE_BEFORE_PREVIOUS_STAGE` con el mínimo admitido en `meta.minimum`. */
export function beforePreviousStage(
  field: string,
  actual: string,
  minimum: string,
  message = 'La fecha es anterior a la etapa previa',
): TraceRuleException {
  return ruleError(ErrorCode.TRC_DATE_BEFORE_PREVIOUS_STAGE, message, [
    violation(ErrorCode.TRC_DATE_BEFORE_PREVIOUS_STAGE, message, {
      field,
      expected: minimum,
      actual,
      meta: { field, minimum },
    }),
  ]);
}

/** Días (`YYYY-MM-DD`) o instantes ISO: `value` no puede ser anterior a `minimum`. */
export function assertNotBefore(
  field: string,
  value: string | Date,
  minimum: string | Date,
  message?: string,
): void {
  const v = typeof value === 'string' ? value : value.toISOString();
  const m = typeof minimum === 'string' ? minimum : minimum.toISOString();
  if (v < m) throw beforePreviousStage(field, v, m, message);
}

/**
 * Instante de un día de calendario de La Paz (UTC−4, sin horario de verano):
 * su mediodía. Así `laPazDate(instante)` devuelve el mismo día.
 */
export function laPazNoon(day: string): Date {
  return new Date(`${day}T16:00:00.000Z`);
}
