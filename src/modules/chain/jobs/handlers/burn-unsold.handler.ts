import { Injectable } from '@nestjs/common';
import { ChainTransaction, Prisma } from '@prisma/client';
import { Address, Contract, nativeToScVal } from '@stellar/stellar-sdk';
import { AuditService } from '@shared/audit/audit.service';
import { PrismaService } from '@shared/prisma/prisma.service';
import {
  applyBurnConfirmed,
  validateBurnUnsold,
  type BurnUnsoldPlan,
} from '@modules/tokenization/closure/closure-writes';
import { ChainAlertsWriter } from '../../alerts/chain-alerts.writer';
import { ChainTxFailure } from '../../tx/chain-tx.errors';
import type {
  IntentEnv,
  IntentHandler,
  PreparedIntent,
} from '../signer/intent-handler';

type Db = Prisma.TransactionClient;

/** `NonExistentToken` (`docs/funciones.md`): token no emitido o quemado. */
const NON_EXISTENT_TOKEN = 200;

export interface BurnVerification {
  /** `owner_of` falla con 200: la red ya no reconoce al NFT. */
  burnedOnChain: boolean;
}

/** Dueño del NFT en la red; `null` si no existe o está quemado. */
export async function ownerOnChain(
  env: Pick<IntentEnv, 'gateway' | 'operationsAddress'>,
  contractAddress: string,
  tokenId: number,
): Promise<string | null> {
  try {
    const owner = await env.gateway.readContract(
      contractAddress,
      'owner_of',
      [nativeToScVal(tokenId, { type: 'u32' })],
      env.operationsAddress,
    );
    return typeof owner === 'string' ? owner : null;
  } catch (error) {
    if (
      error instanceof ChainTxFailure &&
      error.code === 'CHN_CONTRACT_ERROR' &&
      error.meta.contractErrorCode === NON_EXISTENT_TOKEN
    ) {
      return null;
    }
    throw error;
  }
}

/**
 * `BURN_UNSOLD` (contrato O3 §8.4, TOK-10): `redeem_burn(token_id, operator)`
 * de un NFT sin vender que se quedó sin botella en un cierre con faltante
 * (o de los no vendidos, si administración decidió quemarlos). La autoriza
 * la propia cuenta de origen (operaciones, rol `operator`): no hay firma
 * aparte. Tras confirmarse se lee la red: solo si `owner_of` falla con 200
 * el NFT pasa a `BURNED`.
 */
@Injectable()
export class BurnUnsoldHandler implements IntentHandler<
  BurnUnsoldPlan,
  BurnVerification
> {
  readonly kind = 'BURN_UNSOLD' as const;
  readonly source = 'OPERATIONS' as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly alerts: ChainAlertsWriter,
  ) {}

  validate(db: Db, transaction: ChainTransaction): Promise<BurnUnsoldPlan> {
    return validateBurnUnsold(db, transaction);
  }

  async prepare(
    plan: BurnUnsoldPlan,
    _transaction: ChainTransaction,
    env: IntentEnv,
  ): Promise<PreparedIntent> {
    const owner = await ownerOnChain(env, plan.contract.address, plan.tokenId);
    if (owner === null) {
      // Un intento anterior ya lo quemó (idempotencia en la red, §2.3)
      return { type: 'ALREADY_DONE', note: 'La red ya no reconoce el NFT' };
    }
    return {
      type: 'SOROBAN',
      operation: new Contract(plan.contract.address).call(
        'redeem_burn',
        nativeToScVal(plan.tokenId, { type: 'u32' }),
        new Address(env.operationsAddress).toScVal(),
      ),
      authSigners: [],
    };
  }

  /** Lectura de vuelta: el NFT ya no tiene dueño en la red. */
  async verify(
    transaction: ChainTransaction,
    env: IntentEnv,
  ): Promise<BurnVerification> {
    const token = await this.prisma.token.findUnique({
      where: { id: transaction.subjectId },
      select: { tokenId: true, contract: { select: { address: true } } },
    });
    if (!token?.contract.address) return { burnedOnChain: false };
    return {
      burnedOnChain:
        (await ownerOnChain(env, token.contract.address, token.tokenId)) ===
        null,
    };
  }

  async onConfirmed(
    db: Db,
    transaction: ChainTransaction,
    verification: BurnVerification | undefined,
  ): Promise<void> {
    const result = await applyBurnConfirmed(
      db,
      { audit: this.audit },
      transaction,
      verification,
    );
    if (result !== 'NOT_BURNED') return;
    // La quema se confirmó pero la red sigue dando dueño: no se da por quemado
    await this.alerts.raise(db, {
      code: 'BURN_MISMATCH',
      level: 'CRITICAL',
      subjectType: 'TOKEN',
      subjectId: transaction.subjectId,
      wineryId: transaction.wineryId,
      message:
        'La quema del NFT se confirmó en la red, pero owner_of sigue devolviendo un dueño: el NFT no se marca como quemado',
      expected: { burned: true },
      actual: { burnedOnChain: false, txHash: transaction.txHash },
    });
  }
}
