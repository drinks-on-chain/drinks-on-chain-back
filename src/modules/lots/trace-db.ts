import { Prisma, PrismaClient } from '@prisma/client';
import { ensureLotPrefix } from '@modules/wineries/winery-codes';

type Tx = Prisma.TransactionClient;
/** Cliente de la API o de una transacción. */
export type DbClient = Tx | PrismaClient;

/**
 * Reloj de la base de datos (contrato O2 §0): todo candado se evalúa con la
 * hora de la base, nunca con la del cliente ni con una fecha enviada.
 */
export interface DbClock {
  now: Date;
  /** Día de calendario en America/La_Paz (`YYYY-MM-DD`). */
  today: string;
}

export async function dbClock(tx: DbClient): Promise<DbClock> {
  const rows = await tx.$queryRaw<{ now: Date; today: string }[]>`
    SELECT now() AS now,
           to_char(now() AT TIME ZONE 'America/La_Paz', 'YYYY-MM-DD') AS today`;
  return { now: new Date(rows[0].now), today: rows[0].today };
}

/** Bloquea la fila del lote hasta el fin de la transacción (serialización por lote, §0). */
export async function lockLotRow(tx: Tx, lotId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM lots WHERE id = ${lotId}::uuid FOR UPDATE`;
  return rows.length > 0;
}

export type SequenceScope = 'HARVEST' | 'LOT_CODE' | 'LOT_REFERENCE';

/**
 * Siguiente valor de la secuencia de una bodega, año y ámbito (EA-07): una
 * sola sentencia `INSERT … ON CONFLICT DO UPDATE … RETURNING` que bloquea la
 * fila hasta el fin de la transacción. El valor nunca queda por debajo de lo
 * que ya existe en los datos (registros anteriores a la Ola 2 o sembrados),
 * así que no hay colisiones ni `count + 1`.
 */
export async function nextSequence(
  tx: Tx,
  wineryId: string,
  year: number,
  scope: SequenceScope,
): Promise<number> {
  const floor = await sequenceFloor(tx, wineryId, year, scope);
  const rows = await tx.$queryRaw<{ value: number }[]>`
    INSERT INTO lot_sequences (winery_id, year, scope, value, updated_at)
    VALUES (${wineryId}::uuid, ${year}::smallint, ${scope}, ${floor + 1}, now())
    ON CONFLICT (winery_id, year, scope) DO UPDATE
      SET value = GREATEST(lot_sequences.value, ${floor}) + 1,
          updated_at = now()
    RETURNING value`;
  return Number(rows[0].value);
}

/** Mayor número ya usado por los datos en ese ámbito (0 si ninguno). */
async function sequenceFloor(
  tx: Tx,
  wineryId: string,
  year: number,
  scope: SequenceScope,
): Promise<number> {
  let rows: { floor: number | null }[];
  if (scope === 'HARVEST') {
    rows = await tx.$queryRaw`
      SELECT GREATEST(
        COALESCE(MAX((regexp_match(harvest_batch_code, '^HARV-[0-9]{4}-[^-]+-([0-9]+)'))[1]::int), 0),
        COUNT(*)::int
      ) AS floor
      FROM harvest_batches
      WHERE winery_id = ${wineryId}::uuid AND harvest_year = ${year}`;
  } else if (scope === 'LOT_CODE') {
    rows = await tx.$queryRaw`
      SELECT COALESCE(MAX((regexp_match(international_lot_code, '^[A-Z]+-([0-9]{4})-[A-Z]+-([0-9]+)$'))[2]::int), 0) AS floor
      FROM bottling_batches
      WHERE winery_id = ${wineryId}::uuid
        AND (regexp_match(international_lot_code, '^[A-Z]+-([0-9]{4})-'))[1] = ${String(year)}`;
  } else {
    rows = await tx.$queryRaw`
      SELECT COALESCE(MAX((regexp_match(reference, '-L[0-9]{4}-([0-9]+)$'))[1]::int), 0) AS floor
      FROM lots
      WHERE winery_id = ${wineryId}::uuid AND reference LIKE ${`%-L${year}-%`}`;
  }
  return Number(rows[0]?.floor ?? 0);
}

/** Prefijo de lote de la bodega (ORG-05), asignándolo si aún no lo tiene. */
export async function wineryLotPrefix(
  tx: Tx,
  wineryId: string,
): Promise<string> {
  const winery = await tx.winery.findUniqueOrThrow({
    where: { id: wineryId },
    select: { id: true, commercialName: true, lotPrefix: true },
  });
  return ensureLotPrefix(tx, winery);
}

/** Referencia interna del lote: `{lotPrefix}-L{año}-{NNN}` (§2.1). */
export async function nextLotReference(
  tx: Tx,
  wineryId: string,
  year: number,
): Promise<string> {
  const prefix = await wineryLotPrefix(tx, wineryId);
  const seq = await nextSequence(tx, wineryId, year, 'LOT_REFERENCE');
  return `${prefix}-L${year}-${String(seq).padStart(3, '0')}`;
}

/**
 * Código de lote de la etiqueta (§6.3): `{lotPrefix}-{año}-{WINE|SINGANI}-{NNN}`
 * con la secuencia por bodega y año, común a los productos (S-13).
 */
export async function nextLotCode(
  tx: Tx,
  wineryId: string,
  year: number,
  productType: string,
): Promise<string> {
  const prefix = await wineryLotPrefix(tx, wineryId);
  const seq = await nextSequence(tx, wineryId, year, 'LOT_CODE');
  return `${prefix}-${year}-${productType}-${String(seq).padStart(3, '0')}`;
}

/** Membresía de quien actúa en la bodega (autoría de la trazabilidad, `TraceActor`). */
export async function actorMembership(
  tx: DbClient,
  userId: string | null | undefined,
  wineryId: string,
): Promise<{ id: string; role: string } | null> {
  if (!userId) return null;
  const membership = await tx.membership.findUnique({
    where: { userId_organizationId: { userId, organizationId: wineryId } },
    select: { id: true, role: true },
  });
  return membership;
}
