import { createHash } from 'crypto';
import { canonicalJson } from '@shared/utils/canonical-json';

/** Versión del formato canónico; cambiarlo exige una versión nueva. */
export const AUDIT_HASH_VERSION = 1;

/** Campos de una entrada que entran en el hash (todos menos `hash`). */
export interface AuditHashable {
  id: string;
  seq: number;
  occurredAt: string;
  actorUserId: string | null;
  actorFullName: string | null;
  actorRole: string | null;
  actorOrganizationId: string | null;
  actorViaPlatform: boolean;
  sourceApp: string;
  sourceIp: string | null;
  sourceDeviceId: string | null;
  sessionId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  organizationId: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  correlationId: string | null;
  prevHash: string | null;
}

/**
 * SHA-256 (hex) del JSON canónico de la entrada, que incluye `prevHash`: cada
 * entrada sella a la anterior, así que cambiar, borrar o intercalar una rompe
 * la cadena desde ese punto (AUD-02).
 */
export function computeAuditHash(event: AuditHashable): string {
  const canonical = canonicalJson({
    v: AUDIT_HASH_VERSION,
    id: event.id,
    seq: event.seq,
    occurredAt: event.occurredAt,
    actor: {
      userId: event.actorUserId,
      fullName: event.actorFullName,
      role: event.actorRole,
      organizationId: event.actorOrganizationId,
      viaPlatform: event.actorViaPlatform,
    },
    source: {
      app: event.sourceApp,
      ip: event.sourceIp,
      deviceId: event.sourceDeviceId,
    },
    sessionId: event.sessionId,
    action: event.action,
    resource: { type: event.resourceType, id: event.resourceId },
    organizationId: event.organizationId,
    before: event.before ?? null,
    after: event.after ?? null,
    reason: event.reason,
    correlationId: event.correlationId,
    prevHash: event.prevHash,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Recorre entradas consecutivas (ordenadas por `seq`) y devuelve el primer
 * `seq` roto: hueco en la numeración, `prevHash` que no enlaza con la
 * anterior o hash que no corresponde al contenido. `null` = cadena íntegra.
 *
 * `expected` es el punto de partida: el `seq` y el hash de la entrada previa
 * al tramo (`{ seq: 1, prevHash: null }` desde el principio).
 */
export function findBrokenLink(
  rows: readonly (AuditHashable & { hash: string })[],
  expected: { seq: number; prevHash: string | null },
): {
  brokenSeq: number | null;
  next: { seq: number; prevHash: string | null };
} {
  let cursor = { ...expected };
  for (const row of rows) {
    if (row.seq !== cursor.seq) {
      return { brokenSeq: cursor.seq, next: cursor };
    }
    if (row.prevHash !== cursor.prevHash) {
      return { brokenSeq: row.seq, next: cursor };
    }
    if (computeAuditHash(row) !== row.hash) {
      return { brokenSeq: row.seq, next: cursor };
    }
    cursor = { seq: row.seq + 1, prevHash: row.hash };
  }
  return { brokenSeq: null, next: cursor };
}
