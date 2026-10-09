import type { ChainTransaction, Prisma } from '@prisma/client';
import { AuditAction } from '@shared/audit/audit.actions';
import type { AuditService } from '@shared/audit/audit.service';
import type { OutboxService } from '@shared/outbox/outbox.service';
import type { ChainAlertsWriter } from '@modules/chain/alerts/chain-alerts.writer';
import { MINT_BATCH_MAX_AMOUNT } from '@modules/chain/chain.constants';
import { explorerContractUrl } from '@modules/chain/explorer';
import {
  IntentNotReady,
  IntentOnHold,
  IntentRejected,
  type ChainTxFailure,
} from '@modules/chain/tx/chain-tx.errors';
import type { LotStage } from '@modules/lots/domain/lot-stage';
import { appendLotEvent, formatQuantity } from '@modules/lots/lot-events';
import { lockLotRow } from '@modules/lots/trace-db';
import type { MailService } from '@modules/mail/mail.service';
import { commercialMissing } from './domain/commercial';
import { mintChunks, type MintChunk } from './domain/quota';
import type { MintBatchIntentParams } from './ports/chain-tokenization.adapter';
import { mintIntentKey } from './ports/tokenization-chain.port';
import { loadQuotaLot, wineryOwners } from './tokenization-data';
import {
  COLLECTION_AGGREGATE,
  COLLECTION_MINTED,
  COLLECTION_PUBLISHED,
  type CollectionEventPayload,
  type CollectionMintedPayload,
} from './tokenization.events';

type Db = Prisma.TransactionClient;

/** `tokens.token_id` es `int4`: un id `u32` por encima no cabe (DS-08). */
export const MAX_STORED_TOKEN_ID = 2_147_483_647;

/** Rango de una emisión confirmada (`mints.ranges`, §6.1). */
export interface MintRange {
  firstTokenId: number;
  lastTokenId: number;
  firstBottleNumber: number;
  lastBottleNumber: number;
}

/** Lo que el firmante necesita para construir un `mint_batch` ya validado. */
export interface MintChunkPlan {
  mintId: string;
  collectionId: string;
  wineryId: string;
  lotId: string;
  chunk: MintChunk;
  /** Argumento `lot`: la referencia del lote (S-12). */
  lotArg: string;
  contract: { id: string; address: string };
  /** Cuenta de la bodega: destino (`to`) y `minter`; firma la autorización. */
  account: { address: string; custodyKeyRef: string };
}

/** Lo leído de la red al confirmarse el trozo (§6.1). */
export interface MintVerification {
  /** Valor devuelto por `mint_batch`: el último id emitido. */
  returnValue: number | null;
  /** Evento `lot_minted` de la misma transacción. */
  event: {
    lot: string;
    to: string;
    minter: string;
    firstTokenId: number;
    lastTokenId: number;
  } | null;
}

export interface MintEffectsDeps {
  audit: AuditService;
  mail: MailService;
  outbox: OutboxService;
  alerts: ChainAlertsWriter;
  /** Enlace al ERP para el correo al dueño. */
  erpUrl: string;
  explorerBaseUrl: string | null;
}

const reject = (reason: string): never => {
  throw new IntentRejected(reason);
};

/** Parámetros de la intención, comprobados contra su clave y su sujeto. */
export function mintIntentParams(
  transaction: ChainTransaction,
): MintBatchIntentParams {
  const raw = (transaction.intent ?? {}) as Partial<MintBatchIntentParams>;
  const integers = [
    raw.chunkIndex,
    raw.amount,
    raw.firstBottleNumber,
    raw.lastBottleNumber,
  ];
  if (
    transaction.subjectType !== 'MINT' ||
    typeof raw.mintId !== 'string' ||
    raw.mintId !== transaction.subjectId ||
    typeof raw.collectionId !== 'string' ||
    typeof raw.contractId !== 'string' ||
    integers.some((n) => !Number.isInteger(n) || (n as number) < 1) ||
    transaction.intentKey !==
      mintIntentKey(raw.mintId, raw.chunkIndex as number)
  ) {
    return reject('la intención no describe un trozo de su emisión');
  }
  return raw as MintBatchIntentParams;
}

function rangesOf(mint: { ranges: Prisma.JsonValue }): MintRange[] {
  return Array.isArray(mint.ranges)
    ? (mint.ranges as unknown as MintRange[])
    : [];
}

async function lockMint(db: Db, mintId: string, collectionId: string) {
  await db.$queryRaw`SELECT id FROM mints WHERE id = ${mintId}::uuid FOR UPDATE`;
  await db.$queryRaw`SELECT id FROM collections WHERE id = ${collectionId}::uuid FOR UPDATE`;
}

/**
 * Validación de `MINT_BATCH` antes de firmar (contrato O3 §2.2), con las
 * filas de la emisión y de la colección bloqueadas: la emisión existe y su
 * solicitud está `APPROVED`, el trozo es el pendiente (1–32 000), no rebasa la
 * cuota, la cuota cabe en la estimación (o en las botellas, si el lote ya se
 * embotelló) y el contrato está vigente y sin pausar. Si todo cuadra pero
 * `CHAIN_MINT_ENABLED` está apagado, la intención queda en espera
 * (`CHN_MINT_DISABLED`, ADR-011). Deja la emisión `IN_PROGRESS`.
 */
export async function validateMintChunk(
  db: Db,
  transaction: ChainTransaction,
  options: { mintEnabled: boolean },
): Promise<MintChunkPlan> {
  const params = mintIntentParams(transaction);
  const exists = await db.mint.findUnique({
    where: { id: params.mintId },
    select: { collectionId: true },
  });
  if (!exists) return reject('la emisión no existe');
  await lockMint(db, params.mintId, exists.collectionId);
  const mint = await db.mint.findUniqueOrThrow({
    where: { id: params.mintId },
    include: {
      request: { select: { status: true } },
      collection: {
        include: { contract: { include: { chainAccount: true } } },
      },
    },
  });
  const { collection } = mint;
  const { contract } = collection;
  if (
    collection.id !== params.collectionId ||
    collection.wineryId !== transaction.wineryId
  ) {
    reject('la emisión no es de la colección ni de la bodega de la intención');
  }
  if (mint.status === 'CONFIRMED') reject('la emisión ya está confirmada');
  if (mint.request.status !== 'APPROVED') {
    reject(`la solicitud de la emisión está ${mint.request.status}`);
  }

  // Las emisiones anteriores de la colección fijan dónde empieza esta
  const earlier = await db.mint.findMany({
    where: { collectionId: collection.id, sequence: { lt: mint.sequence } },
    select: { quantity: true, status: true },
  });
  if (earlier.some((m) => m.status !== 'CONFIRMED')) {
    throw new IntentNotReady(
      'una emisión anterior de la colección sigue sin confirmarse',
    );
  }
  const previousQuota = earlier.reduce((sum, m) => sum + m.quantity, 0);
  const chunk = mintChunks(mint.quantity, previousQuota)[params.chunkIndex - 1];
  if (
    !chunk ||
    chunk.amount !== params.amount ||
    chunk.firstBottleNumber !== params.firstBottleNumber ||
    chunk.lastBottleNumber !== params.lastBottleNumber
  ) {
    return reject('el trozo no corresponde a la emisión aprobada');
  }
  if (chunk.amount < 1 || chunk.amount > MINT_BATCH_MAX_AMOUNT) {
    reject(`un trozo lleva de 1 a ${MINT_BATCH_MAX_AMOUNT} NFT`);
  }
  const confirmedChunks = rangesOf(mint).length;
  if (chunk.index <= confirmedChunks) reject('el trozo ya está confirmado');
  if (chunk.index > confirmedChunks + 1) {
    throw new IntentNotReady('el trozo anterior sigue sin confirmarse');
  }
  if (collection.minted + chunk.amount > collection.quota) {
    reject(
      `la emisión rebasaría la cuota (${collection.minted} + ${chunk.amount} > ${collection.quota})`,
    );
  }
  if (collection.minted + 1 !== chunk.firstBottleNumber) {
    reject('los números de botella no continúan los ya emitidos');
  }

  const lot = await loadQuotaLot(db, collection.lotId);
  if (!lot) return reject('el lote de la colección no existe');
  const ceiling = lot.bottled ? lot.activeBottles : lot.estimatedBottles;
  if (ceiling === null || collection.quota > ceiling) {
    reject(
      lot.bottled
        ? `la cuota (${collection.quota}) supera las botellas del lote (${ceiling ?? 0})`
        : `la cuota (${collection.quota}) supera la estimación del lote (${ceiling ?? 'sin declarar'})`,
    );
  }

  const account = contract.chainAccount;
  if (
    contract.id !== params.contractId ||
    contract.status !== 'ACTIVE' ||
    !contract.address ||
    contract.network !== transaction.network ||
    contract.wineryId !== collection.wineryId ||
    !account.address
  ) {
    return reject('la bodega no tiene un contrato vigente en esta red');
  }
  if (contract.paused || account.status === 'PAUSED') {
    reject('el contrato de la bodega está pausado en la red');
  }
  if (account.status !== 'ACTIVE') {
    reject(`la identidad de la bodega está ${account.status}`);
  }

  // Válida, pero la emisión sigue apagada en este entorno (ADR-011)
  if (!options.mintEnabled) throw new IntentOnHold('CHN_MINT_DISABLED');

  await db.mint.update({
    where: { id: mint.id },
    data: { status: 'IN_PROGRESS' },
  });
  await db.collection.update({
    where: { id: collection.id },
    data: { mintStatus: 'IN_PROGRESS' },
  });
  return {
    mintId: mint.id,
    collectionId: collection.id,
    wineryId: collection.wineryId,
    lotId: collection.lotId,
    chunk,
    lotArg: mint.lotArg,
    contract: { id: contract.id, address: contract.address },
    account: {
      address: account.address,
      custodyKeyRef: account.custodyKeyRef,
    },
  };
}

/** Por qué el valor devuelto y el evento no fijan el rango esperado; `null` si cuadran. */
export function mintRangeMismatch(
  verification: MintVerification | undefined,
  expected: { amount: number; lotArg: string; toAddress: string },
): string | null {
  const event = verification?.event ?? null;
  const returned = verification?.returnValue ?? null;
  if (!event) return 'la transacción no trae el evento lot_minted';
  if (returned === null) return 'la transacción no devolvió el último id';
  if (returned !== event.lastTokenId) {
    return `el valor devuelto (${returned}) no es el último id del evento (${event.lastTokenId})`;
  }
  if (
    !Number.isInteger(event.firstTokenId) ||
    event.firstTokenId < 0 ||
    event.lastTokenId - event.firstTokenId + 1 !== expected.amount
  ) {
    return `el rango ${event.firstTokenId}–${event.lastTokenId} no tiene ${expected.amount} NFT`;
  }
  if (event.lot !== expected.lotArg) {
    return `el evento es del lote ${event.lot}, no de ${expected.lotArg}`;
  }
  if (event.to !== expected.toAddress || event.minter !== expected.toAddress) {
    return 'el destino o el emisor del evento no son la cuenta de la bodega';
  }
  if (event.lastTokenId > MAX_STORED_TOKEN_ID) {
    return `el id ${event.lastTokenId} no cabe en tokens.token_id (int4)`;
  }
  return null;
}

/**
 * Efectos de un `MINT_BATCH` confirmado (contrato O3 §6.1), en la misma
 * transacción que confirma: el valor devuelto y `lot_minted` fijan el rango;
 * si no coinciden, alerta `CRITICAL`, emisión `FAILED` y nada se publica. Si
 * cuadran: un `Token` `MINTED` por botella con `bottleNumber` continuo,
 * contadores de la colección y, con el último trozo, emisión `CONFIRMED`,
 * colección `MINTING → READY` (o `PUBLISHED` con `publishOnMint`), bitácora
 * `NFT_MINTED`, línea de tiempo, correo al dueño y `collection.minted`.
 */
export async function applyMintChunkConfirmed(
  db: Db,
  deps: MintEffectsDeps,
  transaction: ChainTransaction,
  verification: MintVerification | undefined,
): Promise<'RECORDED' | 'MISMATCH' | 'SKIPPED'> {
  const params = mintIntentParams(transaction);
  await lockMint(db, params.mintId, params.collectionId);
  const mint = await db.mint.findUniqueOrThrow({
    where: { id: params.mintId },
    include: {
      request: { select: { publishOnMint: true, kind: true } },
      collection: {
        include: {
          contract: { include: { chainAccount: true } },
          images: { select: { isCover: true } },
          lot: { select: { name: true, reference: true, stage: true } },
          winery: { select: { certificationStatus: true } },
        },
      },
    },
  });
  const { collection } = mint;
  const { contract } = collection;
  const ownerAddress = contract.chainAccount.address ?? '';
  const ranges = rangesOf(mint);
  // Ya registrado (la confirmación se reintentó): nada que repetir
  if (ranges.some((r) => r.firstBottleNumber === params.firstBottleNumber)) {
    return 'SKIPPED';
  }
  const at = transaction.confirmedAt ?? new Date();

  const mismatch = mintRangeMismatch(verification, {
    amount: params.amount,
    lotArg: mint.lotArg,
    toAddress: ownerAddress,
  });
  if (mismatch || !verification?.event) {
    await db.mint.update({
      where: { id: mint.id },
      data: { status: 'FAILED' },
    });
    await db.collection.update({
      where: { id: collection.id },
      data: { mintStatus: 'FAILED' },
    });
    await deps.alerts.raise(db, {
      code: 'MINT_RANGE_MISMATCH',
      level: 'CRITICAL',
      subjectType: 'MINT',
      subjectId: mint.id,
      wineryId: collection.wineryId,
      message: `La emisión se confirmó en la red pero su rango no cuadra: ${mismatch ?? 'sin evento'}. No se registran sus NFT ni se publica la colección`,
      expected: {
        amount: params.amount,
        lot: mint.lotArg,
        to: ownerAddress,
      },
      actual: {
        returnValue: verification?.returnValue ?? null,
        event: verification?.event ?? null,
        txHash: transaction.txHash,
      },
    });
    return 'MISMATCH';
  }

  const { firstTokenId, lastTokenId } = verification.event;
  await lockLotRow(db, collection.lotId);
  // Un NFT por botella, de una sola vez (hasta 32 000 filas)
  await db.$executeRaw`
    INSERT INTO tokens (
      id, collection_id, winery_id, lot_id, contract_id, token_id,
      bottle_number, status, owner_kind, owner_address, mint_id, mint_tx_id,
      created_at, updated_at
    )
    SELECT gen_random_uuid(), ${collection.id}::uuid,
      ${collection.wineryId}::uuid, ${collection.lotId}::uuid,
      ${contract.id}::uuid, ${firstTokenId}::int + g,
      ${params.firstBottleNumber}::int + g, 'MINTED', 'WINERY',
      ${ownerAddress}, ${mint.id}::uuid, ${transaction.id}::uuid, ${at}, ${at}
    FROM generate_series(0, ${params.amount}::int - 1) AS g`;

  const allRanges: MintRange[] = [
    ...ranges,
    {
      firstTokenId,
      lastTokenId,
      firstBottleNumber: params.firstBottleNumber,
      lastBottleNumber: params.lastBottleNumber,
    },
  ];
  const mintedOfMint = allRanges.reduce(
    (sum, r) => sum + (r.lastTokenId - r.firstTokenId + 1),
    0,
  );
  const complete = mintedOfMint >= mint.quantity;
  await db.mint.update({
    where: { id: mint.id },
    data: {
      ranges: allRanges as unknown as Prisma.InputJsonArray,
      ...(complete && { status: 'CONFIRMED', confirmedAt: at }),
    },
  });
  const minted = collection.minted + params.amount;
  const pendingMintQuantity = Math.max(
    0,
    collection.pendingMintQuantity - params.amount,
  );
  if (!complete) {
    await db.collection.update({
      where: { id: collection.id },
      data: { minted, pendingMintQuantity },
    });
    return 'RECORDED';
  }

  // Última emisión de la colección: si queda otra aprobada, sigue pendiente
  const laterOpen = await db.mint.count({
    where: {
      collectionId: collection.id,
      sequence: { gt: mint.sequence },
      status: { not: 'CONFIRMED' },
    },
  });
  const initial = collection.status === 'MINTING';
  const publishable =
    mint.request.publishOnMint &&
    laterOpen === 0 &&
    collection.winery.certificationStatus === 'ACTIVE' &&
    !contract.paused &&
    commercialMissing({
      name: collection.name,
      description: collection.description,
      hasCover: collection.images.some((i) => i.isCover),
    }).length === 0;
  const status = initial ? (publishable ? 'PUBLISHED' : 'READY') : null;
  await db.collection.update({
    where: { id: collection.id },
    data: {
      minted,
      pendingMintQuantity,
      mintStatus: laterOpen > 0 ? 'PENDING' : 'CONFIRMED',
      ...(status && { status }),
      ...(status === 'PUBLISHED' && { publishedAt: at }),
    },
  });
  const stage = collection.lot.stage as LotStage;
  const firstBottle = allRanges[0].firstBottleNumber;
  const lastBottle = allRanges[allRanges.length - 1].lastBottleNumber;
  await appendLotEvent(db, collection.lotId, {
    type: 'NFT_MINTED',
    occurredAt: at,
    stage,
    actorMembershipId: null,
    summary: `${formatQuantity(mint.quantity)} NFT emitidos (botellas ${formatQuantity(firstBottle)}–${formatQuantity(lastBottle)})`,
    data: {
      collectionId: collection.id,
      mintId: mint.id,
      sequence: mint.sequence,
      quantity: mint.quantity,
      firstBottleNumber: firstBottle,
      lastBottleNumber: lastBottle,
      firstTokenId: allRanges[0].firstTokenId,
      lastTokenId: allRanges[allRanges.length - 1].lastTokenId,
      contractAddress: contract.address,
    },
    resource: { type: 'collection', id: collection.id },
  });
  await deps.audit.record(db, {
    action: AuditAction.NFT_MINTED,
    resource: { type: 'mint', id: mint.id },
    organizationId: collection.wineryId,
    actor: null,
    source: { app: 'WORKER' },
    after: {
      collectionId: collection.id,
      sequence: mint.sequence,
      quantity: mint.quantity,
      ranges: allRanges,
      contractAddress: contract.address,
      lotArg: mint.lotArg,
      minted,
    },
  });
  if (status) {
    await db.collectionStatusHistory.create({
      data: {
        collectionId: collection.id,
        status,
        reason:
          status === 'PUBLISHED'
            ? 'Emisión confirmada: publicada al emitir'
            : 'Emisión confirmada',
        actorSystem: true,
        at,
      },
    });
  }
  if (status === 'PUBLISHED') {
    await appendLotEvent(db, collection.lotId, {
      type: 'COLLECTION_PUBLISHED',
      occurredAt: at,
      stage,
      actorMembershipId: null,
      summary: `${formatQuantity(minted)} botellas en preventa`,
      data: {
        collectionId: collection.id,
        slug: collection.slug,
        quota: collection.quota,
        minted,
      },
      resource: { type: 'collection', id: collection.id },
    });
    await deps.audit.record(db, {
      action: AuditAction.COLLECTION_PUBLISHED,
      resource: { type: 'collection', id: collection.id },
      organizationId: collection.wineryId,
      actor: null,
      source: { app: 'WORKER' },
      before: { status: 'MINTING' },
      after: { status: 'PUBLISHED', publishOnMint: true },
    });
    await deps.outbox.add<CollectionEventPayload>(db, {
      type: COLLECTION_PUBLISHED,
      aggregateType: COLLECTION_AGGREGATE,
      aggregateId: collection.id,
      payload: {
        collectionId: collection.id,
        wineryId: collection.wineryId,
        lotId: collection.lotId,
        slug: collection.slug,
        status: 'PUBLISHED',
        system: true,
      },
    });
  }
  await deps.outbox.add<CollectionMintedPayload>(db, {
    type: COLLECTION_MINTED,
    aggregateType: COLLECTION_AGGREGATE,
    aggregateId: collection.id,
    payload: {
      collectionId: collection.id,
      wineryId: collection.wineryId,
      lotId: collection.lotId,
      mintId: mint.id,
      mintSequence: mint.sequence,
      quantity: mint.quantity,
      minted,
      status: status ?? collection.status,
    },
  });
  for (const owner of await wineryOwners(db, collection.wineryId)) {
    await deps.mail.enqueue(db, {
      template: 'nft-emitidos',
      to: owner.email,
      organizationId: collection.wineryId,
      idempotencyKey: `nft-emitidos:${mint.id}:${owner.email}`,
      variables: {
        nombre: owner.fullName,
        coleccion: collection.name,
        lote: collection.lot.name,
        cantidad: formatQuantity(mint.quantity),
        botellas: `${formatQuantity(firstBottle)}–${formatQuantity(lastBottle)}`,
        contrato: contract.address ?? '',
        explorador:
          explorerContractUrl(deps.explorerBaseUrl, contract.address) ??
          deps.erpUrl,
        estado:
          status === 'PUBLISHED'
            ? 'La colección ya está publicada en preventa.'
            : initial
              ? 'El equipo de Drinks on Chain la publicará en el Marketplace.'
              : 'Las botellas nuevas ya se suman a tu colección.',
        enlace: deps.erpUrl,
      },
    });
  }
  return 'RECORDED';
}

/**
 * La transacción de un trozo pasó a `FAILED` (definitivo o reintentos
 * agotados): la emisión y la colección lo muestran (`MINT_FAILED` en el
 * lote). Un reintento manual de la transacción las devuelve a `IN_PROGRESS`.
 */
export async function applyMintChunkFailed(
  db: Db,
  transaction: ChainTransaction,
  _failure: ChainTxFailure,
): Promise<void> {
  if (transaction.subjectType !== 'MINT') return;
  const mint = await db.mint.findUnique({
    where: { id: transaction.subjectId },
    select: { id: true, status: true, collectionId: true },
  });
  if (!mint || mint.status === 'CONFIRMED') return;
  await db.mint.update({ where: { id: mint.id }, data: { status: 'FAILED' } });
  await db.collection.update({
    where: { id: mint.collectionId },
    data: { mintStatus: 'FAILED' },
  });
}
