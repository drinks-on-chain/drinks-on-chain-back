import type { ChainTransaction, Prisma } from '@prisma/client';
import { AuditAction } from '@shared/audit/audit.actions';
import type { AuditService } from '@shared/audit/audit.service';
import type { OutboxService } from '@shared/outbox/outbox.service';
import { appendLotEvent, formatQuantity } from '@modules/lots/lot-events';
import {
  LOT_AGGREGATE,
  LOT_ANCHORED,
  type LotAnchoredPayload,
} from '@modules/lots/lots.events';
import { lockLotRow } from '@modules/lots/trace-db';
import { settingEntry } from '@modules/settings/settings.catalog';
import {
  COLLECTION_AGGREGATE,
  COLLECTION_REDEEMABLE,
  type CollectionRedeemablePayload,
} from '@modules/tokenization/tokenization.events';
import type { ChainAlertsWriter } from '../alerts/chain-alerts.writer';

type Db = Prisma.TransactionClient;

/** Lo leído de la transacción de anclaje ya confirmada (§7.1). */
export interface AnchorVerification {
  /** Memo = huella del expediente **y** origen = cuenta de anclaje oficial. */
  ok: boolean;
  expectedMemoHashHex: string | null;
  memoHashHex: string | null;
  officialAccount: string | null;
  sourceAccount: string | null;
}

export interface AnchorEffectsDeps {
  audit: AuditService;
  outbox: OutboxService;
  alerts: ChainAlertsWriter;
}

const REDEEM_WINDOW_KEY = 'canje.ventanaDias';
const DAY_MS = 86_400_000;

/**
 * Valor efectivo de `canje.ventanaDias` para la bodega **en este momento**
 * (S-16), leído en la misma transacción: ajuste de la bodega, estándar
 * general o el valor por defecto del catálogo.
 */
export async function redeemWindowDays(
  db: Db,
  wineryId: string,
): Promise<number> {
  const fallback = Number(settingEntry(REDEEM_WINDOW_KEY)?.default ?? 30);
  const [override, global] = await Promise.all([
    db.settingOverride.findUnique({
      where: { key_wineryId: { key: REDEEM_WINDOW_KEY, wineryId } },
      select: { value: true },
    }),
    db.settingGlobalValue.findUnique({
      where: { key: REDEEM_WINDOW_KEY },
      select: { value: true },
    }),
  ]);
  for (const candidate of [override?.value, global?.value, fallback]) {
    if (
      typeof candidate === 'number' &&
      Number.isFinite(candidate) &&
      candidate >= 1
    ) {
      return Math.floor(candidate);
    }
  }
  return fallback;
}

/**
 * Efectos del anclaje confirmado (contrato O3 §7.2), en la misma transacción
 * de base de datos que confirma `ANCHOR_DOSSIER`. Si la lectura de vuelta no
 * cuadra (memo o cuenta de origen), alerta `CRITICAL` y el anclaje **no** se
 * da por bueno: el lote sigue `CERTIFIED`.
 */
export async function applyAnchorConfirmed(
  db: Db,
  deps: AnchorEffectsDeps,
  transaction: ChainTransaction,
  verification: AnchorVerification | undefined,
): Promise<'ANCHORED' | 'MISMATCH' | 'SKIPPED'> {
  const lotId = transaction.subjectId;
  await lockLotRow(db, lotId);
  const anchor = await db.dossierAnchor.findUnique({ where: { lotId } });
  if (!anchor || anchor.status === 'ANCHORED') return 'SKIPPED';
  const lot = await db.lot.findUniqueOrThrow({
    where: { id: lotId },
    select: {
      id: true,
      wineryId: true,
      stage: true,
      lotCode: true,
      collection: { select: { id: true, status: true } },
    },
  });
  const anchoredAt = transaction.confirmedAt ?? new Date();

  if (!verification?.ok) {
    await db.dossierAnchor.update({
      where: { id: anchor.id },
      data: {
        status: 'FAILED',
        txHash: transaction.txHash,
        ledger: transaction.ledger,
      },
    });
    await deps.alerts.raise(db, {
      code: 'ANCHOR_MISMATCH',
      level: 'CRITICAL',
      subjectType: 'LOT',
      subjectId: lotId,
      wineryId: lot.wineryId,
      message:
        'La transacción de anclaje se confirmó, pero su memo o su cuenta de origen no son los esperados: el anclaje no se da por bueno',
      expected: {
        memoHashHex: verification?.expectedMemoHashHex ?? anchor.memoHashHex,
        account: verification?.officialAccount ?? anchor.account,
      },
      actual: {
        memoHashHex: verification?.memoHashHex ?? null,
        account: verification?.sourceAccount ?? null,
        txHash: transaction.txHash,
      },
    });
    return 'MISMATCH';
  }

  // 1. Anclaje verificado y lote `CERTIFIED → ANCHORED`
  await db.dossierAnchor.update({
    where: { id: anchor.id },
    data: {
      status: 'ANCHORED',
      txHash: transaction.txHash,
      ledger: transaction.ledger,
      anchoredAt,
      verifiedAt: new Date(),
    },
  });
  if (lot.stage === 'CERTIFIED') {
    await db.lot.update({
      where: { id: lotId },
      data: { stage: 'ANCHORED', stageChangedAt: anchoredAt },
    });
  }
  const stage = lot.stage === 'CERTIFIED' ? 'ANCHORED' : lot.stage;
  await appendLotEvent(db, lotId, {
    type: 'DOSSIER_ANCHORED',
    occurredAt: anchoredAt,
    stage,
    actorMembershipId: null,
    summary: 'Huella del expediente anclada en la red Stellar',
    data: {
      network: anchor.network,
      account: anchor.account,
      memoHashHex: anchor.memoHashHex,
      txHash: transaction.txHash,
      ledger: transaction.ledger,
    },
    resource: { type: 'lot_dossier', id: lotId },
  });

  // 2. Campos legados del embotellado: ahora dicen la verdad
  await db.bottlingBatch.updateMany({
    where: { lotId },
    data: {
      isAnchoredOnChain: true,
      blockchainAnchorTxHash: transaction.txHash,
      anchoredAt,
    },
  });
  await deps.audit.record(db, {
    action: AuditAction.DOSSIER_ANCHORED,
    resource: { type: 'lot', id: lotId },
    organizationId: lot.wineryId,
    actor: null,
    source: { app: 'WORKER' },
    before: { stage: lot.stage },
    after: {
      stage,
      network: anchor.network,
      account: anchor.account,
      memoHashHex: anchor.memoHashHex,
      txHash: transaction.txHash,
      ledger: transaction.ledger,
    },
  });

  // 3. La colección pasa a canjeable y sus NFT vendidos, a `REDEEMABLE`
  if (lot.collection) {
    const days = await redeemWindowDays(db, lot.wineryId);
    const redeemWindowEndsAt = new Date(anchoredAt.getTime() + days * DAY_MS);
    await db.collection.update({
      where: { id: lot.collection.id },
      data: { redeemable: true, redeemableSince: anchoredAt },
    });
    const { count } = await db.token.updateMany({
      where: { collectionId: lot.collection.id, status: 'SOLD' },
      data: {
        status: 'REDEEMABLE',
        redeemableAt: anchoredAt,
        redeemWindowEndsAt,
      },
    });
    await appendLotEvent(db, lotId, {
      type: 'TOKENS_REDEEMABLE',
      occurredAt: anchoredAt,
      stage,
      actorMembershipId: null,
      summary: `Botellas de la preventa canjeables: ${formatQuantity(count)} NFT vendidos con ${days} días para canjear`,
      data: {
        collectionId: lot.collection.id,
        tokens: count,
        redeemWindowDays: days,
        redeemWindowEndsAt: redeemWindowEndsAt.toISOString(),
      },
      resource: { type: 'collection', id: lot.collection.id },
    });
    await deps.audit.record(db, {
      action: AuditAction.TOKENS_REDEEMABLE,
      resource: { type: 'collection', id: lot.collection.id },
      organizationId: lot.wineryId,
      actor: null,
      source: { app: 'WORKER' },
      after: {
        redeemable: true,
        redeemableSince: anchoredAt.toISOString(),
        tokens: count,
        redeemWindowDays: days,
      },
    });
    await deps.outbox.add<CollectionRedeemablePayload>(db, {
      type: COLLECTION_REDEEMABLE,
      aggregateType: COLLECTION_AGGREGATE,
      aggregateId: lot.collection.id,
      payload: {
        collectionId: lot.collection.id,
        wineryId: lot.wineryId,
        lotId,
        redeemableSince: anchoredAt.toISOString(),
        tokens: count,
      },
    });
  }

  // 4. Aviso al resto del sistema (la caché del pasaporte cambia con el
  // evento del lote y con su etapa: no hay nada más que invalidar)
  await deps.outbox.add<LotAnchoredPayload>(db, {
    type: LOT_ANCHORED,
    aggregateType: LOT_AGGREGATE,
    aggregateId: lotId,
    payload: {
      lotId,
      wineryId: lot.wineryId,
      lotCode: lot.lotCode ?? '',
      hash: anchor.memoHashHex,
      txHash: transaction.txHash ?? '',
      ledger: transaction.ledger ?? 0,
      anchoredAt: anchoredAt.toISOString(),
    },
  });
  return 'ANCHORED';
}

/** `ANCHOR_DOSSIER` pasó a `FAILED`: el lote sigue `CERTIFIED` (§7.2). */
export async function applyAnchorFailed(
  db: Db,
  transaction: ChainTransaction,
): Promise<void> {
  await db.dossierAnchor.updateMany({
    where: { lotId: transaction.subjectId, status: { not: 'ANCHORED' } },
    data: { status: 'FAILED' },
  });
}
