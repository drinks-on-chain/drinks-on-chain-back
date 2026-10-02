import type { CorrectionTargetType } from './domain/corrections';
import type { DbClient } from './trace-db';

/**
 * Marcas de corrección de un registro (contrato O2 §9): los recursos
 * devuelven siempre el **valor vigente** y dicen qué campos se corrigieron,
 * si el registro está anulado y con qué correcciones. El valor original está
 * en `changes[].before` de cada corrección.
 */
export interface CorrectionMarks {
  correctedFields: string[];
  voided: boolean;
  correctionIds: string[];
}

export const NO_CORRECTIONS: CorrectionMarks = {
  correctedFields: [],
  voided: false,
  correctionIds: [],
};

/** Marcas de corrección de varios registros del mismo tipo, por id. */
export async function correctionMarks(
  client: DbClient,
  type: CorrectionTargetType,
  ids: readonly string[],
): Promise<Map<string, CorrectionMarks>> {
  const marks = new Map<string, CorrectionMarks>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return marks;
  const rows = await client.traceCorrection.findMany({
    where: { targetType: type, targetId: { in: unique } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, targetId: true, kind: true, changes: true },
  });
  for (const row of rows) {
    const current = marks.get(row.targetId) ?? {
      correctedFields: [],
      voided: false,
      correctionIds: [],
    };
    current.correctionIds.push(row.id);
    if (row.kind === 'VOID') current.voided = true;
    const changes = Array.isArray(row.changes) ? row.changes : [];
    for (const change of changes) {
      const field =
        typeof change === 'object' && change !== null
          ? (change as Record<string, unknown>).field
          : null;
      if (
        typeof field === 'string' &&
        !current.correctedFields.includes(field)
      ) {
        current.correctedFields.push(field);
      }
    }
    marks.set(row.targetId, current);
  }
  return marks;
}

/** Añade las marcas a un registro (vacías si nunca se corrigió). */
export function withMarks<T extends { id: string }>(
  row: T,
  marks: Map<string, CorrectionMarks>,
): T & CorrectionMarks {
  const found = marks.get(row.id) ?? NO_CORRECTIONS;
  return {
    ...row,
    correctedFields: [...found.correctedFields],
    voided: found.voided,
    correctionIds: [...found.correctionIds],
  };
}

/** Atajo: carga las marcas de `rows` y se las añade. */
export async function markRows<T extends { id: string }>(
  client: DbClient,
  type: CorrectionTargetType,
  rows: readonly T[],
): Promise<(T & CorrectionMarks)[]> {
  const marks = await correctionMarks(
    client,
    type,
    rows.map((r) => r.id),
  );
  return rows.map((r) => withMarks(r, marks));
}
