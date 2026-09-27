import { AuditHashable, computeAuditHash, findBrokenLink } from '../audit-hash';

function chain(n: number): (AuditHashable & { hash: string })[] {
  const rows: (AuditHashable & { hash: string })[] = [];
  let prevHash: string | null = null;
  for (let seq = 1; seq <= n; seq++) {
    const base: AuditHashable = {
      id: `00000000-0000-0000-0000-${String(seq).padStart(12, '0')}`,
      seq,
      occurredAt: new Date(Date.UTC(2026, 8, 27, 10, 0, seq)).toISOString(),
      actorUserId: null,
      actorFullName: null,
      actorRole: null,
      actorOrganizationId: null,
      actorViaPlatform: false,
      sourceApp: 'API',
      sourceIp: '127.0.0.1',
      sourceDeviceId: null,
      sessionId: null,
      action: 'TERROIR_CREATED',
      resourceType: 'terroir',
      resourceId: `r-${seq}`,
      organizationId: null,
      before: null,
      after: { n: seq, nested: { b: 2, a: 1 } },
      reason: null,
      correlationId: `c-${seq}`,
      prevHash,
    };
    const hash = computeAuditHash(base);
    rows.push({ ...base, hash });
    prevHash = hash;
  }
  return rows;
}

describe('hash de la bitácora', () => {
  it('es SHA-256 hex y no depende del orden de las claves', () => {
    const [row] = chain(1);
    expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
    const reordered = { ...row, after: { nested: { a: 1, b: 2 }, n: 1 } };
    expect(computeAuditHash(reordered)).toBe(row.hash);
  });

  it('cambia si cambia cualquier campo, incluido prevHash', () => {
    const [row] = chain(1);
    expect(computeAuditHash({ ...row, reason: 'otro' })).not.toBe(row.hash);
    expect(computeAuditHash({ ...row, prevHash: 'a'.repeat(64) })).not.toBe(
      row.hash,
    );
    expect(computeAuditHash({ ...row, sourceIp: '10.0.0.1' })).not.toBe(
      row.hash,
    );
  });

  it('una cadena íntegra no tiene eslabón roto', () => {
    const rows = chain(5);
    expect(findBrokenLink(rows, { seq: 1, prevHash: null })).toEqual({
      brokenSeq: null,
      next: { seq: 6, prevHash: rows[4].hash },
    });
  });

  it('detecta contenido manipulado', () => {
    const rows = chain(5);
    rows[2] = { ...rows[2], after: { n: 999 } };
    expect(findBrokenLink(rows, { seq: 1, prevHash: null }).brokenSeq).toBe(3);
  });

  it('detecta una entrada borrada (hueco en seq)', () => {
    const rows = chain(5);
    rows.splice(1, 1);
    expect(findBrokenLink(rows, { seq: 1, prevHash: null }).brokenSeq).toBe(2);
  });

  it('detecta una entrada recalculada que ya no enlaza con la anterior', () => {
    const rows = chain(3);
    const forged = { ...rows[1], after: { n: 42 } };
    forged.hash = computeAuditHash(forged);
    rows[1] = forged;
    // El eslabón 2 es coherente consigo mismo, pero el 3 apunta al hash viejo
    expect(findBrokenLink(rows, { seq: 1, prevHash: null }).brokenSeq).toBe(3);
  });
});
