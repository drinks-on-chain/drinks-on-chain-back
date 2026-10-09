import { Inject, Injectable } from '@nestjs/common';
import type { ChainTransaction, Prisma } from '@prisma/client';
import {
  CHAIN_SETTINGS,
  type ChainSettings,
} from '@modules/chain/chain.config';
import type {
  ChainIdentityStatus,
  ChainNetwork,
  ChainTxKind,
  ChainTxStatus,
} from '@modules/chain/chain.constants';
import type { ChainTxRefDto } from '@modules/chain/dto/chain-common.dto';
import type { WineryChainIdentityDto } from '@modules/chain/dto/chain.dto';
import {
  explorerAccountUrl,
  explorerContractUrl,
  explorerTxUrl,
} from '@modules/chain/explorer';
import type {
  ChainPortClient,
  MintIntentRequest,
  TokenizationChainPort,
  WineryChainReadiness,
} from './tokenization-chain.port';

/** `ChainTxRef` (§2.3) de una fila de `chain_transactions`. */
export function toChainTxRef(
  row: ChainTransaction,
  explorerBaseUrl: string | null,
): ChainTxRefDto {
  const error = (row.lastError ?? null) as {
    code?: unknown;
    message?: unknown;
    retryable?: unknown;
  } | null;
  return {
    id: row.id,
    kind: row.kind as ChainTxKind,
    status: row.status as ChainTxStatus,
    network: row.network as ChainNetwork,
    txHash: row.txHash,
    explorerUrl: explorerTxUrl(explorerBaseUrl, row.txHash),
    ledger: row.ledger,
    confirmedAt: row.confirmedAt ? row.confirmedAt.toISOString() : null,
    attempts: row.attempts,
    lastError:
      error && typeof error.code === 'string'
        ? {
            code: error.code,
            message: typeof error.message === 'string' ? error.message : '',
            retryable: error.retryable === true,
          }
        : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Implementación **provisional** del puerto (paso 3.3): lee la identidad de
 * las tablas `chain_accounts` y `nft_contracts` (las rellena el paso 3.2) y
 * no registra ninguna intención (lo hace el paso 3.4, dentro de la misma
 * transacción o al consumir `tokenization.request_approved`). Sin filas, la
 * identidad es `NOT_PROVISIONED` → aprobar responde 409
 * `TOK_WINERY_CHAIN_NOT_READY`.
 */
@Injectable()
export class DatabaseTokenizationChainAdapter implements TokenizationChainPort {
  constructor(@Inject(CHAIN_SETTINGS) private readonly chain: ChainSettings) {}

  async wineryIdentity(
    client: ChainPortClient,
    wineryId: string,
  ): Promise<WineryChainReadiness> {
    const network = this.chain.network;
    const [account, contract] = await Promise.all([
      client.chainAccount.findFirst({
        where: { wineryId, network, role: 'WINERY' },
      }),
      client.nftContract.findFirst({
        where: { wineryId, network, status: { not: 'RETIRED' } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    const status = (account?.status ??
      'NOT_PROVISIONED') as ChainIdentityStatus;
    const deployed =
      contract && contract.status === 'ACTIVE' && contract.address
        ? {
            id: contract.id,
            address: contract.address,
            paused: contract.paused,
          }
        : null;
    return {
      wineryId,
      network,
      status,
      ready: status === 'ACTIVE' && !!account?.address && deployed !== null,
      accountAddress: account?.address ?? null,
      contract: deployed,
    };
  }

  async wineryIdentityView(
    client: ChainPortClient,
    wineryId: string,
  ): Promise<WineryChainIdentityDto> {
    const network = this.chain.network;
    const base = this.chain.explorerBaseUrl;
    const [account, contract] = await Promise.all([
      client.chainAccount.findFirst({
        where: { wineryId, network, role: 'WINERY' },
      }),
      client.nftContract.findFirst({
        where: { wineryId, network, status: { not: 'RETIRED' } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    const txIds = [account?.createdTxId, contract?.deployedTxId].filter(
      (id): id is string => !!id,
    );
    const [txs, pending] = await Promise.all([
      txIds.length > 0
        ? client.chainTransaction.findMany({ where: { id: { in: txIds } } })
        : Promise.resolve([]),
      client.chainTransaction.findMany({
        where: {
          wineryId,
          network,
          kind: {
            in: [
              'CREATE_WINERY_ACCOUNT',
              'DEPLOY_WINERY_CONTRACT',
              'SET_TOKEN_URI_BASE',
            ],
          },
          status: { not: 'CONFIRMED' },
          abandonedAt: null,
        },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    const tx = (id: string | null | undefined) =>
      txs.find((row) => row.id === id) ?? null;
    const createdTx = tx(account?.createdTxId);
    const deployedTx = tx(contract?.deployedTxId);
    const error = (account?.lastError ?? null) as {
      code?: unknown;
      message?: unknown;
    } | null;
    return {
      wineryId,
      network,
      status: (account?.status ?? 'NOT_PROVISIONED') as ChainIdentityStatus,
      account:
        account?.address && createdTx
          ? {
              address: account.address,
              explorerUrl: explorerAccountUrl(base, account.address),
              homeDomain: account.homeDomain,
              createdTx: toChainTxRef(createdTx, base),
            }
          : null,
      contract:
        contract?.address && deployedTx
          ? {
              address: contract.address,
              explorerUrl: explorerContractUrl(base, contract.address),
              wasmHash: contract.wasmHash,
              name: contract.name,
              symbol: contract.symbol,
              baseUri: contract.baseUri,
              operatorAddress: contract.operatorAddress,
              paused: contract.paused,
              deployedTx: toChainTxRef(deployedTx, base),
              deployedAt: contract.deployedAt
                ? contract.deployedAt.toISOString()
                : null,
            }
          : null,
      pendingTransactions: pending.map((row) => toChainTxRef(row, base)),
      lastError:
        error && typeof error.code === 'string'
          ? {
              code: error.code,
              message: typeof error.message === 'string' ? error.message : '',
            }
          : null,
    };
  }

  /** Provisional: la intención la registra el paso 3.4. */
  async registerMintIntents(
    _tx: Prisma.TransactionClient,
    _request: MintIntentRequest,
  ): Promise<void> {
    // Nada: `tokenization.request_approved` lleva los mismos datos en el outbox
  }
}
