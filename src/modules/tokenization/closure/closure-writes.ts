import type { ChainTransaction, LotClosure, Prisma } from '@prisma/client';
import { AuditAction } from '@shared/audit/audit.actions';
import type { AuditService } from '@shared/audit/audit.service';
import type { OutboxService } from '@shared/outbox/outbox.service';
import { IntentRejected } from '@modules/chain/tx/chain-tx.errors';
import type { LotStage } from '@modules/lots/domain/lot-stage';
import { appendLotEvent, formatQuantity } from '@modules/lots/lot-events';
import { lockLotRow } from '@modules/lots/trace-db';
import type { MailService } from '@modules/mail/mail.service';
import { platformOperationsStaff } from '@modules/organizations/platform-staff';
import { PLATFORM_ORGANIZATION_ID } from '@modules/organizations/organization.constants';
import { wineryOwners } from '../tokenization-data';
import {
  COLLECTION_AGGREGATE,
  LOT_SHORTFALL_DETECTED,
  type LotShortfallDetectedPayload,
} from '../tokenization.events';
import {
  closureCounts,
  closureSettled,
  planShortfall,
  type ClosureToken,
} from './closure.domain';

type Db = Prisma.TransactionClient;

export interface ClosureDeps {
  audit: AuditService;
  mail: MailService;
  outbox: OutboxService;
  /** Enlaces de los correos: al ERP (dueño) y al back office (operaciones). */
  erpUrl: string;
  backofficeUrl: string;
  /** Lo calcula un procesador del worker (origen de la entrada de bitácora). */
  fromWorker?: boolean;
}

export type ClosureChange =
  /** Sin colección, o lote sin embotellar ni descartar: no hay cierre. */
  | { applicable: false; stage: string | null }
  | {
      applicable: true;
      closure: LotClosure;
      /** Se acaba de abrir (o reabrir) un faltante. */
      shortfallOpened: boolean;
    };

/** Parámetros de una intención `BURN_UNSOLD`: solo identificadores (§2.2). */
export interface BurnUnsoldIntentParams {
  closureId: string;
  collectionId: string;
  contractId: string;
  /** `tokens.id` y su id en la red. */
  tokenRowId: string;
  tokenId: number;
}

/**
 * Calcula (o recalcula) el cierre de la colección de un lote (contrato O3
 * §8.4), con la fila del lote bloqueada. Se llama al consumir `lot.bottled`,
 * `lot.bottle_code_voided` y `lot.discarded`, y antes de leerlo o decidirlo.
 * Es idempotente: sin cambios en las botellas ni en los NFT no escribe nada
 * nuevo. Los ítems solo se añaden (las tablas de la tokenización no se
 * borran).
 *
 * Al abrirse un faltante deja, en la misma transacción: bitácora
 * `LOT_SHORTFALL_DETECTED`, evento `SHORTFALL_DETECTED` (interno) en la línea
 * de tiempo, `lot.shortfall_detected` en el outbox y los correos al dueño y a
 * operaciones.
 */
export async function recomputeClosure(
  db: Db,
  deps: ClosureDeps,
  lotId: string,
): Promise<ClosureChange> {
  await lockLotRow(db, lotId);
  const lot = await db.lot.findUnique({
    where: { id: lotId },
    select: {
      id: true,
      wineryId: true,
      name: true,
      stage: true,
      discardedAt: true,
      bottlingBatch: { select: { id: true } },
      collection: {
        select: { id: true, minted: true },
      },
      winery: { select: { commercialName: true } },
      _count: { select: { bottleUnits: { where: { status: 'ACTIVE' } } } },
    },
  });
  if (!lot?.collection) return { applicable: false, stage: lot?.stage ?? null };
  const discarded = lot.discardedAt !== null;
  if (!discarded && lot.bottlingBatch === null) {
    return { applicable: false, stage: lot.stage };
  }
  const { collection } = lot;
  const bottles = discarded ? 0 : lot._count.bottleUnits;
  const now = new Date();

  const tokens: ClosureToken[] = await db.token.findMany({
    where: { collectionId: collection.id },
    select: {
      id: true,
      tokenId: true,
      bottleNumber: true,
      status: true,
      soldAt: true,
    },
  });
  const existing = await db.lotClosure.findUnique({
    where: { collectionId: collection.id },
    include: { items: { select: { tokenRowId: true } } },
  });
  const counts = closureCounts(collection.minted, tokens);
  const plan = planShortfall({
    bottles,
    minted: collection.minted,
    tokens,
    itemTokenIds: new Set(existing?.items.map((item) => item.tokenRowId)),
  });
  const figures = {
    bottles,
    minted: counts.minted,
    sold: counts.sold,
    reserved: counts.reserved,
    unsold: counts.unsold,
  };

  let closure: LotClosure;
  let shortfallOpened = false;
  if (!existing) {
    closure = await db.lotClosure.create({
      data: {
        lotId,
        collectionId: collection.id,
        status: plan.extra > 0 ? 'SHORTFALL_OPEN' : 'NO_SHORTFALL',
        computedAt: now,
        ...figures,
        shortfall: plan.extra,
        unsoldToBurn: plan.addedUnsold,
        soldWithoutBottle: plan.addedSold,
      },
    });
    shortfallOpened = plan.extra > 0;
  } else if (plan.extra > 0) {
    // Más NFT sin botella que los que el cierre ya cubría: se reabre
    closure = await db.lotClosure.update({
      where: { id: existing.id },
      data: {
        status: 'SHORTFALL_OPEN',
        computedAt: now,
        ...figures,
        shortfall: existing.shortfall + plan.extra,
        unsoldToBurn: existing.unsoldToBurn + plan.addedUnsold,
        soldWithoutBottle: existing.soldWithoutBottle + plan.addedSold,
      },
    });
    shortfallOpened = existing.status !== 'SHORTFALL_OPEN';
  } else if (
    existing.status === 'NO_SHORTFALL' ||
    existing.status === 'SHORTFALL_OPEN'
  ) {
    // Antes de decidirse, las cifras siguen a los datos
    const changed =
      existing.bottles !== figures.bottles ||
      existing.minted !== figures.minted ||
      existing.sold !== figures.sold ||
      existing.reserved !== figures.reserved ||
      existing.unsold !== figures.unsold;
    closure = changed
      ? await db.lotClosure.update({
          where: { id: existing.id },
          data: { computedAt: now, ...figures },
        })
      : existing;
  } else {
    // Decidido o resuelto: las cifras de la decisión quedan como constancia
    closure =
      existing.bottles !== bottles
        ? await db.lotClosure.update({
            where: { id: existing.id },
            data: { bottles },
          })
        : existing;
  }

  if (plan.added.length > 0) {
    await db.lotClosureItem.createMany({
      data: plan.added.map((token) => ({
        closureId: closure.id,
        tokenRowId: token.id,
        tokenId: token.tokenId,
        bottleNumber: token.bottleNumber,
        tokenStatus: token.status,
        paidAt: token.soldAt,
        outcome: 'PENDING',
      })),
    });
  }
  if (!shortfallOpened) return { applicable: true, closure, shortfallOpened };

  const summary = `Faltante de ${formatQuantity(closure.shortfall)} botellas: ${formatQuantity(bottles)} botellas para ${formatQuantity(counts.alive)} NFT (${formatQuantity(closure.unsoldToBurn)} sin vender se retirarán; ${formatQuantity(closure.soldWithoutBottle)} vendidos quedan sin botella)`;
  await appendLotEvent(db, lotId, {
    type: 'SHORTFALL_DETECTED',
    occurredAt: now,
    stage: lot.stage as LotStage,
    actorMembershipId: null,
    summary,
    data: {
      closureId: closure.id,
      collectionId: collection.id,
      bottles,
      minted: counts.minted,
      shortfall: closure.shortfall,
      unsoldToBurn: closure.unsoldToBurn,
      soldWithoutBottle: closure.soldWithoutBottle,
    },
    resource: { type: 'lot_closure', id: closure.id },
  });
  await deps.outbox.add<LotShortfallDetectedPayload>(db, {
    type: LOT_SHORTFALL_DETECTED,
    aggregateType: COLLECTION_AGGREGATE,
    aggregateId: collection.id,
    payload: {
      closureId: closure.id,
      collectionId: collection.id,
      lotId,
      wineryId: lot.wineryId,
      bottles,
      minted: counts.minted,
      shortfall: closure.shortfall,
      unsoldToBurn: closure.unsoldToBurn,
      soldWithoutBottle: closure.soldWithoutBottle,
    },
  });
  const variables = {
    lote: lot.name,
    botellas: formatQuantity(bottles),
    emitidos: formatQuantity(counts.alive),
    faltante: formatQuantity(closure.shortfall),
    sinVender: formatQuantity(closure.unsoldToBurn),
    vendidos: formatQuantity(closure.soldWithoutBottle),
  };
  for (const owner of await wineryOwners(db, lot.wineryId)) {
    await deps.mail.enqueue(db, {
      template: 'faltante-detectado',
      to: owner.email,
      organizationId: lot.wineryId,
      variables: { nombre: owner.fullName, ...variables, enlace: deps.erpUrl },
    });
  }
  for (const staff of await platformOperationsStaff(db)) {
    await deps.mail.enqueue(db, {
      template: 'faltante-operaciones',
      to: staff.email,
      organizationId: lot.wineryId,
      variables: {
        nombre: staff.fullName,
        bodega: lot.winery.commercialName,
        ...variables,
        enlace: deps.backofficeUrl,
      },
    });
  }
  await deps.audit.record(db, {
    action: AuditAction.LOT_SHORTFALL_DETECTED,
    resource: { type: 'lot_closure', id: closure.id },
    organizationId: lot.wineryId,
    actor: null,
    ...(deps.fromWorker ? { source: { app: 'WORKER' as const } } : {}),
    after: {
      lotId,
      collectionId: collection.id,
      bottles,
      minted: counts.minted,
      shortfall: closure.shortfall,
      unsoldToBurn: closure.unsoldToBurn,
      soldWithoutBottle: closure.soldWithoutBottle,
    },
  });
  return { applicable: true, closure, shortfallOpened };
}

/**
 * `DECIDED → RESOLVED` cuando no queda ningún ítem `PENDING` ni ninguna
 * quema sin confirmar (§8.4). Devuelve el estado en que queda.
 */
export async function settleClosure(
  db: Db,
  closureId: string,
): Promise<string> {
  const closure = await db.lotClosure.findUniqueOrThrow({
    where: { id: closureId },
    include: { items: { select: { outcome: true, resolvedAt: true } } },
  });
  if (closure.status !== 'DECIDED' || !closureSettled(closure.items)) {
    return closure.status;
  }
  await db.lotClosure.update({
    where: { id: closureId },
    data: { status: 'RESOLVED' },
  });
  return 'RESOLVED';
}

// ── `BURN_UNSOLD` (lo usa el firmante del worker) ───────────────────────────

/** Lo que el firmante necesita para construir un `redeem_burn` ya validado. */
export interface BurnUnsoldPlan {
  closureId: string;
  collectionId: string;
  wineryId: string;
  tokenRowId: string;
  tokenId: number;
  contract: { id: string; address: string };
}

const reject = (reason: string): never => {
  throw new IntentRejected(reason);
};

export function burnIntentParams(
  transaction: ChainTransaction,
): BurnUnsoldIntentParams {
  const raw = (transaction.intent ?? {}) as Partial<BurnUnsoldIntentParams>;
  if (
    transaction.subjectType !== 'TOKEN' ||
    typeof raw.closureId !== 'string' ||
    typeof raw.collectionId !== 'string' ||
    typeof raw.contractId !== 'string' ||
    typeof raw.tokenRowId !== 'string' ||
    raw.tokenRowId !== transaction.subjectId ||
    !Number.isInteger(raw.tokenId) ||
    (raw.tokenId as number) < 0 ||
    transaction.intentKey !== `burn-unsold:${raw.closureId}:${raw.tokenId}`
  ) {
    return reject('la intención no describe la quema de un NFT de un cierre');
  }
  return raw as BurnUnsoldIntentParams;
}

/**
 * Validación de `BURN_UNSOLD` antes de firmar (contrato O3 §2.2), con las
 * filas del cierre y del NFT bloqueadas: el NFT está `MINTED` (sin vender ni
 * reservar) y es un ítem `BURN_UNSOLD` de un cierre `DECIDED` cuya decisión
 * firmó una persona de administración; el contrato está vigente y sin
 * pausar. La quema administrada solo existe por esta decisión o por un canje
 * (`docs-back/03` §14).
 */
export async function validateBurnUnsold(
  db: Db,
  transaction: ChainTransaction,
): Promise<BurnUnsoldPlan> {
  const params = burnIntentParams(transaction);
  await db.$queryRaw`SELECT id FROM lot_closures WHERE id = ${params.closureId}::uuid FOR UPDATE`;
  await db.$queryRaw`SELECT id FROM tokens WHERE id = ${params.tokenRowId}::uuid FOR UPDATE`;
  const [closure, token] = await Promise.all([
    db.lotClosure.findUnique({
      where: { id: params.closureId },
      include: {
        items: { where: { tokenRowId: params.tokenRowId } },
      },
    }),
    db.token.findUnique({
      where: { id: params.tokenRowId },
      include: { contract: { include: { chainAccount: true } } },
    }),
  ]);
  if (!closure || closure.collectionId !== params.collectionId) {
    return reject('el cierre de la intención no existe');
  }
  if (
    !token ||
    token.collectionId !== closure.collectionId ||
    token.tokenId !== params.tokenId ||
    token.wineryId !== transaction.wineryId
  ) {
    return reject('el NFT no es de la colección del cierre');
  }
  const [item] = closure.items;
  if (!item || item.outcome !== 'BURN_UNSOLD' || item.resolvedAt !== null) {
    return reject('el NFT no es una quema pendiente del cierre');
  }
  if (closure.status !== 'DECIDED') {
    return reject(`el cierre está ${closure.status}: no hay decisión de quema`);
  }
  if (!closure.decisionByUserId) return reject('la decisión no tiene autor');
  const admin = await db.membership.count({
    where: {
      userId: closure.decisionByUserId,
      organizationId: PLATFORM_ORGANIZATION_ID,
      role: 'ADMIN',
    },
  });
  if (admin === 0) {
    return reject('la decisión de quema no la firmó administración');
  }
  if (token.status !== 'MINTED') {
    return reject(`el NFT está ${token.status}: solo se quema sin vender`);
  }
  const { contract } = token;
  if (
    contract.id !== params.contractId ||
    contract.status !== 'ACTIVE' ||
    !contract.address ||
    contract.network !== transaction.network
  ) {
    return reject('la bodega no tiene un contrato vigente en esta red');
  }
  if (contract.paused || contract.chainAccount.status === 'PAUSED') {
    return reject('el contrato de la bodega está pausado en la red');
  }
  return {
    closureId: closure.id,
    collectionId: closure.collectionId,
    wineryId: token.wineryId,
    tokenRowId: token.id,
    tokenId: token.tokenId,
    contract: { id: contract.id, address: contract.address },
  };
}

/**
 * Efectos de un `BURN_UNSOLD` confirmado (§8.4), en la misma transacción que
 * lo confirma y solo si la red ya no reconoce al NFT (`owner_of` falla con
 * 200): NFT `BURNED` con `burnReason: 'SHORTFALL'`, ítem resuelto y, con la
 * última quema del cierre, bitácora `UNSOLD_TOKENS_BURNED` y cierre
 * `RESOLVED` si no queda nada más.
 */
export async function applyBurnConfirmed(
  db: Db,
  deps: Pick<ClosureDeps, 'audit'>,
  transaction: ChainTransaction,
  verification: { burnedOnChain: boolean } | undefined,
): Promise<'BURNED' | 'SKIPPED' | 'NOT_BURNED'> {
  const params = burnIntentParams(transaction);
  await db.$queryRaw`SELECT id FROM lot_closures WHERE id = ${params.closureId}::uuid FOR UPDATE`;
  const token = await db.token.findUniqueOrThrow({
    where: { id: params.tokenRowId },
  });
  if (token.status === 'BURNED') return 'SKIPPED';
  if (!verification?.burnedOnChain) return 'NOT_BURNED';
  const at = transaction.confirmedAt ?? new Date();
  await db.token.update({
    where: { id: token.id },
    data: {
      status: 'BURNED',
      burnedAt: at,
      burnTxId: transaction.id,
      burnReason: 'SHORTFALL',
      onchainOwner: null,
      onchainBurned: true,
      onchainCheckedAt: at,
    },
  });
  await db.lotClosureItem.updateMany({
    where: { closureId: params.closureId, tokenRowId: token.id },
    data: { resolvedAt: at, burnTxId: transaction.id },
  });
  const pending = await db.lotClosureItem.count({
    where: {
      closureId: params.closureId,
      outcome: 'BURN_UNSOLD',
      resolvedAt: null,
    },
  });
  if (pending > 0) return 'BURNED';
  const burned = await db.lotClosureItem.count({
    where: { closureId: params.closureId, outcome: 'BURN_UNSOLD' },
  });
  const status = await settleClosure(db, params.closureId);
  await deps.audit.record(db, {
    action: AuditAction.UNSOLD_TOKENS_BURNED,
    resource: { type: 'lot_closure', id: params.closureId },
    organizationId: token.wineryId,
    actor: null,
    source: { app: 'WORKER' },
    after: {
      collectionId: params.collectionId,
      burned,
      burnReason: 'SHORTFALL',
      closureStatus: status,
      lastTxHash: transaction.txHash,
    },
  });
  return 'BURNED';
}
