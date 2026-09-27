import type { AuditEventView } from '@shared/audit/audit.types';

/**
 * CSV de la bitácora (`GET /v1/platform/audit/export`, contrato O1 §7).
 * Columnas iguales a las de `@drinks-on-chain/mocks`; RFC 4180 con CRLF.
 */
export const AUDIT_CSV_COLUMNS = [
  'seq',
  'occurredAt',
  'actorUserId',
  'actorFullName',
  'actorRole',
  'actorOrganizationId',
  'viaPlatform',
  'app',
  'ip',
  'action',
  'resourceType',
  'resourceId',
  'organizationId',
  'reason',
  'before',
  'after',
  'correlationId',
  'prevHash',
  'hash',
] as const;

/** Máximo de filas de una exportación (más → 422 `AUDIT_EXPORT_TOO_LARGE`). */
export const AUDIT_EXPORT_MAX_ROWS = 50_000;

/** BOM UTF-8: Excel abre el archivo con tildes y eñes bien. */
export const CSV_BOM = '﻿';

const CSV_EOL = '\r\n';

/**
 * Caracteres que una hoja de cálculo interpreta como fórmula al inicio de una
 * celda (inyección de fórmulas, OWASP "CSV Injection").
 */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * Una celda segura: texto que empieza como una fórmula se neutraliza con un
 * apóstrofo delante, y se entrecomilla si lleva comas, comillas o saltos.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text =
    typeof value === 'string'
      ? value
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value as number | boolean | bigint);
  if (FORMULA_START.test(text)) {
    text = `'${text}`;
  }
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Cabecera del CSV (con BOM). */
export function auditCsvHeader(): string {
  return CSV_BOM + AUDIT_CSV_COLUMNS.join(',') + CSV_EOL;
}

/** Una fila del CSV (con su fin de línea). */
export function auditCsvRow(event: AuditEventView): string {
  return (
    [
      event.seq,
      event.occurredAt,
      event.actor.userId,
      event.actor.fullName,
      event.actor.role,
      event.actor.organizationId,
      event.actor.viaPlatform,
      event.source.app,
      event.source.ip,
      event.action,
      event.resource.type,
      event.resource.id,
      event.organizationId,
      event.reason,
      event.before,
      event.after,
      event.correlationId,
      event.prevHash,
      event.hash,
    ]
      .map(csvCell)
      .join(',') + CSV_EOL
  );
}

/** Nombre del archivo: `bitacora-20260927-1430.csv` (UTC). */
export function auditExportFilename(now: Date = new Date()): string {
  const iso = now.toISOString(); // 2026-09-27T14:30:00.000Z
  return `bitacora-${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 13)}${iso.slice(14, 16)}.csv`;
}
