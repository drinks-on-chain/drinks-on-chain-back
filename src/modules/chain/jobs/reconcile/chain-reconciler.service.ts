import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, ReconciliationRun } from '@prisma/client';
import { Address, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { PrismaService } from '@shared/prisma/prisma.service';
import {
  ChainAlertsWriter,
  type ChainAlertInput,
} from '../../alerts/chain-alerts.writer';
import { CHAIN_SETTINGS, type ChainSettings } from '../../chain.config';
import {
  CUSTODY_REF_OPERATIONS,
  TTL_ALERT_BELOW_DAYS,
  TX_STUCK_MINUTES,
  type ReconciliationDepth,
} from '../../chain.constants';
import { KEY_CUSTODY, type KeyCustody } from '../../custody/key-custody';
import {
  ReconciliationAlreadyRunning,
  ReconciliationRunsService,
  type ReconciliationTrigger,
} from '../../reconciliation/reconciliation-runs.service';
import { ChainTxFailure } from '../../tx/chain-tx.errors';
import { OPEN_TX_STATUSES } from '../../tx/chain-tx.state';
import { CHAIN_GATEWAY, type ChainGateway } from '../gateway/chain-gateway';
import { PlatformAccountsSync } from '../platform-accounts.sync';
import { ChainTtlService, type TtlReading } from '../ttl/chain-ttl.service';

/** Tokens que la conciliación ligera lee de la red por contrato (muestra). */
const LIGHT_SAMPLE = 20;
/** Lecturas de `owner_of` en paralelo. */
const READ_CONCURRENCY = 5;
/** Diferencias que caben en el detalle de una alerta. */
const MAX_DETAILS = 20;
/** `NonExistentToken` (`docs/funciones.md`): token no emitido o quemado. */
const NON_EXISTENT_TOKEN = 200;
/** Estados en que el NFT es de un consumidor (§6.3). */
const SOLD_STATUSES = [
  'SOLD',
  'REDEEMABLE',
  'PASS_ACTIVE',
  'REDEEMED',
  'EXPIRED',
];
/** Transacciones que mueven contadores: con una en vuelo no se comparan. */
const MOVING_KINDS = ['MINT_BATCH', 'BURN_UNSOLD'];
const IN_FLIGHT = ['BUILDING', 'SUBMITTED', 'RETRYING'];
/** Alertas de una transacción que se cierran solas si acaba confirmándose. */
const TX_ALERT_CODES = [
  'TX_STUCK',
  'TX_FAILED',
  'CHN_INTENT_REJECTED',
  'LOW_BALANCE',
];

type Subject = Pick<ChainAlertInput, 'subjectType' | 'subjectId'>;

interface RunContext {
  run: ReconciliationRun;
  depth: ReconciliationDepth;
  operations: string;
  checks: number;
  opened: number;
  autoResolved: number;
  differences: number;
}

const asInteger = (value: unknown): number | null => {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) ? n : null;
};

async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await work(items[index]);
      }
    },
  );
  await Promise.all(lanes);
  return results;
}

/**
 * Conciliación (contrato O3 §8.2, CHN-12): compara lo que dice la base con lo
 * que dice la red, contrato a contrato, y abre una alerta por cada
 * diferencia. **Nunca corrige nada** en ninguna dirección (S-19): solo cierra
 * sola la alerta cuya condición ya no se da (`resolution.auto`).
 *
 * - `LIGHT` (cada hora): contadores, pausa, roles, reglas de la base,
 *   transacciones atascadas, TTL y una muestra de dueños y quemas.
 * - `FULL` (02:30 America/La_Paz, bajo demanda y tras un hueco del
 *   indexador): además, todos los NFT vendidos y quemados y la transacción de
 *   cada anclaje que el RPC aún conserve.
 */
@Injectable()
export class ChainReconciler {
  private readonly logger = new Logger(ChainReconciler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: ChainAlertsWriter,
    private readonly runs: ReconciliationRunsService,
    private readonly ttl: ChainTtlService,
    private readonly accounts: PlatformAccountsSync,
    @Inject(KEY_CUSTODY) private readonly custody: KeyCustody,
    @Inject(CHAIN_GATEWAY) private readonly gateway: ChainGateway,
    @Inject(CHAIN_SETTINGS) private readonly settings: ChainSettings,
  ) {}

  /** Programada: abre la ejecución y la hace. `null` si ya había una en curso. */
  async runNow(
    depth: ReconciliationDepth,
    trigger: ReconciliationTrigger = 'SCHEDULED',
  ): Promise<ReconciliationRun | null> {
    if (!this.settings.enabled) return null;
    let run: ReconciliationRun;
    try {
      run = await this.prisma.$transaction((db) =>
        this.runs.open(
          db,
          { scope: 'ALL', depth, trigger },
          { announce: false },
        ),
      );
    } catch (error) {
      if (error instanceof ReconciliationAlreadyRunning) return null;
      throw error;
    }
    return this.execute(run.id);
  }

  /** Ejecuta una conciliación `RUNNING` ya registrada y la cierra. */
  async execute(runId: string): Promise<ReconciliationRun | null> {
    const run = await this.prisma.reconciliationRun.findUnique({
      where: { id: runId },
    });
    if (!run || run.status !== 'RUNNING') return run;
    const ctx: RunContext = {
      run,
      depth: run.depth === 'LIGHT' ? 'LIGHT' : 'FULL',
      operations: '',
      checks: 0,
      opened: 0,
      autoResolved: 0,
      differences: 0,
    };
    let status: 'OK' | 'DIFFERENCES' | 'ERROR';
    try {
      if (!this.settings.enabled) {
        throw new ChainTxFailure('CHN_RPC_UNAVAILABLE', 'cadena deshabilitada');
      }
      ctx.operations = await this.custody.publicKey(CUSTODY_REF_OPERATIONS);
      await this.reconcile(ctx);
      status = ctx.differences > 0 ? 'DIFFERENCES' : 'OK';
    } catch (error) {
      status = 'ERROR';
      this.logger.error({
        message: `Conciliación ${runId} interrumpida`,
        runId,
        error:
          error instanceof Error ? error.message.slice(0, 300) : String(error),
      });
    }
    const finished = await this.prisma.reconciliationRun.update({
      where: { id: runId },
      data: {
        status,
        finishedAt: new Date(),
        checks: ctx.checks,
        issuesOpened: ctx.opened,
        issuesAutoResolved: ctx.autoResolved,
      },
    });
    this.logger.log({
      message: `Conciliación ${run.depth} ${status}`,
      runId,
      scope: run.scope,
      trigger: run.trigger,
      checks: ctx.checks,
      differences: ctx.differences,
      issuesOpened: ctx.opened,
      issuesAutoResolved: ctx.autoResolved,
    });
    return finished;
  }

  // ── Recorrido ────────────────────────────────────────────────────────────

  private async reconcile(ctx: RunContext): Promise<void> {
    const { network } = this.settings;
    const { scope, subjectId } = ctx.run;
    let collectionId: string | null = null;
    let contractWhere: Prisma.NftContractWhereInput = { status: 'ACTIVE' };
    if (scope === 'CONTRACT') {
      contractWhere = { id: subjectId ?? '' };
    } else if (scope === 'COLLECTION') {
      collectionId = subjectId;
      contractWhere = { collections: { some: { id: subjectId ?? '' } } };
    }
    const contracts = await this.prisma.nftContract.findMany({
      where: { network, address: { not: null }, ...contractWhere },
      include: { chainAccount: true },
      orderBy: { createdAt: 'asc' },
    });
    for (const contract of contracts) {
      await this.checkContract(ctx, contract, collectionId);
    }
    await this.checkAnchors(ctx, collectionId);
    if (scope !== 'ALL') return;
    await this.checkTransactions(ctx);
    await this.checkBalances(ctx);
    await this.checkCodeTtl(ctx);
  }

  /** Una comprobación: si cuadra cierra su alerta; si no, la abre. */
  private async verdict(
    ctx: RunContext,
    ok: boolean,
    alert: ChainAlertInput,
    resolvedNote = 'La diferencia ya no se da en la conciliación',
  ): Promise<void> {
    ctx.checks += 1;
    await this.prisma.$transaction(async (db) => {
      if (ok) {
        ctx.autoResolved += await this.alerts.resolveAuto(
          db,
          {
            code: alert.code,
            subjectType: alert.subjectType,
            subjectId: alert.subjectId,
          },
          resolvedNote,
        );
        return;
      }
      ctx.differences += 1;
      const raised = await this.alerts.raise(db, {
        ...alert,
        runId: ctx.run.id,
      });
      if (raised) ctx.opened += 1;
    });
  }

  private read(
    ctx: RunContext,
    address: string,
    method: string,
    args: xdr.ScVal[] = [],
  ): Promise<unknown> {
    return this.gateway.readContract(address, method, args, ctx.operations);
  }

  // ── Por contrato ─────────────────────────────────────────────────────────

  private async checkContract(
    ctx: RunContext,
    contract: Prisma.NftContractGetPayload<{ include: { chainAccount: true } }>,
    onlyCollectionId: string | null,
  ): Promise<void> {
    const address = contract.address as string;
    const account = contract.chainAccount.address;
    const subject: Subject = {
      subjectType: 'CONTRACT',
      subjectId: contract.id,
    };
    const wineryId = contract.wineryId;

    // Reinicio de la red (S-22): el RPC ya no conoce el contrato
    const exists = await this.gateway.contractExists(address);
    await this.verdict(ctx, exists, {
      code: 'NETWORK_RESET',
      level: 'CRITICAL',
      ...subject,
      wineryId,
      message: `La red ${contract.network} ya no reconoce el contrato de la bodega: parece un reinicio. Sigue el procedimiento del README del despliegue`,
      expected: { contract: address },
      actual: { exists: false },
    });
    if (!exists || !account) return;

    const [totalMinted, balance, paused, admin, operatorRole] =
      await Promise.all([
        this.read(ctx, address, 'total_minted').then(asInteger),
        this.read(ctx, address, 'balance', [
          new Address(account).toScVal(),
        ]).then(asInteger),
        this.read(ctx, address, 'paused'),
        this.read(ctx, address, 'get_admin'),
        this.read(ctx, address, 'has_role', [
          new Address(ctx.operations).toScVal(),
          nativeToScVal('operator', { type: 'symbol' }),
        ]),
      ]);

    // Con una emisión o una quema en vuelo, los contadores aún se mueven
    const moving = await this.prisma.chainTransaction.count({
      where: {
        network: contract.network,
        wineryId,
        kind: { in: MOVING_KINDS },
        status: { in: IN_FLIGHT },
      },
    });
    if (moving === 0) {
      const mints = await this.prisma.mint.findMany({
        where: { collection: { contractId: contract.id } },
        select: { ranges: true },
      });
      const confirmed = mints.reduce((sum, mint) => {
        const ranges = Array.isArray(mint.ranges)
          ? (mint.ranges as { firstTokenId: number; lastTokenId: number }[])
          : [];
        return (
          sum +
          ranges.reduce((s, r) => s + (r.lastTokenId - r.firstTokenId + 1), 0)
        );
      }, 0);
      await this.verdict(ctx, totalMinted === confirmed, {
        code: 'TOTAL_MINTED_MISMATCH',
        level: 'CRITICAL',
        ...subject,
        wineryId,
        message: `La base tiene ${confirmed} NFT emitidos y confirmados en el contrato y la red dice ${totalMinted ?? '?'}`,
        expected: { confirmedInDatabase: confirmed },
        actual: { totalMinted },
      });

      const held = await this.prisma.token.count({
        where: {
          contractId: contract.id,
          ownerKind: 'WINERY',
          status: { in: ['MINTED', 'RESERVED'] },
        },
      });
      await this.verdict(ctx, balance === held, {
        code: 'BALANCE_MISMATCH',
        level: 'CRITICAL',
        ...subject,
        wineryId,
        message: `La base tiene ${held} NFT a nombre de la bodega y la red dice ${balance ?? '?'}`,
        expected: { wineryTokensInDatabase: held, account },
        actual: { balance },
      });
      await this.checkOwners(ctx, contract.id, address, wineryId);
      await this.checkBurns(ctx, contract.id, address, wineryId);
    }

    await this.verdict(ctx, paused === contract.paused, {
      code: 'PAUSE_MISMATCH',
      level: 'CRITICAL',
      ...subject,
      wineryId,
      message: `El contrato figura ${contract.paused ? 'pausado' : 'sin pausar'} en la base y ${paused === true ? 'pausado' : 'sin pausar'} en la red`,
      expected: { paused: contract.paused },
      actual: { paused: paused === true },
    });
    const hasOperator = operatorRole !== null && operatorRole !== undefined;
    await this.verdict(ctx, admin === account && hasOperator, {
      code: 'ROLE_MISMATCH',
      level: 'CRITICAL',
      ...subject,
      wineryId,
      message:
        'El administrador o el operador del contrato en la red no son los de la plataforma',
      expected: { admin: account, operator: ctx.operations },
      actual: {
        admin: typeof admin === 'string' ? admin : null,
        operationsHasOperatorRole: hasOperator,
      },
    });

    await this.checkCollections(ctx, contract.id, onlyCollectionId);
    await this.checkContractTtl(ctx, contract.id, wineryId);
  }

  /** `OWNER_MISMATCH`: dueño de los vendidos (todos en la completa; muestra en la ligera). */
  private async checkOwners(
    ctx: RunContext,
    contractId: string,
    address: string,
    wineryId: string,
  ): Promise<void> {
    const tokens = await this.sample(ctx, {
      contractId,
      status: { in: SOLD_STATUSES },
    });
    const owners = await mapLimited(
      tokens,
      READ_CONCURRENCY,
      async (token) => ({
        token,
        owner: await this.ownerOf(ctx, address, token.tokenId),
      }),
    );
    const wrong = owners.filter(
      ({ token, owner }) => owner !== token.ownerAddress,
    );
    await this.verdict(ctx, wrong.length === 0, {
      code: 'OWNER_MISMATCH',
      level: 'CRITICAL',
      subjectType: 'CONTRACT',
      subjectId: contractId,
      wineryId,
      message: `${wrong.length} NFT vendidos tienen en la red un dueño distinto del de la base`,
      expected: { checked: tokens.length },
      actual: {
        mismatches: wrong.slice(0, MAX_DETAILS).map(({ token, owner }) => ({
          tokenId: token.tokenId,
          database: token.ownerAddress,
          network: owner,
        })),
        total: wrong.length,
      },
    });
  }

  /** `BURN_MISMATCH`: un NFT `BURNED` no puede tener dueño en la red (error 200). */
  private async checkBurns(
    ctx: RunContext,
    contractId: string,
    address: string,
    wineryId: string,
  ): Promise<void> {
    const tokens = await this.sample(ctx, { contractId, status: 'BURNED' });
    const owners = await mapLimited(
      tokens,
      READ_CONCURRENCY,
      async (token) => ({
        token,
        owner: await this.ownerOf(ctx, address, token.tokenId),
      }),
    );
    const alive = owners.filter(({ owner }) => owner !== null);
    await this.verdict(ctx, alive.length === 0, {
      code: 'BURN_MISMATCH',
      level: 'CRITICAL',
      subjectType: 'CONTRACT',
      subjectId: contractId,
      wineryId,
      message: `${alive.length} NFT quemados en la base siguen teniendo dueño en la red`,
      expected: { checked: tokens.length, burned: true },
      actual: {
        alive: alive.slice(0, MAX_DETAILS).map(({ token, owner }) => ({
          tokenId: token.tokenId,
          owner,
        })),
        total: alive.length,
      },
    });
  }

  /** Todos en la completa; una muestra al azar en la ligera. */
  private async sample(
    ctx: RunContext,
    where: Prisma.TokenWhereInput,
  ): Promise<{ tokenId: number; ownerAddress: string }[]> {
    const select = { tokenId: true, ownerAddress: true } as const;
    if (ctx.depth === 'FULL') {
      return this.prisma.token.findMany({
        where,
        select,
        orderBy: { tokenId: 'asc' },
      });
    }
    const total = await this.prisma.token.count({ where });
    const skip =
      total > LIGHT_SAMPLE
        ? Math.floor(Math.random() * (total - LIGHT_SAMPLE + 1))
        : 0;
    return this.prisma.token.findMany({
      where,
      select,
      orderBy: { tokenId: 'asc' },
      skip,
      take: LIGHT_SAMPLE,
    });
  }

  /** Dueño en la red; `null` si el token no existe o está quemado (error 200). */
  private async ownerOf(
    ctx: RunContext,
    address: string,
    tokenId: number,
  ): Promise<string | null> {
    try {
      const owner = await this.read(ctx, address, 'owner_of', [
        nativeToScVal(tokenId, { type: 'u32' }),
      ]);
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

  /** Reglas que solo mira la base: `QUOTA_EXCEEDED` y `BOTTLES_SHORTFALL`. */
  private async checkCollections(
    ctx: RunContext,
    contractId: string,
    onlyCollectionId: string | null,
  ): Promise<void> {
    const collections = await this.prisma.collection.findMany({
      where: {
        contractId,
        ...(onlyCollectionId ? { id: onlyCollectionId } : {}),
      },
      select: {
        id: true,
        wineryId: true,
        quota: true,
        minted: true,
        lot: {
          select: {
            estimatedBottles: true,
            discardedAt: true,
            bottlingBatch: { select: { id: true } },
            _count: {
              select: { bottleUnits: { where: { status: 'ACTIVE' } } },
            },
          },
        },
        _count: { select: { tokens: { where: { status: 'BURNED' } } } },
      },
    });
    for (const collection of collections) {
      const subject: Subject = {
        subjectType: 'COLLECTION',
        subjectId: collection.id,
      };
      const { lot } = collection;
      const bottled = lot.bottlingBatch !== null;
      const closed = bottled || lot.discardedAt !== null;
      const overEstimate =
        !closed &&
        lot.estimatedBottles !== null &&
        collection.minted > lot.estimatedBottles;
      await this.verdict(
        ctx,
        collection.minted <= collection.quota && !overEstimate,
        {
          code: 'QUOTA_EXCEEDED',
          level: 'CRITICAL',
          ...subject,
          wineryId: collection.wineryId,
          message: overEstimate
            ? `Hay ${collection.minted} NFT emitidos y la estimación del lote es de ${lot.estimatedBottles} botellas`
            : `Hay ${collection.minted} NFT emitidos y la cuota es de ${collection.quota}`,
          expected: {
            quota: collection.quota,
            estimatedBottles: closed ? null : lot.estimatedBottles,
          },
          actual: { minted: collection.minted },
        },
      );
      if (!closed) continue;
      const bottles = lot.discardedAt !== null ? 0 : lot._count.bottleUnits;
      const alive = collection.minted - collection._count.tokens;
      await this.verdict(ctx, alive <= bottles, {
        code: 'BOTTLES_SHORTFALL',
        level: 'WARNING',
        ...subject,
        wineryId: collection.wineryId,
        message: `Quedan ${alive} NFT vivos y el lote tiene ${bottles} botellas: revisa el cierre con faltante`,
        expected: { bottles },
        actual: {
          minted: collection.minted,
          burned: collection._count.tokens,
          alive,
        },
      });
    }
  }

  private async openExtensions(subject: {
    type: string;
    id: string;
  }): Promise<number> {
    return this.prisma.chainTransaction.count({
      where: {
        network: this.settings.network,
        kind: 'EXTEND_TTL',
        subjectType: subject.type,
        subjectId: subject.id,
        status: { in: [...OPEN_TX_STATUSES] },
      },
    });
  }

  private expiring(reading: TtlReading) {
    return this.ttl.below(reading, TTL_ALERT_BELOW_DAYS).map((entry) => ({
      entry: entry.name,
      daysLeft:
        entry.daysLeft === null ? null : Math.round(entry.daysLeft * 10) / 10,
      archived: entry.archived,
    }));
  }

  /** `TTL_EXPIRING`: entradas con menos de 14 días y sin extensión en curso. */
  private async checkContractTtl(
    ctx: RunContext,
    contractId: string,
    wineryId: string,
  ): Promise<void> {
    const due = this.expiring(await this.ttl.readContract(contractId));
    const extending =
      due.length > 0 &&
      (await this.openExtensions({ type: 'CONTRACT', id: contractId })) > 0;
    await this.verdict(ctx, due.length === 0 || extending, {
      code: 'TTL_EXPIRING',
      level: 'WARNING',
      subjectType: 'CONTRACT',
      subjectId: contractId,
      wineryId,
      message: `${due.length} entrada(s) del contrato tienen menos de ${TTL_ALERT_BELOW_DAYS} días de vida y no hay ninguna extensión en curso`,
      expected: { minDays: TTL_ALERT_BELOW_DAYS },
      actual: { entries: due.slice(0, MAX_DETAILS), total: due.length },
    });
  }

  private async checkCodeTtl(ctx: RunContext): Promise<void> {
    const { wasmHash } = this.settings;
    if (!wasmHash) return;
    const reading = await this.ttl.readCode();
    if (!reading) return;
    const due = this.expiring(reading);
    const extending =
      due.length > 0 &&
      (await this.openExtensions({ type: 'PLATFORM', id: 'CODE' })) > 0;
    await this.verdict(ctx, due.length === 0 || extending, {
      code: 'TTL_EXPIRING',
      level: 'WARNING',
      subjectType: 'CODE',
      subjectId: wasmHash,
      message: `Al código del contrato NFT le quedan menos de ${TTL_ALERT_BELOW_DAYS} días de vida y no hay ninguna extensión en curso`,
      expected: { minDays: TTL_ALERT_BELOW_DAYS },
      actual: { entries: due },
    });
  }

  // ── Anclajes, transacciones y saldos ─────────────────────────────────────

  /** `ANCHOR_MISMATCH`: el memo guardado es la huella del expediente (y el de la red, si sigue). */
  private async checkAnchors(
    ctx: RunContext,
    onlyCollectionId: string | null,
  ): Promise<void> {
    if (ctx.run.scope === 'CONTRACT') return;
    let lotId: string | undefined;
    if (onlyCollectionId) {
      const collection = await this.prisma.collection.findUnique({
        where: { id: onlyCollectionId },
        select: { lotId: true },
      });
      if (!collection) return;
      lotId = collection.lotId;
    }
    const anchors = await this.prisma.dossierAnchor.findMany({
      where: {
        network: this.settings.network,
        status: 'ANCHORED',
        ...(lotId ? { lotId } : {}),
      },
      include: {
        dossier: {
          select: { hash: true, lot: { select: { wineryId: true } } },
        },
      },
      orderBy: { anchoredAt: 'asc' },
    });
    for (const anchor of anchors) {
      const hash = anchor.dossier.hash;
      let networkMemo: string | null | undefined;
      let networkSource: string | null | undefined;
      if (ctx.depth === 'FULL' && anchor.txHash) {
        const lookup = await this.gateway.getTransaction(anchor.txHash);
        // Fuera de la retención del RPC (≈ 7 días): vale la verificación de entonces
        if (lookup.status === 'SUCCESS') {
          networkMemo = lookup.memoHashHex;
          networkSource = lookup.sourceAccount;
        }
      }
      const ok =
        hash === anchor.memoHashHex &&
        (networkMemo === undefined || networkMemo === hash) &&
        (networkSource === undefined || networkSource === anchor.account);
      await this.verdict(ctx, ok, {
        code: 'ANCHOR_MISMATCH',
        level: 'CRITICAL',
        subjectType: 'LOT',
        subjectId: anchor.lotId,
        wineryId: anchor.dossier.lot.wineryId,
        message: 'El memo del anclaje no es la huella del expediente del lote',
        expected: { dossierHash: hash, account: anchor.account },
        actual: {
          storedMemoHashHex: anchor.memoHashHex,
          networkMemoHashHex: networkMemo ?? null,
          networkSourceAccount: networkSource ?? null,
          txHash: anchor.txHash,
        },
      });
    }
  }

  /** `TX_STUCK` y cierre de las alertas de transacciones que ya terminaron. */
  private async checkTransactions(ctx: RunContext): Promise<void> {
    const { network } = this.settings;
    const stuckBefore = new Date(Date.now() - TX_STUCK_MINUTES * 60_000);
    const stuck = await this.prisma.chainTransaction.findMany({
      where: {
        network,
        status: { in: ['SUBMITTED', 'RETRYING'] },
        updatedAt: { lt: stuckBefore },
      },
      select: {
        id: true,
        kind: true,
        status: true,
        wineryId: true,
        updatedAt: true,
      },
    });
    for (const tx of stuck) {
      await this.verdict(ctx, false, {
        code: 'TX_STUCK',
        level: 'WARNING',
        subjectType: 'TRANSACTION',
        subjectId: tx.id,
        wineryId: tx.wineryId,
        message: `${tx.kind} lleva más de ${TX_STUCK_MINUTES} minutos en ${tx.status}`,
        expected: { maxMinutes: TX_STUCK_MINUTES },
        actual: { status: tx.status, since: tx.updatedAt.toISOString() },
      });
    }
    // Lo que ya no está atascado o acabó confirmándose cierra su alerta
    const open = await this.prisma.chainAlert.findMany({
      where: {
        resolvedAt: null,
        subjectType: 'TRANSACTION',
        code: { in: TX_ALERT_CODES },
      },
      select: { id: true, code: true, subjectId: true },
    });
    if (open.length === 0) return;
    const txs = await this.prisma.chainTransaction.findMany({
      where: { id: { in: open.map((alert) => alert.subjectId) } },
      select: { id: true, status: true, updatedAt: true },
    });
    const byId = new Map(txs.map((tx) => [tx.id, tx]));
    for (const alert of open) {
      const tx = byId.get(alert.subjectId);
      if (!tx) continue;
      const stillStuck =
        (tx.status === 'SUBMITTED' || tx.status === 'RETRYING') &&
        tx.updatedAt < stuckBefore;
      const gone =
        alert.code === 'TX_STUCK' ? !stillStuck : tx.status === 'CONFIRMED';
      if (!gone) continue;
      ctx.checks += 1;
      ctx.autoResolved += await this.prisma.$transaction((db) =>
        this.alerts.resolveAuto(
          db,
          { code: alert.code, subjectType: 'TRANSACTION', subjectId: tx.id },
          alert.code === 'TX_STUCK'
            ? 'La transacción ya no está atascada'
            : 'La transacción acabó confirmándose',
        ),
      );
    }
  }

  /** `LOW_BALANCE`: la abre y la cierra `chain.balance.check`; aquí se repite. */
  private async checkBalances(ctx: RunContext): Promise<void> {
    for (const balance of await this.accounts.checkBalances()) {
      ctx.checks += 1;
      if (balance.status !== 'OK') ctx.differences += 1;
    }
  }
}
