import { CSV_BOM, csvCell } from '@modules/audit/audit-csv';
import { formatBottleCode } from './bottle-code';

/**
 * CSV de los códigos de botella para la imprenta (contrato O2 §7.2):
 * `serial,code,codeFormatted,qrUrl,lotCode,lotName,productType,bottlingDate`,
 * una fila por código **activo**, por número de serie. Como los demás CSV del
 * backend: UTF-8 con BOM (Excel abre bien las tildes), separador coma, CRLF
 * (RFC 4180) y celdas que empiezan como una fórmula neutralizadas.
 */
export const BOTTLE_CSV_COLUMNS = [
  'serial',
  'code',
  'codeFormatted',
  'qrUrl',
  'lotCode',
  'lotName',
  'productType',
  'bottlingDate',
] as const;

export const BOTTLE_CSV_HEADER = BOTTLE_CSV_COLUMNS.join(',');

const CSV_EOL = '\r\n';

export interface BottleCsvContext {
  lotCode: string;
  lotName: string;
  productType: string;
  /** `YYYY-MM-DD`. */
  bottlingDate: string;
  /** URL del pasaporte de un código (`{PASSPORT_BASE_URL}/b/{código}`). */
  qrUrl: (code: string) => string;
}

/** Cabecera del CSV (con BOM y fin de línea). */
export function bottleCsvHeader(): string {
  return CSV_BOM + BOTTLE_CSV_HEADER + CSV_EOL;
}

/** Una fila del CSV (con su fin de línea). */
export function bottleCsvRow(
  unit: { serial: number; code: string },
  context: BottleCsvContext,
): string {
  return (
    [
      unit.serial,
      unit.code,
      formatBottleCode(unit.code),
      context.qrUrl(unit.code),
      context.lotCode,
      context.lotName,
      context.productType,
      context.bottlingDate,
    ]
      .map(csvCell)
      .join(',') + CSV_EOL
  );
}

function safeFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

/** `codigos-CVJ-2026-SINGANI-004-1-2950.csv` (o `.zip`). */
export function bottleExportFilename(
  lotCode: string,
  range: { fromSerial: number; toSerial: number },
  extension: 'csv' | 'zip',
): string {
  return `codigos-${safeFilePart(lotCode) || 'lote'}-${range.fromSerial}-${range.toSerial}.${extension}`;
}
