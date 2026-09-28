import type { DbClient } from './trace-db';

/** Quién hizo un registro de la trazabilidad (contrato O2 §2.1). */
export interface TraceActor {
  membershipId: string;
  userId: string;
  fullName: string;
  role: string;
}

/**
 * Resuelve membresías a `TraceActor` (persona y rol actuales de la
 * membresía). Las que no existen se omiten (quedan como `null` en la
 * respuesta: "no registrado").
 */
export async function resolveTraceActors(
  client: DbClient,
  membershipIds: readonly (string | null | undefined)[],
): Promise<Map<string, TraceActor>> {
  const ids = [...new Set(membershipIds.filter((id): id is string => !!id))];
  const map = new Map<string, TraceActor>();
  if (ids.length === 0) return map;
  const rows = await client.membership.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      role: true,
      userId: true,
      user: { select: { fullName: true } },
    },
  });
  for (const row of rows) {
    map.set(row.id, {
      membershipId: row.id,
      userId: row.userId,
      fullName: row.user.fullName,
      role: row.role,
    });
  }
  return map;
}

export function actorOf(
  actors: Map<string, TraceActor>,
  id: string | null | undefined,
): TraceActor | null {
  return id ? (actors.get(id) ?? null) : null;
}
