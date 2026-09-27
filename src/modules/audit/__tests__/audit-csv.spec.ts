import type { AuditEventView } from '@shared/audit/audit.types';
import {
  AUDIT_CSV_COLUMNS,
  CSV_BOM,
  auditCsvHeader,
  auditCsvRow,
  auditExportFilename,
  csvCell,
} from '../audit-csv';

const HASH = 'a'.repeat(64);

function event(overrides: Partial<AuditEventView> = {}): AuditEventView {
  return {
    id: '00000000-0000-4000-8000-000000000010',
    seq: 7,
    occurredAt: '2026-09-27T14:30:00.000Z',
    actor: {
      userId: '00000000-0000-4000-8000-000000000020',
      fullName: 'Jorge Salinas',
      role: 'ADMIN',
      organizationId: '00000000-0000-4000-8000-000000000001',
      viaPlatform: true,
    },
    source: { app: 'BACKOFFICE', ip: '10.0.0.1', deviceId: null },
    action: 'SETTING_CHANGED',
    resource: { type: 'setting', id: 'canje.ventanaDias' },
    organizationId: null,
    before: { value: 30 },
    after: { value: 40 },
    reason: 'Campaña de fin de año',
    correlationId: 'corr-1',
    hash: HASH,
    prevHash: null,
    ...overrides,
  };
}

describe('CSV de la bitácora', () => {
  it('celdas vacías, números, booleanos y objetos', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(12)).toBe('12');
    expect(csvCell(true)).toBe('true');
    expect(csvCell({ value: 1 })).toBe('"{""value"":1}"');
  });

  it('entrecomilla comas, comillas y saltos de línea', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('dijo "sí"')).toBe('"dijo ""sí"""');
    expect(csvCell('línea 1\nlínea 2')).toBe('"línea 1\nlínea 2"');
  });

  it.each(['=HYPERLINK("http://x")', '+1+1', '-2+3', '@SUM(A1)', '\tx', '\rx'])(
    'neutraliza la fórmula %p con un apóstrofo',
    (value) => {
      const cell = csvCell(value);
      expect(cell.replace(/^"/, '').startsWith("'")).toBe(true);
    },
  );

  it('cabecera con BOM y las columnas de los mocks', () => {
    const header = auditCsvHeader();
    expect(header.startsWith(CSV_BOM)).toBe(true);
    expect(header.endsWith('\r\n')).toBe(true);
    expect(header.slice(1, -2).split(',')).toEqual([...AUDIT_CSV_COLUMNS]);
  });

  it('una fila por evento, en el orden de las columnas', () => {
    const row = auditCsvRow(event({ reason: '=cmd|/C calc', prevHash: HASH }));
    expect(row.endsWith('\r\n')).toBe(true);
    const cells = row.slice(0, -2);
    expect(cells).toBe(
      [
        '7',
        '2026-09-27T14:30:00.000Z',
        '00000000-0000-4000-8000-000000000020',
        'Jorge Salinas',
        'ADMIN',
        '00000000-0000-4000-8000-000000000001',
        'true',
        'BACKOFFICE',
        '10.0.0.1',
        'SETTING_CHANGED',
        'setting',
        'canje.ventanaDias',
        '',
        "'=cmd|/C calc",
        '"{""value"":30}"',
        '"{""value"":40}"',
        'corr-1',
        HASH,
        HASH,
      ].join(','),
    );
  });

  it('nombre del archivo con la fecha y hora UTC', () => {
    expect(auditExportFilename(new Date('2026-09-27T14:05:09Z'))).toBe(
      'bitacora-20260927-1405.csv',
    );
  });
});
