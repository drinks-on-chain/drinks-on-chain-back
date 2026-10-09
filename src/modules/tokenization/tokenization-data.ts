import { Prisma, PrismaClient } from '@prisma/client';
import { LOT_VIEW_INCLUDE } from '@modules/lots/lot-view';
import { OPEN_TOKENIZATION_REQUEST_STATUSES } from './tokenization.constants';
import type { QuotaLot } from './domain/quota';

/** Cliente de la API o de una transacción. */
export type Db = PrismaClient | Prisma.TransactionClient;

/** Quién figura cuando actuó el sistema (autoaprobación, bodega suspendida). */
export const SYSTEM_ACTOR_NAME = 'Sistema';

export const REQUEST_INCLUDE = {
  winery: { select: { slug: true, commercialName: true } },
  lot: {
    select: {
      reference: true,
      lotCode: true,
      name: true,
      productType: true,
      stage: true,
      harvestYear: true,
      estimatedBottles: true,
      bottlingBatch: { select: { id: true } },
      _count: { select: { bottleUnits: { where: { status: 'ACTIVE' } } } },
    },
  },
} satisfies Prisma.TokenizationRequestInclude;

export const REQUEST_FULL_INCLUDE = {
  ...REQUEST_INCLUDE,
  changes: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
} satisfies Prisma.TokenizationRequestInclude;

export type RequestRow = Prisma.TokenizationRequestGetPayload<{
  include: typeof REQUEST_INCLUDE;
}>;
export type RequestFullRow = Prisma.TokenizationRequestGetPayload<{
  include: typeof REQUEST_FULL_INCLUDE;
}>;

export const COLLECTION_INCLUDE = {
  winery: { select: { slug: true, commercialName: true } },
  lot: { include: LOT_VIEW_INCLUDE },
  contract: { select: { address: true, baseUri: true, paused: true } },
  images: { orderBy: [{ position: 'asc' }, { createdAt: 'asc' }] },
} satisfies Prisma.CollectionInclude;

export const COLLECTION_FULL_INCLUDE = {
  ...COLLECTION_INCLUDE,
  statusHistory: { orderBy: [{ at: 'asc' }, { id: 'asc' }] },
  mints: { orderBy: { sequence: 'asc' } },
  requests: {
    where: { status: 'APPROVED' },
    orderBy: { decisionAt: 'asc' },
  },
} satisfies Prisma.CollectionInclude;

export type CollectionRow = Prisma.CollectionGetPayload<{
  include: typeof COLLECTION_INCLUDE;
}>;
export type CollectionFullRow = Prisma.CollectionGetPayload<{
  include: typeof COLLECTION_FULL_INCLUDE;
}>;

/** Lote con lo que necesitan las reglas de la cuota (§5.2). */
export interface QuotaLotRow extends QuotaLot {
  id: string;
  wineryId: string;
  reference: string;
  name: string;
  lotCode: string | null;
  harvestYear: number;
  collection: {
    id: string;
    quota: number;
    minted: number;
    status: string;
  } | null;
  openRequest: { id: string; quantity: number; status: string } | null;
}

/**
 * Datos del lote para las reglas de la cuota, leídos con `client` (dentro de
 * la transacción, con la fila del lote bloqueada, cuando se va a escribir).
 * `null` si el lote no existe o es de otra bodega.
 */
export async function loadQuotaLot(
  client: Db,
  lotId: string,
  wineryId?: string,
): Promise<QuotaLotRow | null> {
  const lot = await client.lot.findFirst({
    where: { id: lotId, ...(wineryId && { wineryId }) },
    select: {
      id: true,
      wineryId: true,
      reference: true,
      name: true,
      lotCode: true,
      harvestYear: true,
      stage: true,
      productType: true,
      estimatedBottles: true,
      bottlingBatch: { select: { id: true } },
      collection: {
        select: { id: true, quota: true, minted: true, status: true },
      },
      tokenizationRequests: {
        where: { status: { in: [...OPEN_TOKENIZATION_REQUEST_STATUSES] } },
        select: { id: true, quantity: true, status: true },
        take: 1,
      },
      _count: { select: { bottleUnits: { where: { status: 'ACTIVE' } } } },
    },
  });
  if (!lot) return null;
  const openRequest = lot.tokenizationRequests[0] ?? null;
  return {
    id: lot.id,
    wineryId: lot.wineryId,
    reference: lot.reference,
    name: lot.name,
    lotCode: lot.lotCode,
    harvestYear: lot.harvestYear,
    stage: lot.stage,
    productType: lot.productType,
    estimatedBottles: lot.estimatedBottles,
    bottled: lot.bottlingBatch !== null,
    activeBottles: lot._count.bottleUnits,
    authorizedQuota: lot.collection?.quota ?? 0,
    pendingQuantity: openRequest?.quantity ?? 0,
    collectionClosed: lot.collection?.status === 'CLOSED',
    collection: lot.collection,
    openRequest,
  };
}

/** Nombres de las personas por id (los que no existen se omiten). */
export async function userNames(
  client: Db,
  ids: readonly (string | null | undefined)[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  if (unique.length === 0) return new Map();
  const rows = await client.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, fullName: true },
  });
  return new Map(rows.map((r) => [r.id, r.fullName]));
}

/** Dueños activos de la bodega: a quién se le escribe. */
export async function wineryOwners(
  client: Db,
  wineryId: string,
): Promise<{ email: string; fullName: string }[]> {
  const rows = await client.membership.findMany({
    where: {
      organizationId: wineryId,
      role: 'OWNER',
      status: 'ACTIVE',
      user: { isActive: true },
    },
    include: { user: { select: { email: true, fullName: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map((r) => r.user);
}

/** `"0.1389000"`: stroops (enteros) en XLM con 7 decimales (§0). */
export function stroopsToXlm(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / 10_000_000n;
  const fraction = (abs % 10_000_000n).toString().padStart(7, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}
