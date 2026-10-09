import type {
  ChainTransaction,
  LotClosure,
  LotClosureItem,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import { toChainTxRef } from '@modules/chain/tx/chain-tx.mapper';
import type {
  LotClosureDto,
  LotClosureItemDto,
  LotClosureSummaryDto,
  WineryLotClosureDto,
} from '../dto/collections.dto';
import type {
  ClosureItemOutcome,
  LotClosureStatus,
  TokenStatus,
  UnsoldPolicy,
} from '../tokenization.constants';

type Client = PrismaClient | Prisma.TransactionClient;

/** El cierre con sus ítems (del número de botella más alto al más bajo). */
export const CLOSURE_INCLUDE = {
  items: {
    include: { token: { select: { status: true } } },
    orderBy: { bottleNumber: 'desc' },
  },
} satisfies Prisma.LotClosureInclude;

export type ClosureItemRow = LotClosureItem & { token: { status: string } };
export type ClosureRow = LotClosure & { items: ClosureItemRow[] };

/** Cifras del cierre, sin los NFT afectados (contrato O3 §8.4). */
export function toClosureSummary(row: LotClosure): LotClosureSummaryDto {
  return {
    id: row.id,
    lotId: row.lotId,
    collectionId: row.collectionId,
    status: row.status as LotClosureStatus,
    computedAt: row.computedAt.toISOString(),
    bottles: row.bottles,
    minted: row.minted,
    sold: row.sold,
    reserved: row.reserved,
    unsold: row.unsold,
    shortfall: row.shortfall,
    unsoldToBurn: row.unsoldToBurn,
    soldWithoutBottle: row.soldWithoutBottle,
    unsoldPolicy: row.unsoldPolicy as UnsoldPolicy | null,
    decision:
      row.decisionAt && row.decisionByUserId
        ? {
            by: {
              userId: row.decisionByUserId,
              fullName: row.decisionByName ?? '',
            },
            at: row.decisionAt.toISOString(),
            reason: row.decisionReason ?? '',
          }
        : null,
  };
}

/** `LotClosure` del back office: con los NFT afectados y sus quemas. */
export async function toClosureView(
  client: Client,
  row: ClosureRow,
  explorerBaseUrl: string | null,
): Promise<LotClosureDto> {
  const txIds = [
    ...new Set(
      row.items.map((i) => i.burnTxId).filter((id): id is string => !!id),
    ),
  ];
  const txs: ChainTransaction[] =
    txIds.length > 0
      ? await client.chainTransaction.findMany({ where: { id: { in: txIds } } })
      : [];
  const byId = new Map(txs.map((tx) => [tx.id, tx]));
  const items: LotClosureItemDto[] = row.items.map((item) => {
    const burnTx = item.burnTxId ? byId.get(item.burnTxId) : undefined;
    return {
      tokenId: item.tokenId,
      bottleNumber: item.bottleNumber,
      // El estado de hoy del NFT, no el que tenía al calcular el cierre
      status: item.token.status as TokenStatus,
      outcome: item.outcome as ClosureItemOutcome,
      burnTx: burnTx ? toChainTxRef(burnTx, explorerBaseUrl) : null,
      resolvedAt: item.resolvedAt?.toISOString() ?? null,
      orderId: item.orderId,
      paidAt: item.paidAt?.toISOString() ?? null,
      note: item.note,
    };
  });
  return { ...toClosureSummary(row), items };
}

/** Lo que ve la bodega: cifras y números de botella, sin datos de pedidos. */
export function toWineryClosureView(view: LotClosureDto): WineryLotClosureDto {
  return {
    ...view,
    items: view.items.map((item) => ({
      tokenId: item.tokenId,
      bottleNumber: item.bottleNumber,
      status: item.status,
      outcome: item.outcome,
      burnTx: item.burnTx,
      resolvedAt: item.resolvedAt,
    })),
  };
}

/** Cierre de una colección, si ya se calculó (`Collection.closure`). */
export async function closureOfCollection(
  client: Client,
  collectionId: string,
  explorerBaseUrl: string | null,
): Promise<LotClosureDto | null> {
  const row = await client.lotClosure.findUnique({
    where: { collectionId },
    include: CLOSURE_INCLUDE,
  });
  return row ? toClosureView(client, row, explorerBaseUrl) : null;
}
