import { Inject, Injectable } from '@nestjs/common';
import { ChainTransaction } from '@prisma/client';
import { CHAIN_SETTINGS, type ChainSettings } from '../../chain.config';
import {
  CUSTODY_REF_ANCHOR,
  CUSTODY_REF_OPERATIONS,
  FRIENDBOT_NETWORKS,
} from '../../chain.constants';
import { ChainTxFailure, IntentRejected } from '../../tx/chain-tx.errors';
import { xlmToStroops } from '../../tx/chain-tx.mapper';
import type {
  IntentEnv,
  IntentHandler,
  PreparedIntent,
} from '../signer/intent-handler';

const PLATFORM_REFS: Record<string, string> = {
  OPERATIONS: CUSTODY_REF_OPERATIONS,
  ANCHOR: CUSTODY_REF_ANCHOR,
};

/** Espera a que el RPC vea la cuenta recién fondeada (va un ledger por detrás). */
const VISIBILITY_CHECKS = 20;
const VISIBILITY_WAIT_MS = 500;

interface FundPlan {
  role: string;
  ref: string;
}

/**
 * `FUND_ACCOUNT` (§2.2): Friendbot para las cuentas de la plataforma, **solo
 * en `TESTNET` y `LOCAL`**. No firma nada ni tiene cuenta de origen. Mientras
 * está en curso, el firmante no toma ninguna transacción que pague esa
 * cuenta.
 */
@Injectable()
export class FundAccountHandler implements IntentHandler<FundPlan, void> {
  readonly kind = 'FUND_ACCOUNT' as const;
  readonly source = null;

  constructor(
    @Inject(CHAIN_SETTINGS) private readonly settings: ChainSettings,
  ) {}

  validate(_db: unknown, transaction: ChainTransaction): Promise<FundPlan> {
    if (!FRIENDBOT_NETWORKS.includes(this.settings.network)) {
      throw new IntentRejected('Friendbot solo existe en TESTNET y LOCAL');
    }
    const role = transaction.subjectId;
    const ref = PLATFORM_REFS[role];
    if (transaction.subjectType !== 'PLATFORM' || !ref) {
      throw new IntentRejected(
        'solo se fondean las cuentas de operaciones y de anclaje',
      );
    }
    return Promise.resolve({ role, ref });
  }

  async prepare(
    plan: FundPlan,
    _transaction: ChainTransaction,
    env: IntentEnv,
  ): Promise<PreparedIntent> {
    const address = await env.keys.publicKey(plan.ref);
    const balance = await env.gateway.accountBalance(address);
    // Un intento anterior ya la fondeó (o alguien la recargó): nada que pedir
    if (balance !== null && balance >= this.minimum(plan.role)) {
      return { type: 'ALREADY_DONE', note: 'La cuenta ya tenía saldo' };
    }
    return { type: 'FRIENDBOT', address };
  }

  /**
   * La cuenta debe verse ya en el RPC antes de dar el fondeo por hecho: las
   * transacciones que esperaban a esta cuenta la cargan a continuación.
   */
  async verify(transaction: ChainTransaction, env: IntentEnv): Promise<void> {
    const address = await env.keys.publicKey(
      PLATFORM_REFS[transaction.subjectId],
    );
    for (let check = 1; check <= VISIBILITY_CHECKS; check += 1) {
      if ((await env.gateway.accountBalance(address)) !== null) return;
      await new Promise((resolve) => setTimeout(resolve, VISIBILITY_WAIT_MS));
    }
    throw new ChainTxFailure(
      'CHN_RPC_UNAVAILABLE',
      'la cuenta fondeada aún no aparece en el RPC',
    );
  }

  private minimum(role: string): bigint {
    return xlmToStroops(
      role === 'OPERATIONS'
        ? this.settings.operationsMinBalanceXlm
        : this.settings.anchorMinBalanceXlm,
    );
  }
}
