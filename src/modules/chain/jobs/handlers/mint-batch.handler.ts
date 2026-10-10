import { Inject, Injectable } from '@nestjs/common';
import { ChainTransaction, Prisma } from '@prisma/client';
import { Address, Contract, nativeToScVal } from '@stellar/stellar-sdk';
import { AuditService } from '@shared/audit/audit.service';
import { OutboxService } from '@shared/outbox/outbox.service';
import { PrismaService } from '@shared/prisma/prisma.service';
import { AppLinks } from '@modules/mail/app-links';
import { MailService } from '@modules/mail/mail.service';
import {
  MAX_STORED_TOKEN_ID,
  applyMintChunkConfirmed,
  applyMintChunkFailed,
  validateMintChunk,
  type MintChunkPlan,
  type MintVerification,
} from '@modules/tokenization/mint-effects';
import { ChainAlertsWriter } from '../../alerts/chain-alerts.writer';
import { CHAIN_SETTINGS, type ChainSettings } from '../../chain.config';
import { ChainTxFailure, IntentRejected } from '../../tx/chain-tx.errors';
import type { ChainContractEvent } from '../gateway/chain-gateway';
import type {
  ConfirmedLookup,
  IntentEnv,
  IntentHandler,
  PreparedIntent,
} from '../signer/intent-handler';

type Db = Prisma.TransactionClient;

const asInteger = (value: unknown): number | null => {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) ? n : null;
};

/** `lot_minted` de un contrato, con la forma de `docs/funciones.md`. */
export function lotMintedOf(
  events: readonly ChainContractEvent[],
  contractAddress: string,
): MintVerification['event'] {
  const event = events.find(
    (e) =>
      e.name === 'lot_minted' &&
      (e.contractAddress === null || e.contractAddress === contractAddress),
  );
  if (!event) return null;
  const first = asInteger(event.data.first_token_id);
  const last = asInteger(event.data.last_token_id);
  const [lot, to] = event.topics;
  if (
    first === null ||
    last === null ||
    typeof lot !== 'string' ||
    typeof to !== 'string' ||
    typeof event.data.minter !== 'string'
  ) {
    return null;
  }
  return {
    lot,
    to,
    minter: event.data.minter,
    firstTokenId: first,
    lastTokenId: last,
  };
}

/**
 * `MINT_BATCH` (contrato O3 §6.1, CHN-07): `mint_batch(to = cuenta de la
 * bodega, amount, lot = referencia del lote, minter = bodega)`. La
 * autorización la firma la cuenta custodiada de la bodega; el sobre lo
 * origina y lo paga operaciones (S-3).
 *
 * Idempotencia en la red (§2.3, nivel 3): al construir se anota
 * `expectedFirstTokenId = total_minted()`. Si en un intento posterior el
 * contador ya avanzó, se busca un `lot_minted` cuya transacción sea uno de
 * los intentos de esta misma intención: si existe, se da por confirmada con
 * él y no se emite otra vez.
 */
@Injectable()
export class MintBatchHandler implements IntentHandler<
  MintChunkPlan,
  MintVerification
> {
  readonly kind = 'MINT_BATCH' as const;
  readonly source = 'OPERATIONS' as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly outbox: OutboxService,
    private readonly alerts: ChainAlertsWriter,
    private readonly links: AppLinks,
    @Inject(CHAIN_SETTINGS) private readonly settings: ChainSettings,
  ) {}

  validate(db: Db, transaction: ChainTransaction): Promise<MintChunkPlan> {
    return validateMintChunk(db, transaction, {
      mintEnabled: this.settings.mintEnabled,
    });
  }

  async prepare(
    plan: MintChunkPlan,
    transaction: ChainTransaction,
    env: IntentEnv,
  ): Promise<PreparedIntent> {
    const { contract, account, chunk } = plan;
    const totalMinted = asInteger(
      await env.gateway.readContract(
        contract.address,
        'total_minted',
        [],
        env.operationsAddress,
      ),
    );
    if (totalMinted === null) {
      throw new ChainTxFailure(
        'CHN_RPC_UNAVAILABLE',
        'total_minted no devolvió un entero',
      );
    }
    const stored = (transaction.intent ?? {}) as {
      expectedFirstTokenId?: unknown;
      expectedAtLedger?: unknown;
    };
    const expected = asInteger(stored.expectedFirstTokenId);
    const sinceLedger = asInteger(stored.expectedAtLedger);
    if (expected !== null && sinceLedger !== null && totalMinted > expected) {
      const previous = await this.previousAttempt(
        transaction,
        env,
        contract.address,
        sinceLedger,
      );
      if (previous) {
        return {
          type: 'ALREADY_DONE',
          note: 'Un intento anterior ya emitió este trozo (lot_minted)',
          txHash: previous,
        };
      }
    }
    if (totalMinted + chunk.amount - 1 > MAX_STORED_TOKEN_ID) {
      throw new IntentRejected(
        `los ids ${totalMinted}… no caben en tokens.token_id (int4)`,
      );
    }
    await this.prisma.chainTransaction.update({
      where: { id: transaction.id },
      data: {
        intent: {
          ...(transaction.intent as Prisma.JsonObject),
          expectedFirstTokenId: totalMinted,
          expectedAtLedger: await env.gateway.latestLedger(),
        },
      },
    });
    const bodega = new Address(account.address).toScVal();
    return {
      type: 'SOROBAN',
      operation: new Contract(contract.address).call(
        'mint_batch',
        bodega,
        nativeToScVal(chunk.amount, { type: 'u32' }),
        nativeToScVal(plan.lotArg, { type: 'string' }),
        bodega,
      ),
      authSigners: [
        {
          role: 'WINERY',
          ref: account.custodyKeyRef,
          address: account.address,
          wineryId: plan.wineryId,
        },
      ],
    };
  }

  /** Hash de un intento de esta intención que emitió `lot_minted`, si lo hay. */
  private async previousAttempt(
    transaction: ChainTransaction,
    env: IntentEnv,
    contractAddress: string,
    sinceLedger: number,
  ): Promise<string | null> {
    const attempts = await this.prisma.chainTxAttempt.findMany({
      where: { transactionId: transaction.id, txHash: { not: null } },
      select: { txHash: true },
    });
    const own = new Set(
      [transaction.txHash, ...attempts.map((a) => a.txHash)].filter(
        (hash): hash is string => !!hash,
      ),
    );
    if (own.size === 0) return null;
    const events = await env.gateway.contractEvents(
      contractAddress,
      'lot_minted',
      sinceLedger,
    );
    return events.find((e) => e.txHash && own.has(e.txHash))?.txHash ?? null;
  }

  /** Valor devuelto y `lot_minted` de la transacción confirmada. */
  async verify(
    transaction: ChainTransaction,
    _env: IntentEnv,
    lookup: ConfirmedLookup | null,
  ): Promise<MintVerification> {
    if (!lookup) return { returnValue: null, event: null };
    const mint = await this.prisma.mint.findUnique({
      where: { id: transaction.subjectId },
      select: { collection: { select: { contract: true } } },
    });
    const address = mint?.collection.contract.address ?? '';
    return {
      returnValue: asInteger(lookup.returnValue),
      event: lotMintedOf(lookup.events ?? [], address),
    };
  }

  async onConfirmed(
    db: Db,
    transaction: ChainTransaction,
    verification: MintVerification | undefined,
  ): Promise<void> {
    await applyMintChunkConfirmed(
      db,
      {
        audit: this.audit,
        mail: this.mail,
        outbox: this.outbox,
        alerts: this.alerts,
        erpUrl: this.links.erpHome(),
        explorerBaseUrl: this.settings.explorerBaseUrl,
      },
      transaction,
      verification,
    );
  }

  onFailed(
    db: Db,
    transaction: ChainTransaction,
    failure: ChainTxFailure,
  ): Promise<void> {
    return applyMintChunkFailed(db, transaction, failure);
  }
}
