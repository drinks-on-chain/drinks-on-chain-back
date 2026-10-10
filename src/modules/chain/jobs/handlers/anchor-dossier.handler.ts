import { Injectable } from '@nestjs/common';
import { ChainTransaction, Prisma } from '@prisma/client';
import { Operation } from '@stellar/stellar-sdk';
import { AuditService } from '@shared/audit/audit.service';
import { OutboxService } from '@shared/outbox/outbox.service';
import { PrismaService } from '@shared/prisma/prisma.service';
import { ChainAlertsWriter } from '../../alerts/chain-alerts.writer';
import {
  applyAnchorConfirmed,
  applyAnchorFailed,
  type AnchorVerification,
} from '../../anchor/anchor-effects';
import { CUSTODY_REF_ANCHOR, intentKeys } from '../../chain.constants';
import { ChainTxFailure, IntentRejected } from '../../tx/chain-tx.errors';
import type {
  ConfirmedLookup,
  IntentEnv,
  IntentHandler,
  PreparedIntent,
} from '../signer/intent-handler';

type Db = Prisma.TransactionClient;

interface AnchorPlan {
  lotId: string;
  memoHashHex: string;
  anchorAddress: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * `ANCHOR_DOSSIER` (contrato O3 §7.1, CHN-10): transacción **clásica** de la
 * cuenta de anclaje con una sola operación sin efecto (`bumpSequence` a la
 * secuencia actual) y `MEMO_HASH` = los 32 bytes de la huella del expediente.
 * No ocupa reserva y va aparte de las de contratos, que no admiten memo
 * (S-15). Al confirmar se **lee la transacción** y se comprueba el memo y la
 * cuenta de origen antes de dar el anclaje por bueno.
 */
@Injectable()
export class AnchorDossierHandler implements IntentHandler<
  AnchorPlan,
  AnchorVerification
> {
  readonly kind = 'ANCHOR_DOSSIER' as const;
  readonly source = 'ANCHOR' as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly alerts: ChainAlertsWriter,
  ) {}

  /** §2.2: expediente `CLOSED`, memo = su huella y sin anclaje confirmado. */
  async validate(
    db: Db,
    transaction: ChainTransaction,
    env: IntentEnv,
  ): Promise<AnchorPlan> {
    const lotId = transaction.subjectId;
    if (
      transaction.subjectType !== 'LOT' ||
      transaction.intentKey !== intentKeys.anchor(lotId)
    ) {
      throw new IntentRejected('la intención no es el anclaje de su lote');
    }
    await db.$queryRaw`SELECT lot_id FROM lot_dossiers WHERE lot_id = ${lotId}::uuid FOR UPDATE`;
    const dossier = await db.lotDossier.findUnique({
      where: { lotId },
      include: { anchor: true, lot: { select: { wineryId: true } } },
    });
    if (!dossier || dossier.status !== 'CLOSED' || !dossier.hash) {
      throw new IntentRejected('el expediente del lote no está cerrado');
    }
    if (dossier.lot.wineryId !== transaction.wineryId) {
      throw new IntentRejected('el lote no es de la bodega de la intención');
    }
    const memo = (transaction.intent as { memoHashHex?: unknown })?.memoHashHex;
    if (
      typeof memo !== 'string' ||
      !SHA256_HEX.test(memo) ||
      memo !== dossier.hash
    ) {
      throw new IntentRejected('el memo no es la huella del expediente');
    }
    const anchor = dossier.anchor;
    if (!anchor || anchor.memoHashHex !== dossier.hash) {
      throw new IntentRejected(
        'el anclaje registrado no es de este expediente',
      );
    }
    if (anchor.status === 'ANCHORED') {
      throw new IntentRejected('el expediente ya tiene un anclaje confirmado');
    }
    const anchorAddress = await env.keys.publicKey(CUSTODY_REF_ANCHOR);
    if (
      anchor.network !== transaction.network ||
      anchor.account !== anchorAddress
    ) {
      throw new IntentRejected(
        'la cuenta del anclaje no es la cuenta de anclaje oficial',
      );
    }
    // Reintento manual tras un fallo: vuelve a estar pendiente
    if (anchor.status !== 'PENDING') {
      await db.dossierAnchor.update({
        where: { id: anchor.id },
        data: { status: 'PENDING' },
      });
    }
    return { lotId, memoHashHex: dossier.hash, anchorAddress };
  }

  async prepare(
    plan: AnchorPlan,
    _transaction: ChainTransaction,
    env: IntentEnv,
  ): Promise<PreparedIntent> {
    const account = await env.gateway.loadAccount(plan.anchorAddress);
    if (!account) {
      throw new ChainTxFailure(
        'CHN_INSUFFICIENT_BALANCE',
        'la cuenta de anclaje no existe en la red',
      );
    }
    return {
      type: 'CLASSIC',
      // Sin efecto: la secuencia ya es esa; solo transporta el memo
      operations: [
        Operation.bumpSequence({ bumpTo: account.sequenceNumber() }),
      ],
      extraSigners: [],
      memoHashHex: plan.memoHashHex,
    };
  }

  /** Lee la transacción confirmada: memo y cuenta de origen (§7.1). */
  async verify(
    transaction: ChainTransaction,
    env: IntentEnv,
    lookup: ConfirmedLookup | null,
  ): Promise<AnchorVerification> {
    const [dossier, officialAccount] = await Promise.all([
      this.prisma.lotDossier.findUnique({
        where: { lotId: transaction.subjectId },
        select: { hash: true },
      }),
      env.keys.publicKey(CUSTODY_REF_ANCHOR),
    ]);
    const expected = dossier?.hash ?? null;
    const memoHashHex = lookup?.memoHashHex ?? null;
    const sourceAccount = lookup?.sourceAccount ?? null;
    return {
      ok:
        expected !== null &&
        memoHashHex === expected &&
        sourceAccount === officialAccount,
      expectedMemoHashHex: expected,
      memoHashHex,
      officialAccount,
      sourceAccount,
    };
  }

  async onConfirmed(
    db: Db,
    transaction: ChainTransaction,
    verification: AnchorVerification | undefined,
  ): Promise<void> {
    await applyAnchorConfirmed(
      db,
      { audit: this.audit, outbox: this.outbox, alerts: this.alerts },
      transaction,
      verification,
    );
  }

  onFailed(db: Db, transaction: ChainTransaction): Promise<void> {
    return applyAnchorFailed(db, transaction);
  }
}
