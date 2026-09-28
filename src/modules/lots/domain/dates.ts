/**
 * Fechas de calendario de la producción (contrato O2 §0): se interpretan en
 * America/La_Paz y viajan como `YYYY-MM-DD`. Las columnas `@db.Date` llegan
 * de Prisma como medianoche UTC de ese día.
 */
export const PRODUCTION_TIME_ZONE = 'America/La_Paz';

const YMD = /^\d{4}-\d{2}-\d{2}$/;

const laPazFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: PRODUCTION_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Día de calendario en La Paz de un instante. */
export function laPazDate(instant: Date): string {
  return laPazFormatter.format(instant);
}

/** `YYYY-MM-DD` de una columna `@db.Date` (medianoche UTC). */
export function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** Día de una fecha enviada por el cliente: `YYYY-MM-DD` tal cual; un instante, su día en La Paz. */
export function calendarDay(value: string | Date): string {
  if (typeof value === 'string' && YMD.test(value)) return value;
  return laPazDate(typeof value === 'string' ? new Date(value) : value);
}

function toUtc(ymd: string): Date {
  if (!YMD.test(ymd)) throw new Error(`Fecha inválida: ${ymd}`);
  return new Date(`${ymd}T00:00:00.000Z`);
}

/** `ymd` + `days` días. */
export function addDays(ymd: string, days: number): string {
  const d = toUtc(ymd);
  d.setUTCDate(d.getUTCDate() + days);
  return dateOnly(d);
}

/**
 * `ymd` + `months` meses de calendario; si el día no existe en el mes de
 * destino, el último día de ese mes (31-01 + 1 mes = 28/29-02).
 */
export function addMonths(ymd: string, months: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = total % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return dateOnly(new Date(Date.UTC(year, month, Math.min(d, lastDay))));
}

/** Días de `from` a `to` (negativo si `to` es anterior). */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to).getTime() - toUtc(from).getTime()) / 86_400_000);
}

/** La más tardía de dos fechas `YYYY-MM-DD` (ignora `null`). */
export function laterOf(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

/** `Date` de una fecha de calendario para una columna `@db.Date`. */
export function toDbDate(ymd: string): Date {
  return toUtc(ymd);
}
