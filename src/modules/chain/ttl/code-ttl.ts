import { LEDGERS_PER_DAY } from '../chain.constants';

/**
 * Última lectura de la vida del código compartido (contrato O3 §2.4 y §8.3).
 * La escribe el worker (tarea de TTL y conciliación) en `chain_cursors`
 * (`cursor` = último ledger en que vive, `last_ledger` = ledger de la
 * lectura); la API la convierte en `codeTtlDays` sin consultar la red.
 */
export const CODE_TTL_CURSOR = 'code-ttl';

const DAY_MS = 86_400_000;

/**
 * Días de vida que le quedan al código: los de la lectura menos los que han
 * pasado desde entonces (nunca negativo). `null` sin una lectura válida.
 */
export function codeTtlDays(
  reading: {
    cursor: string | null;
    lastLedger: number | null;
    updatedAt: Date;
  } | null,
  now: Date = new Date(),
): number | null {
  if (!reading?.cursor || reading.lastLedger === null) return null;
  const liveUntil = Number(reading.cursor);
  if (!Number.isInteger(liveUntil)) return null;
  const atReading = (liveUntil - reading.lastLedger) / LEDGERS_PER_DAY;
  const elapsed = Math.max(
    0,
    (now.getTime() - reading.updatedAt.getTime()) / DAY_MS,
  );
  return Math.max(0, Math.floor(atReading - elapsed));
}
