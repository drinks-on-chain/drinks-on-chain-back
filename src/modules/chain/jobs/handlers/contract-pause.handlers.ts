import { Injectable } from '@nestjs/common';
import {
  ChainAccount,
  ChainTransaction,
  NftContract,
  Prisma,
} from '@prisma/client';
import { Address, Contract } from '@stellar/stellar-sdk';
import { AuditAction } from '@shared/audit/audit.actions';
import { intentKeys } from '../../chain.constants';
import { IntentRejected } from '../../tx/chain-tx.errors';
import type {
  IntentEnv,
  IntentHandler,
  PreparedIntent,
} from '../signer/intent-handler';

type Db = Prisma.TransactionClient;

interface PausePlan {
  contract: NftContract & { address: string };
  account: ChainAccount & { address: string };
}

/** Entradas de bitácora que justifican cada intención (§2.2). */
const PAUSE_AUDIT_ACTIONS: readonly string[] = [
  AuditAction.CHAIN_CONTRACT_PAUSED,
  AuditAction.WINERY_REVOKED,
];
const UNPAUSE_AUDIT_ACTIONS: readonly string[] = [
  AuditAction.CHAIN_CONTRACT_UNPAUSED,
];

/**
 * Validación común de §2.2 para pausar y reanudar: contrato vigente con la
 * fila bloqueada, clave de la intención coherente y **entrada de bitácora**
 * de la acción del back office (o de la revocación de la bodega).
 */
async function validatePause(
  db: Db,
  transaction: ChainTransaction,
  expect: {
    paused: boolean;
    key: (contractId: string, auditEventId: string) => string;
    actions: readonly string[];
  },
): Promise<PausePlan> {
  if (transaction.subjectType !== 'CONTRACT') {
    throw new IntentRejected('el sujeto de la intención no es un contrato');
  }
  const contractId = transaction.subjectId;
  await db.$queryRaw`SELECT id FROM nft_contracts WHERE id = ${contractId}::uuid FOR UPDATE`;
  const contract = await db.nftContract.findUnique({
    where: { id: contractId },
    include: { chainAccount: true },
  });
  if (
    !contract?.address ||
    contract.status !== 'ACTIVE' ||
    contract.network !== transaction.network ||
    contract.wineryId !== transaction.wineryId
  ) {
    throw new IntentRejected('la bodega no tiene un contrato vigente');
  }
  if (!contract.chainAccount.address) {
    throw new IntentRejected('la cuenta de la bodega no tiene dirección');
  }
  if (contract.paused !== expect.paused) {
    throw new IntentRejected(
      expect.paused
        ? 'el contrato no está pausado'
        : 'el contrato ya está pausado',
    );
  }
  const auditEventId = (transaction.intent as { auditEventId?: unknown })
    ?.auditEventId;
  if (
    typeof auditEventId !== 'string' ||
    transaction.intentKey !== expect.key(contractId, auditEventId)
  ) {
    throw new IntentRejected('la intención no cita su entrada de bitácora');
  }
  const entry = await db.auditEvent.findUnique({
    where: { id: auditEventId },
    select: { action: true, organizationId: true },
  });
  if (
    !entry ||
    !expect.actions.includes(entry.action) ||
    entry.organizationId !== contract.wineryId
  ) {
    throw new IntentRejected(
      'no hay una entrada de bitácora que respalde la acción',
    );
  }
  return {
    contract: contract as NftContract & { address: string },
    account: contract.chainAccount as ChainAccount & { address: string },
  };
}

async function applyPaused(
  db: Db,
  transaction: ChainTransaction,
  paused: boolean,
): Promise<void> {
  const contract = await db.nftContract.update({
    where: { id: transaction.subjectId },
    data: { paused },
  });
  await db.chainAccount.update({
    where: { id: contract.chainAccountId },
    data: { status: paused ? 'PAUSED' : 'ACTIVE' },
  });
}

async function alreadyInState(
  env: IntentEnv,
  contractAddress: string,
  paused: boolean,
): Promise<boolean> {
  const onChain = await env.gateway.readContract(
    contractAddress,
    'paused',
    [],
    env.operationsAddress,
  );
  return onChain === paused;
}

/**
 * `PAUSE_CONTRACT` (§3.5): `pause(caller = operador)`. La autoriza la propia
 * cuenta de origen (operaciones): no hay firma aparte. Detiene emisión,
 * entregas y quemas de toda la bodega.
 */
@Injectable()
export class PauseContractHandler implements IntentHandler<PausePlan> {
  readonly kind = 'PAUSE_CONTRACT' as const;
  readonly source = 'OPERATIONS' as const;

  validate(db: Db, transaction: ChainTransaction): Promise<PausePlan> {
    return validatePause(db, transaction, {
      paused: false,
      key: intentKeys.pause,
      actions: PAUSE_AUDIT_ACTIONS,
    });
  }

  async prepare(
    plan: PausePlan,
    _transaction: ChainTransaction,
    env: IntentEnv,
  ): Promise<PreparedIntent> {
    if (await alreadyInState(env, plan.contract.address, true)) {
      return { type: 'ALREADY_DONE', note: 'El contrato ya estaba pausado' };
    }
    return {
      type: 'SOROBAN',
      operation: new Contract(plan.contract.address).call(
        'pause',
        new Address(env.operationsAddress).toScVal(),
      ),
      authSigners: [],
    };
  }

  onConfirmed(db: Db, transaction: ChainTransaction): Promise<void> {
    return applyPaused(db, transaction, true);
  }
}

/**
 * `UNPAUSE_CONTRACT` (§3.5): `unpause(caller = bodega)`. Solo la bodega, como
 * administradora, reanuda (DS-05): su entrada de autorización se firma con su
 * clave custodiada; el sobre lo paga operaciones.
 */
@Injectable()
export class UnpauseContractHandler implements IntentHandler<PausePlan> {
  readonly kind = 'UNPAUSE_CONTRACT' as const;
  readonly source = 'OPERATIONS' as const;

  validate(db: Db, transaction: ChainTransaction): Promise<PausePlan> {
    return validatePause(db, transaction, {
      paused: true,
      key: intentKeys.unpause,
      actions: UNPAUSE_AUDIT_ACTIONS,
    });
  }

  async prepare(
    plan: PausePlan,
    _transaction: ChainTransaction,
    env: IntentEnv,
  ): Promise<PreparedIntent> {
    const { contract, account } = plan;
    if (await alreadyInState(env, contract.address, false)) {
      return { type: 'ALREADY_DONE', note: 'El contrato ya estaba reanudado' };
    }
    return {
      type: 'SOROBAN',
      operation: new Contract(contract.address).call(
        'unpause',
        new Address(account.address).toScVal(),
      ),
      authSigners: [
        {
          role: 'WINERY',
          ref: account.custodyKeyRef,
          address: account.address,
          wineryId: contract.wineryId,
        },
      ],
    };
  }

  onConfirmed(db: Db, transaction: ChainTransaction): Promise<void> {
    return applyPaused(db, transaction, false);
  }
}
