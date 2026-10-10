import { Inject, Injectable } from '@nestjs/common';
import { ChainAccount, ChainTransaction, Prisma } from '@prisma/client';
import { PrismaService } from '@shared/prisma/prisma.service';
import { ZERO_TOKEN_COUNTS } from '@modules/tokenization/dto/token-counts.dto';
import { CHAIN_SETTINGS, type ChainSettings } from '../chain.config';
import {
  IDENTITY_TX_KINDS,
  intentKeys,
  wineryCustodyRef,
  type ChainIdentityStatus,
  type ChainNetwork,
} from '../chain.constants';
import type {
  WineryChainAccountViewDto,
  WineryChainIdentityDto,
} from '../dto/chain.dto';
import { explorerAccountUrl, explorerContractUrl } from '../explorer';
import {
  ChainIntentsService,
  type ChainIntentInput,
} from '../tx/chain-intents.service';
import { stroopsToXlm, toChainTxRef } from '../tx/chain-tx.mapper';
import { OPEN_TX_STATUSES } from '../tx/chain-tx.state';

type Db = Prisma.TransactionClient | PrismaService;
type RequestedBy = NonNullable<ChainIntentInput['requestedBy']>;

export const SYSTEM_REQUESTER: RequestedBy = {
  userId: null,
  fullName: null,
  source: 'WORKER',
};

export type ProvisionResult =
  /** Se registró o se relanzó alguna intención. */
  | 'REQUESTED'
  /** Ya estaba en curso: nada que hacer. */
  | 'IN_PROGRESS'
  | 'ALREADY_ACTIVE';

/** Transacciones recientes de la cuenta de la bodega (§3.4). */
const RECENT_TRANSACTIONS = 10;

/**
 * Identidad de una bodega en la red (contrato O3 §3.1): su cuenta y su
 * contrato NFT. Solo escribe en la base (filas e intenciones); el worker
 * firma y envía. Lo usan la API (back office y ERP) y el worker
 * (`winery.activated`, relleno).
 */
@Injectable()
export class WineryIdentityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly intents: ChainIntentsService,
    @Inject(CHAIN_SETTINGS) private readonly settings: ChainSettings,
  ) {}

  private get network(): ChainNetwork {
    return this.settings.network;
  }

  /**
   * Encadena (o relanza) las intenciones de §3.1. Idempotente por
   * `intentKey`: repetirla no crea otra cuenta ni otro contrato. Con
   * `retry`, una intención `FAILED` vuelve a `PENDING`.
   *
   * Quien llama ya comprobó que la bodega está `ACTIVE`.
   */
  async requestProvision(
    db: Prisma.TransactionClient,
    wineryId: string,
    requestedBy: RequestedBy,
    options: { retry: boolean },
  ): Promise<ProvisionResult> {
    const account = await this.ensureAccountRow(db, wineryId);
    if (account.status === 'ACTIVE' || account.status === 'PAUSED') {
      return 'ALREADY_ACTIVE';
    }

    const accountIntent = await this.intents.register(db, {
      kind: 'CREATE_WINERY_ACCOUNT',
      intentKey: intentKeys.wineryAccount(wineryId),
      subject: { type: 'WINERY', id: wineryId },
      wineryId,
      params: { wineryId, chainAccountId: account.id },
      requestedBy,
    });
    let requested = accountIntent.created;
    if (!accountIntent.created) {
      const accountTx = accountIntent.transaction;
      if (accountTx.status === 'FAILED' && options.retry) {
        await this.intents.requeue(db, accountTx.id);
        requested = true;
      } else if (accountTx.status === 'CONFIRMED') {
        requested = await this.requestContract(
          db,
          wineryId,
          requestedBy,
          options,
        );
      }
    }
    if (requested || account.status === 'NOT_PROVISIONED') {
      await db.chainAccount.update({
        where: { id: account.id },
        data: { status: 'PROVISIONING', lastError: Prisma.DbNull },
      });
    }
    return requested ? 'REQUESTED' : 'IN_PROGRESS';
  }

  /** Segunda intención de §3.1; la cuenta ya está confirmada. */
  async requestContract(
    db: Prisma.TransactionClient,
    wineryId: string,
    requestedBy: RequestedBy,
    options: { retry: boolean } = { retry: false },
  ): Promise<boolean> {
    const intent = await this.intents.register(db, {
      kind: 'DEPLOY_WINERY_CONTRACT',
      intentKey: intentKeys.wineryContract(wineryId),
      subject: { type: 'WINERY', id: wineryId },
      wineryId,
      params: { wineryId },
      requestedBy,
    });
    if (intent.created) return true;
    if (intent.transaction.status === 'FAILED' && options.retry) {
      await this.intents.requeue(db, intent.transaction.id);
      return true;
    }
    return false;
  }

  /**
   * Fila de la cuenta de la bodega con su índice de derivación (driver `ENV`,
   * S-1): único por red y nunca reutilizado. La dirección la pone el worker
   * cuando el custodio crea la clave.
   */
  private async ensureAccountRow(
    db: Prisma.TransactionClient,
    wineryId: string,
  ): Promise<ChainAccount> {
    const network = this.network;
    const existing = await db.chainAccount.findUnique({
      where: { wineryId_network: { wineryId, network } },
    });
    if (existing) return existing;
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`chain-derivation:${network}`}))`;
    const last = await db.chainAccount.aggregate({
      where: { network },
      _max: { derivationIndex: true },
    });
    return db.chainAccount.create({
      data: {
        role: 'WINERY',
        network,
        wineryId,
        custodyKeyRef: wineryCustodyRef(wineryId),
        derivationIndex: (last._max.derivationIndex ?? -1) + 1,
        status: 'NOT_PROVISIONED',
      },
    });
  }

  // ── Lectura ──────────────────────────────────────────────────────────────

  /** `WineryChainIdentity` (§3.1). Sin fila de cuenta: `NOT_PROVISIONED`. */
  async view(
    wineryId: string,
    db: Db = this.prisma,
  ): Promise<WineryChainIdentityDto> {
    const network = this.network;
    const explorer = this.settings.explorerBaseUrl;
    const account = await db.chainAccount.findUnique({
      where: { wineryId_network: { wineryId, network } },
    });
    const contract = account
      ? await db.nftContract.findFirst({
          where: { wineryId, network, status: { not: 'RETIRED' } },
          orderBy: { createdAt: 'desc' },
        })
      : null;
    const transactions = await db.chainTransaction.findMany({
      where: { wineryId, network },
      orderBy: { createdAt: 'asc' },
    });
    const byId = new Map(transactions.map((t) => [t.id, t]));
    const byKey = new Map(transactions.map((t) => [t.intentKey, t]));
    const createdTx =
      (account?.createdTxId ? byId.get(account.createdTxId) : undefined) ??
      byKey.get(intentKeys.wineryAccount(wineryId));
    const deployedTx =
      (contract?.deployedTxId ? byId.get(contract.deployedTxId) : undefined) ??
      byKey.get(intentKeys.wineryContract(wineryId));
    const lastError = account?.lastError as
      { code?: unknown; message?: unknown } | null | undefined;

    return {
      wineryId,
      network,
      status: (account?.status ?? 'NOT_PROVISIONED') as ChainIdentityStatus,
      account:
        account?.address && createdTx
          ? {
              address: account.address,
              explorerUrl: explorerAccountUrl(explorer, account.address),
              homeDomain: account.homeDomain,
              createdTx: toChainTxRef(createdTx, explorer),
            }
          : null,
      contract:
        contract?.address && deployedTx
          ? {
              address: contract.address,
              explorerUrl: explorerContractUrl(explorer, contract.address),
              wasmHash: contract.wasmHash,
              name: contract.name,
              symbol: contract.symbol,
              baseUri: contract.baseUri,
              operatorAddress: contract.operatorAddress,
              paused: contract.paused,
              deployedTx: toChainTxRef(deployedTx, explorer),
              deployedAt: contract.deployedAt?.toISOString() ?? null,
            }
          : null,
      pendingTransactions: transactions
        .filter((t) =>
          (OPEN_TX_STATUSES as readonly string[]).includes(t.status),
        )
        .map((t) => toChainTxRef(t, explorer)),
      lastError:
        lastError && typeof lastError.code === 'string'
          ? {
              code: lastError.code,
              message:
                typeof lastError.message === 'string'
                  ? lastError.message
                  : lastError.code,
            }
          : null,
    };
  }

  /**
   * `WineryChainAccountView` (§3.4). Las colecciones, sus contadores y los
   * anclajes llegan con los pasos 3.4–3.6; hasta entonces, ceros reales.
   */
  async accountView(wineryId: string): Promise<WineryChainAccountViewDto> {
    const network = this.network;
    const [identity, recent, costs, first] = await Promise.all([
      this.view(wineryId),
      this.prisma.chainTransaction.findMany({
        where: { wineryId, network },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: RECENT_TRANSACTIONS,
      }),
      this.prisma.chainTransaction.aggregate({
        where: { wineryId, network },
        _sum: { feeChargedStroops: true },
      }),
      this.prisma.chainTransaction.findFirst({
        where: { wineryId, network },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
    ]);
    return {
      identity,
      totals: { ...ZERO_TOKEN_COUNTS },
      byLot: [],
      recentTransactions: recent.map((t) =>
        toChainTxRef(t, this.settings.explorerBaseUrl),
      ),
      chainCosts: {
        feesChargedXlm: stroopsToXlm(costs._sum.feeChargedStroops ?? 0n),
        since: first?.createdAt.toISOString() ?? null,
      },
    };
  }

  /** ¿Es una de las dos intenciones que forman la identidad? */
  static isIdentityTx(transaction: Pick<ChainTransaction, 'kind'>): boolean {
    return (IDENTITY_TX_KINDS as readonly string[]).includes(transaction.kind);
  }
}
