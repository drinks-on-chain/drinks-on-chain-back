import { Inject, Injectable } from '@nestjs/common';
import {
  ChainAccount,
  ChainTransaction,
  NftContract,
  Prisma,
  Winery,
  WineryStatusEnum,
} from '@prisma/client';
import { Address, Operation, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { AuditAction } from '@shared/audit/audit.actions';
import { AuditService } from '@shared/audit/audit.service';
import { OutboxService } from '@shared/outbox/outbox.service';
import { PrismaService } from '@shared/prisma/prisma.service';
import { QUEUE_CHAIN } from '@shared/queue/queue.constants';
import { ChainAlertsWriter } from '../../alerts/chain-alerts.writer';
import { CHAIN_SETTINGS, type ChainSettings } from '../../chain.config';
import { intentKeys, wineryCustodyRef } from '../../chain.constants';
import {
  WINERY_CHAIN_IDENTITY_READY,
  type WineryChainIdentityReadyPayload,
} from '../../chain.events';
import {
  contractBaseUri,
  contractName,
  contractSalt,
  contractSymbol,
  predictContractAddress,
} from '../../identity/identity-params';
import { WineryIdentityService } from '../../identity/winery-identity.service';
import { ChainTxFailure, IntentRejected } from '../../tx/chain-tx.errors';
import type {
  IntentEnv,
  IntentHandler,
  PreparedIntent,
} from '../signer/intent-handler';

type Db = Prisma.TransactionClient;

async function lockWinery(db: Db, wineryId: string): Promise<Winery> {
  await db.$queryRaw`SELECT id FROM wineries WHERE id = ${wineryId}::uuid FOR UPDATE`;
  const winery = await db.winery.findUnique({ where: { id: wineryId } });
  if (!winery) throw new IntentRejected('la bodega no existe');
  if (winery.certificationStatus !== WineryStatusEnum.ACTIVE) {
    throw new IntentRejected(
      `la bodega está ${winery.certificationStatus}, no ACTIVE`,
    );
  }
  return winery;
}

function subjectWinery(
  transaction: ChainTransaction,
  expectedKey: (wineryId: string) => string,
): string {
  const wineryId = transaction.subjectId;
  if (
    transaction.subjectType !== 'WINERY' ||
    transaction.wineryId !== wineryId ||
    transaction.intentKey !== expectedKey(wineryId)
  ) {
    throw new IntentRejected('la clave de la intención no es la de su bodega');
  }
  return wineryId;
}

async function markIdentityFailed(
  db: Db,
  accountId: string,
  failure: ChainTxFailure,
): Promise<void> {
  await db.chainAccount.update({
    where: { id: accountId },
    data: {
      status: 'FAILED',
      lastError: { code: failure.code, message: failure.message },
    },
  });
}

// ── CREATE_WINERY_ACCOUNT ────────────────────────────────────────────────────

interface AccountPlan {
  wineryId: string;
  account: ChainAccount;
}

/**
 * `CREATE_WINERY_ACCOUNT` (§3.1): `createAccount` con origen en operaciones y
 * `setOptions(homeDomain)` con origen en la cuenta nueva, en una transacción.
 * La cuenta debe existir para que `require_auth` la acepte al emitir.
 */
@Injectable()
export class CreateWineryAccountHandler implements IntentHandler<AccountPlan> {
  readonly kind = 'CREATE_WINERY_ACCOUNT' as const;
  readonly source = 'OPERATIONS' as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly identity: WineryIdentityService,
    @Inject(CHAIN_SETTINGS) private readonly settings: ChainSettings,
  ) {}

  async validate(db: Db, transaction: ChainTransaction): Promise<AccountPlan> {
    const wineryId = subjectWinery(transaction, intentKeys.wineryAccount);
    await lockWinery(db, wineryId);
    const account = await db.chainAccount.findUnique({
      where: {
        wineryId_network: { wineryId, network: transaction.network },
      },
    });
    if (
      !account ||
      account.role !== 'WINERY' ||
      account.custodyKeyRef !== wineryCustodyRef(wineryId)
    ) {
      throw new IntentRejected('la bodega no tiene su cuenta registrada');
    }
    if (account.confirmedAt !== null) {
      throw new IntentRejected('la cuenta de la bodega ya estaba confirmada');
    }
    return { wineryId, account };
  }

  async prepare(
    plan: AccountPlan,
    _transaction: ChainTransaction,
    env: IntentEnv,
  ): Promise<PreparedIntent> {
    const { wineryId, account } = plan;
    const address = await env.keys.ensureKey(account.custodyKeyRef);
    if (account.address !== null && account.address !== address) {
      throw new IntentRejected(
        'la clave custodiada no corresponde a la cuenta registrada de la bodega',
      );
    }
    if (account.address === null) {
      await this.prisma.chainAccount.update({
        where: { id: account.id },
        data: { address },
      });
    }
    const signer = {
      role: 'WINERY' as const,
      ref: account.custodyKeyRef,
      address,
      wineryId,
    };
    const homeDomain = this.settings.homeDomain;
    const setHomeDomain = homeDomain
      ? [Operation.setOptions({ homeDomain, source: address })]
      : [];
    const exists = (await env.gateway.loadAccount(address)) !== null;
    if (exists) {
      // Un intento anterior ya la creó: solo queda fijar el dominio
      return homeDomain
        ? { type: 'CLASSIC', operations: setHomeDomain, extraSigners: [signer] }
        : { type: 'ALREADY_DONE', note: 'La cuenta ya existía en la red' };
    }
    return {
      type: 'CLASSIC',
      operations: [
        Operation.createAccount({
          destination: address,
          startingBalance: this.settings.wineryStartingBalanceXlm,
        }),
        ...setHomeDomain,
      ],
      extraSigners: homeDomain ? [signer] : [],
    };
  }

  async onConfirmed(db: Db, transaction: ChainTransaction): Promise<void> {
    const wineryId = transaction.subjectId;
    await db.chainAccount.update({
      where: {
        wineryId_network: { wineryId, network: transaction.network },
      },
      data: {
        createdTxId: transaction.id,
        confirmedAt: transaction.confirmedAt ?? new Date(),
        homeDomain: this.settings.homeDomain,
      },
    });
    // Compatibilidad hasta H3 (§3.3 paso 5): la ruta legada devuelve el hash
    // de la creación de la cuenta (la dirección sale de `chain_accounts`)
    await db.winery.update({
      where: { id: wineryId },
      data: { onchainRegisterTxHash: transaction.txHash },
    });
    await this.identity.requestContract(db, wineryId, {
      userId: transaction.requestedByUserId,
      fullName: transaction.requestedByName,
      source: transaction.requestedSource === 'API' ? 'API' : 'WORKER',
    });
  }

  async onFailed(
    db: Db,
    transaction: ChainTransaction,
    failure: ChainTxFailure,
  ): Promise<void> {
    const account = await db.chainAccount.findUnique({
      where: {
        wineryId_network: {
          wineryId: transaction.subjectId,
          network: transaction.network,
        },
      },
    });
    if (account) await markIdentityFailed(db, account.id, failure);
  }
}

// ── DEPLOY_WINERY_CONTRACT ───────────────────────────────────────────────────

interface DeployPlan {
  wineryId: string;
  account: ChainAccount & { address: string };
  contract: NftContract;
}

export interface DeployVerification {
  ok: boolean;
  mismatches: string[];
}

/**
 * `DEPLOY_WINERY_CONTRACT` (§3.1): `createContract` del código
 * `WINERY_NFT_WASM_HASH` con sal determinista y el constructor `(admin =
 * cuenta de la bodega, operator = operaciones, name, symbol, base_uri)`.
 * La identidad solo pasa a `ACTIVE` tras leer de vuelta el contrato.
 */
@Injectable()
export class DeployWineryContractHandler implements IntentHandler<
  DeployPlan,
  DeployVerification
> {
  readonly kind = 'DEPLOY_WINERY_CONTRACT' as const;
  readonly source = 'OPERATIONS' as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly alerts: ChainAlertsWriter,
    @Inject(CHAIN_SETTINGS) private readonly settings: ChainSettings,
  ) {}

  async validate(
    db: Db,
    transaction: ChainTransaction,
    env: IntentEnv,
  ): Promise<DeployPlan> {
    const wineryId = subjectWinery(transaction, intentKeys.wineryContract);
    const { network } = transaction;
    const winery = await lockWinery(db, wineryId);
    const account = await db.chainAccount.findUnique({
      where: { wineryId_network: { wineryId, network } },
    });
    if (!account?.address || account.confirmedAt === null) {
      throw new IntentRejected('la cuenta de la bodega no está confirmada');
    }
    const { wasmHash, publicApiBaseUrl } = this.settings;
    if (!wasmHash) throw new IntentRejected('falta WINERY_NFT_WASM_HASH');
    if (!publicApiBaseUrl) throw new IntentRejected('falta API_PUBLIC_URL');
    if (!winery.lotPrefix || !winery.slug) {
      throw new IntentRejected('la bodega no tiene prefijo de lote o slug');
    }
    if (account.address === env.operationsAddress) {
      throw new IntentRejected('admin y operador deben ser cuentas distintas');
    }
    const others = await db.nftContract.findMany({
      where: { wineryId, network, status: { not: 'RETIRED' } },
      orderBy: { createdAt: 'asc' },
    });
    // Un solo contrato vigente por bodega y red
    if (others.some((c) => c.status === 'ACTIVE') || others.length > 1) {
      throw new IntentRejected('la bodega ya tiene un contrato vigente');
    }

    let name: string;
    let symbol: string;
    let baseUri: string;
    try {
      name = contractName(winery.commercialName);
      symbol = contractSymbol(winery.lotPrefix);
      baseUri = contractBaseUri(publicApiBaseUrl, winery.slug);
    } catch (error) {
      throw new IntentRejected(
        error instanceof Error
          ? error.message
          : 'datos del contrato no válidos',
      );
    }
    if (name.length === 0)
      throw new IntentRejected('la bodega no tiene nombre');

    const data = {
      chainAccountId: account.id,
      wasmHash,
      name,
      symbol,
      baseUri,
      operatorAddress: env.operationsAddress,
      status: 'PENDING',
    };
    const contract = others[0]
      ? await db.nftContract.update({ where: { id: others[0].id }, data })
      : await db.nftContract.create({ data: { ...data, wineryId, network } });
    return {
      wineryId,
      account: account as ChainAccount & { address: string },
      contract,
    };
  }

  async prepare(
    plan: DeployPlan,
    _transaction: ChainTransaction,
    env: IntentEnv,
  ): Promise<PreparedIntent> {
    const { wineryId, account, contract } = plan;
    const salt = contractSalt(
      this.settings.environment,
      wineryId,
      contract.wasmHash,
    );
    const address = predictContractAddress(
      this.settings.networkPassphrase,
      env.operationsAddress,
      salt,
    );
    if (contract.address !== address) {
      await this.prisma.nftContract.update({
        where: { id: contract.id },
        data: { address },
      });
    }
    if (await env.gateway.contractExists(address)) {
      // Desplegado por un intento anterior: se lee de vuelta y se confirma
      return { type: 'ALREADY_DONE', note: 'El contrato ya existía en la red' };
    }
    if (!(await env.gateway.codeExists(contract.wasmHash))) {
      throw new ChainTxFailure(
        'CHN_CONTRACT_ERROR',
        'CODE_NOT_UPLOADED',
        'El código del contrato (WINERY_NFT_WASM_HASH) no está subido en esta red',
      );
    }
    const text = (value: string) => nativeToScVal(value, { type: 'string' });
    return {
      type: 'SOROBAN',
      operation: Operation.createCustomContract({
        address: new Address(env.operationsAddress),
        wasmHash: Buffer.from(contract.wasmHash, 'hex'),
        salt,
        constructorArgs: [
          new Address(account.address).toScVal(),
          new Address(env.operationsAddress).toScVal(),
          text(contract.name),
          text(contract.symbol),
          text(contract.baseUri),
        ],
      }),
      // El constructor solo necesita la cuenta de origen (el desplegador)
      authSigners: [],
      maxFeeStroops: this.settings.deployMaxFeeStroops,
    };
  }

  /** `get_admin`, `has_role(operator)`, `name` y `symbol`, leídos de la red. */
  async verify(
    transaction: ChainTransaction,
    env: IntentEnv,
  ): Promise<DeployVerification> {
    const wineryId = transaction.subjectId;
    const contract = await this.prisma.nftContract.findFirst({
      where: {
        wineryId,
        network: transaction.network,
        status: { not: 'RETIRED' },
      },
      include: { chainAccount: true },
    });
    if (!contract?.address) {
      return { ok: false, mismatches: ['contract'] };
    }
    const address = contract.address;
    const read = (method: string, args: xdr.ScVal[] = []) =>
      env.gateway.readContract(address, method, args, env.operationsAddress);
    const [admin, operatorRole, name, symbol] = await Promise.all([
      read('get_admin'),
      read('has_role', [
        new Address(env.operationsAddress).toScVal(),
        nativeToScVal('operator', { type: 'symbol' }),
      ]),
      read('name'),
      read('symbol'),
    ]);
    const mismatches = [
      admin === contract.chainAccount.address ? null : 'get_admin',
      operatorRole !== null && operatorRole !== undefined ? null : 'has_role',
      name === contract.name ? null : 'name',
      symbol === contract.symbol ? null : 'symbol',
    ].filter((field): field is string => field !== null);
    return { ok: mismatches.length === 0, mismatches };
  }

  async onConfirmed(
    db: Db,
    transaction: ChainTransaction,
    verification: DeployVerification | undefined,
  ): Promise<void> {
    const wineryId = transaction.subjectId;
    const { network } = transaction;
    const contract = await db.nftContract.findFirstOrThrow({
      where: { wineryId, network, status: { not: 'RETIRED' } },
    });
    const now = new Date();
    if (!verification?.ok) {
      const mismatches = verification?.mismatches ?? ['verify'];
      const failure = new ChainTxFailure(
        'CHN_CONTRACT_ERROR',
        `READBACK:${mismatches.join(',')}`,
        'El contrato desplegado no coincide con lo esperado al leerlo de vuelta',
      );
      await db.nftContract.update({
        where: { id: contract.id },
        data: {
          status: 'FAILED',
          deployedTxId: transaction.id,
          deployedAt: transaction.confirmedAt ?? now,
        },
      });
      await markIdentityFailed(db, contract.chainAccountId, failure);
      await this.alerts.raise(db, {
        code: 'ROLE_MISMATCH',
        level: 'CRITICAL',
        subjectType: 'CONTRACT',
        subjectId: contract.id,
        wineryId,
        message: `El contrato de la bodega no superó la lectura de vuelta (${mismatches.join(', ')})`,
        actual: { mismatches },
      });
      return;
    }

    await db.nftContract.update({
      where: { id: contract.id },
      data: {
        status: 'ACTIVE',
        paused: false,
        deployedTxId: transaction.id,
        deployedAt: transaction.confirmedAt ?? now,
        verifiedAt: now,
      },
    });
    const account = await db.chainAccount.update({
      where: { id: contract.chainAccountId },
      data: { status: 'ACTIVE', lastError: Prisma.DbNull },
    });
    await db.winery.update({
      where: { id: wineryId },
      data: { chainAccountId: account.id },
    });
    await this.outbox.add<WineryChainIdentityReadyPayload>(db, {
      type: WINERY_CHAIN_IDENTITY_READY,
      aggregateType: 'winery',
      aggregateId: wineryId,
      queue: QUEUE_CHAIN,
      payload: {
        wineryId,
        network,
        account: account.address ?? '',
        contract: contract.address ?? '',
      },
    });
    await this.audit.record(db, {
      action: AuditAction.WINERY_CHAIN_IDENTITY_CREATED,
      resource: { type: 'winery', id: wineryId },
      organizationId: wineryId,
      actor: null,
      source: { app: 'WORKER' },
      after: {
        network,
        account: account.address,
        contract: contract.address,
        symbol: contract.symbol,
        wasmHash: contract.wasmHash,
        deployTxHash: transaction.txHash,
      },
    });
  }

  async onFailed(
    db: Db,
    transaction: ChainTransaction,
    failure: ChainTxFailure,
  ): Promise<void> {
    const contract = await db.nftContract.findFirst({
      where: {
        wineryId: transaction.subjectId,
        network: transaction.network,
        status: 'PENDING',
      },
    });
    if (contract) {
      await db.nftContract.update({
        where: { id: contract.id },
        data: { status: 'FAILED' },
      });
    }
    const account = await db.chainAccount.findUnique({
      where: {
        wineryId_network: {
          wineryId: transaction.subjectId,
          network: transaction.network,
        },
      },
    });
    if (account) await markIdentityFailed(db, account.id, failure);
  }
}
