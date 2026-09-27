import { Prisma, Winery } from '@prisma/client';
import { deriveLotPrefix, slugify, uniqueSlug } from './winery-identity';

/** Candado de transacción de la asignación de `slug` (dos altas con el mismo nombre). */
export const SLUG_LOCK_KEY = 4_155_444_956; // "SLUG"

/**
 * `slug` libre para un nombre comercial, en la transacción `tx` (bajo candado
 * hasta el fin de la transacción, que debe crear la bodega con él).
 */
export async function freeSlug(
  tx: Prisma.TransactionClient,
  tradeName: string,
): Promise<string> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SLUG_LOCK_KEY}::bigint)`;
  const base = slugify(tradeName);
  const rows = await tx.winery.findMany({
    where: { slug: { startsWith: base } },
    select: { slug: true },
  });
  return uniqueSlug(tradeName, new Set(rows.map((r) => r.slug as string)));
}

/**
 * Candado de transacción que serializa la asignación de prefijos de lote
 * (`pg_advisory_xact_lock`): dos activaciones a la vez no eligen el mismo.
 */
export const LOT_PREFIX_LOCK_KEY = 4_155_444_955; // "LOTPX"

/**
 * Prefijo de lote de la bodega (ORG-05): el que tiene o uno nuevo, único y
 * derivado del nombre comercial, que se guarda en la transacción `tx`. Nunca
 * cambia después (la columna es única y ningún flujo la reescribe).
 */
export async function ensureLotPrefix(
  tx: Prisma.TransactionClient,
  winery: Pick<Winery, 'id' | 'commercialName' | 'lotPrefix'>,
): Promise<string> {
  if (winery.lotPrefix) {
    return winery.lotPrefix;
  }
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOT_PREFIX_LOCK_KEY}::bigint)`;
  const current = await tx.winery.findUnique({
    where: { id: winery.id },
    select: { lotPrefix: true, commercialName: true },
  });
  if (current?.lotPrefix) {
    return current.lotPrefix;
  }
  const rows = await tx.winery.findMany({
    where: { lotPrefix: { not: null } },
    select: { lotPrefix: true },
  });
  const taken = new Set(rows.map((r) => r.lotPrefix as string));
  const prefix = deriveLotPrefix(
    current?.commercialName ?? winery.commercialName,
    taken,
  );
  if (!prefix) {
    throw new Error(
      `No queda un prefijo de lote libre para la bodega ${winery.id}`,
    );
  }
  await tx.winery.update({
    where: { id: winery.id },
    data: { lotPrefix: prefix },
  });
  return prefix;
}
