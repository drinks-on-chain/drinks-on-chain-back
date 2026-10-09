import { Inject, Injectable } from '@nestjs/common';
import {
  ChainAccount,
  ChainTransaction,
  NftContract,
  Prisma,
} from '@prisma/client';
import { Contract, nativeToScVal } from '@stellar/stellar-sdk';
import { CHAIN_SETTINGS, type ChainSettings } from '../../chain.config';
import { intentKeys } from '../../chain.constants';
import { contractBaseUri } from '../../identity/identity-params';
import { IntentRejected } from '../../tx/chain-tx.errors';
import type { IntentHandler, PreparedIntent } from '../signer/intent-handler';

type Db = Prisma.TransactionClient;

interface UriPlan {
  contract: NftContract & { address: string };
  account: ChainAccount & { address: string };
  baseUri: string;
}

/**
 * `SET_TOKEN_URI_BASE` (contrato O3 §2.2 y §3.1): `set_token_uri_base` con la
 * URI que toca a la bodega (`{API}/v1/public/nft/{slug}/`), calculada de sus
 * datos y nunca recibida de fuera. La autoriza la bodega (admin); paga
 * operaciones. Hace falta cuando cambia el `slug` de la bodega o el origen
 * público de la API después de desplegar el contrato.
 */
@Injectable()
export class SetTokenUriBaseHandler implements IntentHandler<UriPlan> {
  readonly kind = 'SET_TOKEN_URI_BASE' as const;
  readonly source = 'OPERATIONS' as const;

  constructor(
    @Inject(CHAIN_SETTINGS) private readonly settings: ChainSettings,
  ) {}

  /** La URI que corresponde a la bodega; `null` si no se puede calcular. */
  private expected(slug: string | null): string | null {
    if (!this.settings.publicApiBaseUrl || !slug) return null;
    try {
      return contractBaseUri(this.settings.publicApiBaseUrl, slug);
    } catch {
      return null;
    }
  }

  async validate(db: Db, transaction: ChainTransaction): Promise<UriPlan> {
    if (transaction.subjectType !== 'CONTRACT') {
      throw new IntentRejected('el sujeto de la intención no es un contrato');
    }
    const contractId = transaction.subjectId;
    await db.$queryRaw`SELECT id FROM nft_contracts WHERE id = ${contractId}::uuid FOR UPDATE`;
    const contract = await db.nftContract.findUnique({
      where: { id: contractId },
      include: { chainAccount: true, winery: { select: { slug: true } } },
    });
    if (
      !contract?.address ||
      contract.status !== 'ACTIVE' ||
      contract.network !== transaction.network ||
      contract.wineryId !== transaction.wineryId ||
      !contract.chainAccount.address
    ) {
      throw new IntentRejected('la bodega no tiene un contrato vigente');
    }
    const baseUri = this.expected(contract.winery.slug);
    if (
      !baseUri ||
      transaction.intentKey !== intentKeys.tokenUriBase(contractId, baseUri)
    ) {
      throw new IntentRejected(
        'la URI de la intención no es la que corresponde a la bodega',
      );
    }
    return {
      contract: contract as UriPlan['contract'],
      account: contract.chainAccount as UriPlan['account'],
      baseUri,
    };
  }

  prepare(plan: UriPlan): Promise<PreparedIntent> {
    const { contract, account, baseUri } = plan;
    if (contract.baseUri === baseUri) {
      return Promise.resolve({
        type: 'ALREADY_DONE',
        note: 'El contrato ya tenía esa URI base',
      });
    }
    return Promise.resolve({
      type: 'SOROBAN',
      operation: new Contract(contract.address).call(
        'set_token_uri_base',
        nativeToScVal(baseUri, { type: 'string' }),
      ),
      authSigners: [
        {
          role: 'WINERY',
          ref: account.custodyKeyRef,
          address: account.address,
          wineryId: contract.wineryId,
        },
      ],
    });
  }

  async onConfirmed(db: Db, transaction: ChainTransaction): Promise<void> {
    const contract = await db.nftContract.findUniqueOrThrow({
      where: { id: transaction.subjectId },
      include: { winery: { select: { slug: true } } },
    });
    const baseUri = this.expected(contract.winery.slug);
    if (!baseUri) return;
    await db.nftContract.update({
      where: { id: contract.id },
      data: { baseUri },
    });
  }
}
