import { CSV_BOM, csvCell } from '@modules/audit/audit-csv';
import type { WaitlistEntryDto } from './dto/waitlist.dto';

/**
 * CSV de la lista de espera (`GET /v1/platform/waitlist/export`, contrato
 * O1b §2). Como el de la bitácora: UTF-8 con BOM, RFC 4180 con CRLF y celdas
 * protegidas contra fórmulas. Sin IP ni agente de usuario.
 */
export const WAITLIST_CSV_COLUMNS = [
  'position',
  'type',
  'status',
  'fullName',
  'email',
  'phone',
  'city',
  'interest',
  'wineryName',
  'region',
  'produces',
  'message',
  'locale',
  'source',
  'consentAt',
  'createdAt',
  'contactedAt',
  'contactedBy',
  'notes',
] as const satisfies readonly (keyof WaitlistEntryDto)[];

/** Máximo de filas de una exportación (más → 422 `WAITLIST_EXPORT_TOO_LARGE`). */
export const WAITLIST_EXPORT_MAX_ROWS = 50_000;

const CSV_EOL = '\r\n';

/** Cabecera del CSV (con BOM). */
export function waitlistCsvHeader(): string {
  return CSV_BOM + WAITLIST_CSV_COLUMNS.join(',') + CSV_EOL;
}

/** Una fila del CSV (con su fin de línea). */
export function waitlistCsvRow(entry: WaitlistEntryDto): string {
  return (
    WAITLIST_CSV_COLUMNS.map((column) => csvCell(entry[column])).join(',') +
    CSV_EOL
  );
}

/** Nombre del archivo: `lista-de-espera-20261001-1430.csv` (UTC). */
export function waitlistExportFilename(now: Date = new Date()): string {
  const iso = now.toISOString(); // 2026-10-01T14:30:00.000Z
  return `lista-de-espera-${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 13)}${iso.slice(14, 16)}.csv`;
}
