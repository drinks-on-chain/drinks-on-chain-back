import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  CHAIN_SETTINGS,
  type ChainSettings,
} from '@modules/chain/chain.config';
import type { ChainIdentityStatus } from '@modules/chain/chain.constants';
import type { WineryChainIdentityDto } from '@modules/chain/dto/chain.dto';
import { WineryIdentityService } from '@modules/chain/identity/winery-identity.service';
import { ChainIntentsService } from '@modules/chain/tx/chain-intents.service';
import type {
  ChainPortClient,
  MintIntentRequest,
  TokenizationChainPort,
  WineryChainReadiness,
} from './tokenization-chain.port';

/** Parámetros de una intención `MINT_BATCH`: solo identificadores de dominio (§2.2). */
export interface MintBatchIntentParams {
  mintId: string;
  collectionId: string;
  contractId: string;
  /** 1, 2…: orden del trozo dentro de la emisión. */
  chunkIndex: number;
  amount: number;
  firstBottleNumber: number;
  lastBottleNumber: number;
}

/**
 * Puerto de la tokenización sobre el módulo `chain` (contrato O3 §3.1 y
 * §6.1): la identidad sale de `chain_accounts` y `nft_contracts`, que rellena
 * el firmante al confirmar la cuenta y el contrato, y la emisión se registra
 * como intenciones `MINT_BATCH` por el outbox (`ChainIntentsService`). Nunca
 * habla con la red ni toca claves: eso es del firmante del worker.
 */
@Injectable()
export class ChainTokenizationAdapter implements TokenizationChainPort {
  constructor(
    @Inject(CHAIN_SETTINGS) private readonly chain: ChainSettings,
    private readonly identities: WineryIdentityService,
    private readonly intents: ChainIntentsService,
  ) {}

  async wineryIdentity(
    client: ChainPortClient,
    wineryId: string,
  ): Promise<WineryChainReadiness> {
    const network = this.chain.network;
    const [account, contract] = await Promise.all([
      client.chainAccount.findUnique({
        where: { wineryId_network: { wineryId, network } },
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

  wineryIdentityView(
    client: ChainPortClient,
    wineryId: string,
  ): Promise<WineryChainIdentityDto> {
    return this.identities.view(wineryId, client as Prisma.TransactionClient);
  }

  /**
   * Una intención `MINT_BATCH` por trozo, en orden. Idempotente por
   * `chunk.intentKey` (§2.3, nivel 2): la llaman la aprobación (misma
   * transacción) y el procesador de `tokenization.request_approved`, y entre
   * las dos registran cada trozo una sola vez.
   */
  async registerMintIntents(
    tx: Prisma.TransactionClient,
    request: MintIntentRequest,
  ): Promise<void> {
    const chunks = [...request.chunks].sort((a, b) => a.index - b.index);
    for (const chunk of chunks) {
      const params: MintBatchIntentParams = {
        mintId: request.mintId,
        collectionId: request.collectionId,
        contractId: request.contractId,
        chunkIndex: chunk.index,
        amount: chunk.amount,
        firstBottleNumber: chunk.firstBottleNumber,
        lastBottleNumber: chunk.lastBottleNumber,
      };
      await this.intents.register(tx, {
        kind: 'MINT_BATCH',
        intentKey: chunk.intentKey,
        subject: { type: 'MINT', id: request.mintId },
        wineryId: request.wineryId,
        params: { ...params },
        requestedBy: {
          userId: request.requestedBy.userId,
          fullName: request.requestedBy.fullName,
          source: request.requestedBy.source ?? 'API',
        },
      });
    }
  }
}
