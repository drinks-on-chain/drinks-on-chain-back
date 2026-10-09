import { Inject, Injectable, Logger } from '@nestjs/common';
import { ChainTransaction, Prisma } from '@prisma/client';
import {
  Account,
  Address,
  BASE_FEE,
  Operation,
  Transaction,
  TransactionBuilder,
  authorizeEntry,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';
import { PrismaService } from '@shared/prisma/prisma.service';
import {
  CHAIN_DEFAULTS,
  CHAIN_SETTINGS,
  type ChainSettings,
} from '../../chain.config';
import {
  CUSTODY_REF_ANCHOR,
  CUSTODY_REF_OPERATIONS,
  RESERVED_CHAIN_TX_KINDS,
  type ChainTxKind,
  type ChainTxStatus,
} from '../../chain.constants';
import {
  CustodyError,
  KEY_CUSTODY,
  type KeyCustody,
} from '../../custody/key-custody';
import {
  ChainTxFailure,
  IntentOnHold,
  IntentRejected,
  failureFromDiagnostics,
} from '../../tx/chain-tx.errors';
import {
  IN_FLIGHT_STATUSES,
  OPEN_TX_STATUSES,
  canRebuildAfterNotFound,
} from '../../tx/chain-tx.state';
import { ChainJobsQueue } from '../chain-jobs.queue';
import { ChainTxLifecycle } from '../chain-tx-lifecycle.service';
import { CHAIN_GATEWAY, type ChainGateway } from '../gateway/chain-gateway';
import type {
  ConfirmedLookup,
  IntentEnv,
  IntentHandler,
  PreparedIntent,
  SignerSpec,
} from './intent-handler';

export type ProcessOutcome =
  | 'SUBMITTED'
  | 'CONFIRMED'
  | 'RETRYING'
  | 'FAILED'
  /** Espera a una condición (`CHN_MINT_DISABLED`). */
  | 'HELD'
  /** Otra transacción ocupa la secuencia de su cuenta de origen. */
  | 'BUSY'
  /** Aún no toca su siguiente intento, o la red todavía no responde. */
  | 'WAITING'
  /** No está en un estado que se pueda tomar (ya resuelta, abandonada…). */
  | 'SKIPPED'
  | 'DISABLED';

/** Comisión de inclusión por operación de una transacción clásica (stroops). */
const CLASSIC_FEE_PER_OPERATION = 1_000;
/** Caducidad de una entrada de autorización firmada: ≈ 8 min (S-3). */
const AUTH_VALID_LEDGERS = 100;
/** Primer sondeo tras enviar (los ledgers cierran cada ≈ 5 s; 1 s en local). */
const FIRST_POLL_DELAY_MS = 1_500;
const NEXT_POLL_DELAY_MS = 2_000;
/** Espera para volver a consultar un intento anterior que aún puede entrar. */
const PREVIOUS_ATTEMPT_WAIT_MS = 2_000;
const PREVIOUS_ATTEMPT_RETRY_MS = 5_000;
/** Transacciones en espera que se despiertan al liberarse una cuenta. */
const KICK_BATCH = 5;
const TX_OPTIONS = { timeout: 20_000, maxWait: 10_000 } as const;

const SOURCE_REFS = {
  OPERATIONS: CUSTODY_REF_OPERATIONS,
  ANCHOR: CUSTODY_REF_ANCHOR,
} as const;

interface Claim {
  row: ChainTransaction;
  plan: unknown;
  handler: IntentHandler;
  env: IntentEnv;
  source: SignerSpec | null;
}

/** Fallo cuyo resultado en la red no se conoce (pudo llegar a enviarse). */
class UnknownOutcome extends Error {
  constructor(readonly failure: ChainTxFailure) {
    super(failure.message);
  }
}

class Skip extends Error {
  constructor(readonly outcome: ProcessOutcome) {
    super(outcome);
  }
}

/**
 * Firmante del worker (contrato O3 §2.2, CHN-04). **Solo acepta el id de una
 * intención registrada en la base**: no existe ninguna función que reciba una
 * transacción ya construida ni un XDR. Para cada intención:
 *
 * 1. la toma con la fila bloqueada, comprueba que ninguna otra transacción
 *    ocupa la secuencia de su cuenta de origen y la valida contra la base
 *    (`CHN_INTENT_REJECTED` si no cuadra: nunca se firma);
 * 2. si un intento anterior pudo llegar a la red, consulta su hash antes de
 *    reconstruirla (idempotencia en la red);
 * 3. construye la transacción él mismo, la simula, fija la comisión y
 *    `maxTime`, firma por separado las entradas de autorización (cuenta de la
 *    bodega) y el sobre (cuenta de operaciones) con el custodio, y la envía.
 *
 * Es el único que llama a `KeyCustody.sign`. Sus logs llevan identificadores
 * y hashes; nunca claves, semillas ni XDR firmado.
 */
@Injectable()
export class ChainSigner {
  private readonly logger = new Logger(ChainSigner.name);
  private networkChecked = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: ChainTxLifecycle,
    private readonly jobs: ChainJobsQueue,
    @Inject(KEY_CUSTODY) private readonly custody: KeyCustody,
    @Inject(CHAIN_GATEWAY) private readonly gateway: ChainGateway,
    @Inject(CHAIN_SETTINGS) private readonly settings: ChainSettings,
  ) {}

  /** Entorno de los manejadores: sin acceso a la firma. */
  async env(): Promise<IntentEnv> {
    return {
      settings: this.settings,
      gateway: this.gateway,
      keys: {
        publicKey: (ref) => this.custody.publicKey(ref),
        ensureKey: (ref) => this.custody.ensureKey(ref),
      },
      operationsAddress: await this.custody.publicKey(CUSTODY_REF_OPERATIONS),
    };
  }

  /** Toma, valida, firma y envía la intención `transactionId`. */
  async process(transactionId: string): Promise<ProcessOutcome> {
    if (!this.settings.enabled) return 'DISABLED';
    const previous = await this.resolvePrevious(transactionId);
    if (previous) {
      await this.after(transactionId, previous);
      return previous;
    }
    let claim: Claim;
    try {
      claim = await this.claim(transactionId);
    } catch (error) {
      if (error instanceof Skip) return error.outcome;
      if (error instanceof IntentOnHold) {
        await this.hold(transactionId, error);
        return 'HELD';
      }
      // Un fallo de la base al tomarla no es de la intención: lo reintenta
      // la cola (o el barrido), sin tocar su estado
      if (!(error instanceof ChainTxFailure || error instanceof CustodyError)) {
        throw error;
      }
      const result = await this.lifecycle.fail(
        transactionId,
        this.asFailure(error),
        { from: ['PENDING', 'RETRYING'] },
      );
      const outcome = result === 'IGNORED' ? 'SKIPPED' : result;
      await this.after(transactionId, outcome);
      return outcome;
    }

    let outcome: ProcessOutcome;
    try {
      outcome = await this.execute(claim);
    } catch (error) {
      const unknown = error instanceof UnknownOutcome;
      const failure = unknown ? error.failure : this.asFailure(error);
      const result = await this.lifecycle.fail(transactionId, failure, {
        unknownOutcome: unknown,
        from: ['BUILDING'],
      });
      outcome = result === 'IGNORED' ? 'SKIPPED' : result;
    }
    await this.after(transactionId, outcome);
    return outcome;
  }

  /** Consulta en la red una transacción `SUBMITTED` y la resuelve. */
  async poll(transactionId: string): Promise<ProcessOutcome> {
    if (!this.settings.enabled) return 'DISABLED';
    const row = await this.prisma.chainTransaction.findUnique({
      where: { id: transactionId },
    });
    if (!row || row.status !== 'SUBMITTED' || !row.txHash) return 'SKIPPED';
    const handler = this.lifecycle.handlerOf(row.kind);
    if (!handler) return 'SKIPPED';

    let outcome: ProcessOutcome;
    try {
      const lookup = await this.gateway.getTransaction(row.txHash);
      if (lookup.status === 'NOT_FOUND') {
        if (!canRebuildAfterNotFound(row.maxTime)) {
          await this.jobs.confirm(transactionId, NEXT_POLL_DELAY_MS);
          return 'WAITING';
        }
        // Caducó sin entrar: ya no puede hacerlo, se reconstruye
        outcome = await this.failed(
          transactionId,
          new ChainTxFailure('CHN_TX_TIMEOUT', 'NOT_FOUND tras maxTime'),
        );
      } else if (lookup.status === 'FAILED') {
        await this.prisma.chainTransaction.update({
          where: { id: transactionId },
          data: {
            ledger: lookup.ledger,
            feeChargedStroops: lookup.feeChargedStroops,
          },
        });
        outcome = await this.failed(transactionId, lookup.failure);
      } else {
        outcome = await this.finish(row, handler, lookup, ['SUBMITTED']);
      }
    } catch (error) {
      // La red no responde: sigue `SUBMITTED`; el barrido vuelve a consultarla
      this.logger.warn(
        `Sondeo de ${row.kind} ${transactionId} aplazado: ${this.asFailure(error).code}`,
      );
      return 'WAITING';
    }
    await this.after(transactionId, outcome);
    return outcome;
  }

  // ── Idempotencia en la red (§2.3, nivel 3) ───────────────────────────────

  /**
   * Un intento anterior pudo llegar a la red sin que se supiera el resultado.
   * Antes de reconstruir la transacción se consulta su hash: si entró, se
   * resuelve con ese resultado; si no aparece, solo se reconstruye cuando su
   * `maxTime` ya pasó (la anterior ya no puede entrar). Mientras tanto espera
   * sin gastar intentos. `null` = se puede tomar y construir de nuevo.
   */
  private async resolvePrevious(id: string): Promise<ProcessOutcome | null> {
    const row = await this.prisma.chainTransaction.findUnique({
      where: { id },
    });
    if (!row || row.status !== 'RETRYING' || !row.txHash || !row.maxTime) {
      return null;
    }
    if (row.nextAttemptAt && row.nextAttemptAt.getTime() > Date.now()) {
      return 'WAITING';
    }
    const handler = this.lifecycle.handlerOf(row.kind);
    if (!handler) return null;
    try {
      const lookup = await this.gateway.getTransaction(row.txHash);
      if (lookup.status === 'SUCCESS') {
        return await this.finish(row, handler, lookup, ['RETRYING']);
      }
      if (lookup.status === 'FAILED') {
        if (!lookup.failure.retryable) {
          const result = await this.lifecycle.fail(id, lookup.failure, {
            from: ['RETRYING'],
          });
          return result === 'IGNORED' ? 'SKIPPED' : result;
        }
        // Entró y falló por algo pasajero: su secuencia se gastó, se rehace
        await this.forgetPrevious(id);
        return null;
      }
      if (canRebuildAfterNotFound(row.maxTime)) {
        await this.forgetPrevious(id);
        return null;
      }
      return await this.postpone(id, PREVIOUS_ATTEMPT_WAIT_MS);
    } catch {
      // La red no responde: no se sabe nada nuevo; se vuelve a preguntar
      return this.postpone(id, PREVIOUS_ATTEMPT_RETRY_MS);
    }
  }

  private async forgetPrevious(id: string): Promise<void> {
    await this.prisma.chainTransaction.updateMany({
      where: { id, status: 'RETRYING' },
      data: { maxTime: null },
    });
  }

  private async postpone(id: string, delayMs: number): Promise<ProcessOutcome> {
    await this.prisma.chainTransaction.updateMany({
      where: { id, status: 'RETRYING' },
      data: { nextAttemptAt: new Date(Date.now() + delayMs) },
    });
    await this.jobs.process(id, delayMs + 100);
    return 'WAITING';
  }

  // ── Toma y validación (§2.2) ─────────────────────────────────────────────

  private async claim(id: string): Promise<Claim> {
    return this.prisma.$transaction(async (db) => {
      const row = await this.lifecycle.lock(db, id);
      if (
        !row ||
        row.abandonedAt !== null ||
        (row.status !== 'PENDING' && row.status !== 'RETRYING')
      ) {
        throw new Skip('SKIPPED');
      }
      if (
        row.status === 'RETRYING' &&
        row.nextAttemptAt &&
        row.nextAttemptAt.getTime() > Date.now()
      ) {
        throw new Skip('WAITING');
      }
      if (this.settings.network === 'PUBLIC') {
        throw new IntentRejected('la red pública no está habilitada');
      }
      if (row.network !== this.settings.network) {
        throw new IntentRejected(
          `la intención es de la red ${row.network} y el firmante está en ${this.settings.network}`,
        );
      }
      const handler = this.lifecycle.handlerOf(row.kind);
      if (
        !handler ||
        RESERVED_CHAIN_TX_KINDS.includes(row.kind as ChainTxKind)
      ) {
        throw new IntentRejected(`tipo de intención no admitido: ${row.kind}`);
      }
      const env = await this.env();
      const source = handler.source
        ? await this.sourceSpec(handler.source)
        : null;
      if (source) {
        // Una transacción en vuelo por cuenta de origen (secuencia, S-5)
        await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`chain-source:${row.network}:${source.address}`}))`;
        const inFlight = await db.chainTransaction.count({
          where: {
            id: { not: id },
            network: row.network,
            sourceAccount: source.address,
            status: { in: [...IN_FLIGHT_STATUSES] },
          },
        });
        if (inFlight > 0) throw new Skip('BUSY');
        // Friendbot en curso para esa cuenta: aún no existe o no tiene saldo
        const funding = await db.chainTransaction.count({
          where: {
            network: row.network,
            kind: 'FUND_ACCOUNT',
            subjectType: 'PLATFORM',
            subjectId: source.role,
            status: { in: [...OPEN_TX_STATUSES] },
          },
        });
        if (funding > 0) throw new Skip('BUSY');
      }
      // Lanza IntentRejected o IntentOnHold: se deshace todo lo de aquí
      const plan = await handler.validate(db, row, env);
      const claimed = await db.chainTransaction.update({
        where: { id },
        data: {
          status: 'BUILDING',
          attempts: { increment: 1 },
          sourceAccount: source?.address ?? null,
          nextAttemptAt: null,
        },
      });
      await this.lifecycle.note(db, claimed, 'BUILDING', {
        txHash: claimed.txHash,
      });
      return { row: claimed, plan, handler, env, source };
    }, TX_OPTIONS);
  }

  private async sourceSpec(role: 'OPERATIONS' | 'ANCHOR'): Promise<SignerSpec> {
    const ref = SOURCE_REFS[role];
    return {
      role,
      ref,
      address: await this.custody.publicKey(ref),
      wineryId: null,
    };
  }

  private async hold(id: string, hold: IntentOnHold): Promise<void> {
    await this.prisma.chainTransaction.updateMany({
      where: { id, status: 'PENDING' },
      data: {
        lastError: {
          code: hold.code,
          message: hold.message,
          retryable: false,
        },
      },
    });
  }

  // ── Construcción, firma y envío ──────────────────────────────────────────

  private async execute(claim: Claim): Promise<ProcessOutcome> {
    const { row, plan, handler, env, source } = claim;
    await this.assertNetwork();

    const prepared = await handler.prepare(plan, row, env);
    if (prepared.type === 'ALREADY_DONE') {
      return this.finish(row, handler, null, ['BUILDING'], prepared.note);
    }
    if (prepared.type === 'FRIENDBOT') {
      const { txHash } = await this.gateway.fund(prepared.address);
      if (txHash) {
        await this.prisma.chainTransaction.update({
          where: { id: row.id },
          data: { txHash },
        });
      }
      return this.finish(row, handler, null, ['BUILDING'], 'Friendbot');
    }
    if (!source) {
      throw new IntentRejected(`${row.kind} no declara cuenta de origen`);
    }

    const { tx, signers } = await this.build(prepared, source);
    const txHash = Buffer.from(tx.hash()).toString('hex');
    const maxTime = new Date(Number(tx.timeBounds?.maxTime ?? 0) * 1000);
    // Antes de enviar: si el proceso muere ahora, el hash permite saber si entró
    await this.prisma.chainTransaction.update({
      where: { id: row.id },
      data: {
        txHash,
        maxTime,
        maxFeeStroops: BigInt(tx.fee),
        signers: signers.map(({ role, address, wineryId }) => ({
          role,
          address,
          wineryId,
        })),
      },
    });

    const sent = await this.gateway.send(tx);
    if (!sent.accepted) {
      if (sent.rejected) throw sent.failure;
      throw new UnknownOutcome(sent.failure);
    }
    const submitted = await this.prisma.$transaction(async (db) => {
      const current = await this.lifecycle.lock(db, row.id);
      if (!current || current.status !== 'BUILDING') return false;
      await db.chainTransaction.update({
        where: { id: row.id },
        data: { status: 'SUBMITTED' satisfies ChainTxStatus },
      });
      await this.lifecycle.note(db, current, 'SUBMITTED', {
        txHash,
        sequence: tx.sequence,
      });
      return true;
    }, TX_OPTIONS);
    if (!submitted) return 'SKIPPED';
    this.logger.log({
      message: `Transacción ${row.kind} enviada`,
      transactionId: row.id,
      kind: row.kind,
      txHash,
      attempt: row.attempts,
    });
    await this.jobs.confirm(row.id, FIRST_POLL_DELAY_MS);
    return 'SUBMITTED';
  }

  private async build(
    prepared: Extract<PreparedIntent, { type: 'CLASSIC' | 'SOROBAN' }>,
    source: SignerSpec,
  ): Promise<{ tx: Transaction; signers: SignerSpec[] }> {
    const account = await this.gateway.loadAccount(source.address);
    if (!account) {
      throw new ChainTxFailure(
        'CHN_INSUFFICIENT_BALANCE',
        `la cuenta de ${source.role} no existe en la red`,
      );
    }
    const sequence = account.sequenceNumber();
    const maxTime =
      Math.floor(Date.now() / 1000) + CHAIN_DEFAULTS.txTimeoutSeconds;
    const builder = (fee: string) =>
      new TransactionBuilder(new Account(source.address, sequence), {
        fee,
        networkPassphrase: this.settings.networkPassphrase,
        timebounds: { minTime: 0, maxTime },
      });

    let tx: Transaction;
    let signers: SignerSpec[];
    let cap = BigInt(this.settings.txMaxFeeStroops);
    if (prepared.type === 'CLASSIC') {
      const draft = builder(String(CLASSIC_FEE_PER_OPERATION));
      prepared.operations.forEach((operation) => draft.addOperation(operation));
      tx = draft.build();
      signers = [source, ...prepared.extraSigners];
    } else {
      if (prepared.maxFeeStroops) cap = BigInt(prepared.maxFeeStroops);
      const assembled = await this.assemble(prepared, builder);
      tx = assembled.tx;
      signers = [source, ...assembled.authorizedBy];
    }
    if (BigInt(tx.fee) > cap) {
      throw new ChainTxFailure(
        'CHN_INSUFFICIENT_FEE',
        `la comisión ${tx.fee} supera el tope ${cap.toString()}`,
      );
    }

    // Firma del sobre: el hash de la transacción que se acaba de construir
    const envelopeSigners = prepared.type === 'CLASSIC' ? signers : [source];
    const hash = tx.hash();
    for (const signer of envelopeSigners) {
      const signature = await this.sign(signer.ref, hash);
      try {
        tx.addSignature(
          signer.address,
          Buffer.from(signature).toString('base64'),
        );
      } catch {
        throw new ChainTxFailure(
          'CHN_AUTH_FAILED',
          `la firma de ${signer.role} no corresponde a su cuenta`,
        );
      }
    }
    return { tx, signers };
  }

  /**
   * Soroban con firma separada (S-3): simulación de registro → cada entrada
   * de autorización con credenciales de dirección la firma su cuenta
   * custodiada (`authorizeEntry` con el *payload* de 32 bytes) → segunda
   * simulación, ya estricta → `assembleTransaction`. Sin fee-bump.
   */
  private async assemble(
    prepared: Extract<PreparedIntent, { type: 'SOROBAN' }>,
    builder: (fee: string) => TransactionBuilder,
  ): Promise<{ tx: Transaction; authorizedBy: SignerSpec[] }> {
    const draft = builder(BASE_FEE).addOperation(prepared.operation).build();
    const recorded = this.assertSimulated(await this.gateway.simulate(draft));
    const entries = recorded.result?.auth ?? [];
    const allowed = new Map(prepared.authSigners.map((s) => [s.address, s]));
    const authorizedBy: SignerSpec[] = [];
    const signed: xdr.SorobanAuthorizationEntry[] = [];
    const validUntil = recorded.latestLedger + AUTH_VALID_LEDGERS;

    for (const entry of entries) {
      const credentials = entry.credentials as unknown as {
        type: string;
        value: { address: xdr.ScAddress };
      };
      if (credentials.type === 'sorobanCredentialsSourceAccount') {
        signed.push(entry); // basta la firma del sobre
        continue;
      }
      const address = Address.fromScAddress(
        credentials.value.address,
      ).toString();
      const signer = allowed.get(address);
      if (!signer) {
        // Nunca se firma por una dirección que la intención no previó
        throw new ChainTxFailure(
          'CHN_AUTH_FAILED',
          `la operación pide la autorización de una cuenta no prevista (${address.slice(0, 6)}…)`,
        );
      }
      try {
        signed.push(
          await authorizeEntry(
            entry,
            async (_preimage: unknown, payload: Uint8Array) => ({
              signature: Buffer.from(await this.sign(signer.ref, payload)),
              publicKey: signer.address,
            }),
            validUntil,
            this.settings.networkPassphrase,
          ),
        );
      } catch (error) {
        if (error instanceof ChainTxFailure) throw error;
        throw new ChainTxFailure(
          'CHN_AUTH_FAILED',
          `la firma de la autorización de ${signer.role} no es válida`,
        );
      }
      authorizedBy.push(signer);
    }

    if (authorizedBy.length === 0) {
      return {
        tx: rpc.assembleTransaction(draft, recorded).build(),
        authorizedBy,
      };
    }
    const func = (draft.operations[0] as unknown as { func: xdr.HostFunction })
      .func;
    const withAuth = builder(BASE_FEE)
      .addOperation(Operation.invokeHostFunction({ func, auth: signed }))
      .build();
    const strict = this.assertSimulated(await this.gateway.simulate(withAuth));
    return {
      tx: rpc.assembleTransaction(withAuth, strict).build(),
      authorizedBy,
    };
  }

  private assertSimulated(
    simulation: rpc.Api.SimulateTransactionResponse,
  ): rpc.Api.SimulateTransactionSuccessResponse {
    if (rpc.Api.isSimulationError(simulation)) {
      throw failureFromDiagnostics(simulation.error);
    }
    if (rpc.Api.isSimulationRestore(simulation)) {
      throw new ChainTxFailure(
        'CHN_ARCHIVED_ENTRY',
        'la simulación pide restaurar entradas archivadas',
      );
    }
    return simulation;
  }

  /** Única llamada a `KeyCustody.sign` de todo el backend. */
  private async sign(ref: string, payload: Uint8Array): Promise<Uint8Array> {
    try {
      return await this.custody.sign(ref, payload);
    } catch (error) {
      throw new ChainTxFailure(
        'CHN_AUTH_FAILED',
        error instanceof CustodyError ? error.code : 'CUSTODY_ERROR',
        'El custodio no pudo firmar',
      );
    }
  }

  /** El RPC debe ser de la red configurada: nunca se firma para otra. */
  private async assertNetwork(): Promise<void> {
    if (this.networkChecked) return;
    const passphrase = await this.gateway.networkPassphrase();
    if (passphrase !== this.settings.networkPassphrase) {
      throw new IntentRejected(
        'el RPC anuncia una red distinta de la configurada (STELLAR_NETWORK)',
      );
    }
    this.networkChecked = true;
  }

  // ── Resolución ───────────────────────────────────────────────────────────

  private async finish(
    row: ChainTransaction,
    handler: IntentHandler,
    lookup: ConfirmedLookup | null,
    from: ChainTxStatus[],
    note: string | null = null,
  ): Promise<ProcessOutcome> {
    const env = await this.env();
    // Lectura de vuelta en la red, fuera de la transacción de base de datos
    const verification = handler.verify
      ? await this.unknown(() => handler.verify!(row, env))
      : undefined;
    const confirmed = await this.lifecycle.confirm(
      row.id,
      from,
      lookup,
      verification,
      env,
      note,
    );
    if (!confirmed) return 'SKIPPED';
    this.logger.log({
      message: `Transacción ${row.kind} confirmada`,
      transactionId: row.id,
      kind: row.kind,
      txHash: row.txHash,
      ledger: lookup?.ledger ?? null,
      feeChargedStroops: lookup?.feeChargedStroops.toString() ?? null,
    });
    return 'CONFIRMED';
  }

  private async failed(
    id: string,
    failure: ChainTxFailure,
  ): Promise<ProcessOutcome> {
    const result = await this.lifecycle.fail(id, failure, {
      from: ['SUBMITTED'],
    });
    return result === 'IGNORED' ? 'SKIPPED' : result;
  }

  /** Un fallo de red aquí no dice si la transacción entró: se conserva su hash. */
  private async unknown<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      const failure = this.asFailure(error);
      if (failure.retryable) throw new UnknownOutcome(failure);
      throw failure;
    }
  }

  private asFailure(error: unknown): ChainTxFailure {
    if (error instanceof UnknownOutcome) return error.failure;
    if (error instanceof ChainTxFailure) return error;
    if (error instanceof CustodyError) {
      return new ChainTxFailure(
        'CHN_AUTH_FAILED',
        error.code,
        'El custodio no tiene la clave que pide la intención',
      );
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      return new ChainTxFailure('CHN_RPC_UNAVAILABLE', `base ${error.code}`);
    }
    const name = error instanceof Error ? error.name : 'Error';
    this.logger.error(
      `Error inesperado del firmante (${name}): ${error instanceof Error ? error.message.slice(0, 300) : ''}`,
    );
    return new ChainTxFailure('CHN_RPC_UNAVAILABLE', `inesperado: ${name}`);
  }

  /** Tras resolver una transacción: su reintento y las que esperaban turno. */
  private async after(id: string, outcome: ProcessOutcome): Promise<void> {
    if (
      outcome === 'SUBMITTED' ||
      outcome === 'SKIPPED' ||
      outcome === 'WAITING'
    ) {
      return;
    }
    if (outcome === 'RETRYING') {
      const row = await this.prisma.chainTransaction.findUnique({
        where: { id },
        select: { nextAttemptAt: true },
      });
      const delay = Math.max(
        0,
        (row?.nextAttemptAt?.getTime() ?? Date.now()) - Date.now(),
      );
      await this.jobs.process(id, delay + 200);
    }
    await this.kick(id);
  }

  /** Despierta las transacciones más antiguas que esperaban una cuenta libre. */
  async kick(exceptId?: string): Promise<void> {
    const waiting = await this.prisma.chainTransaction.findMany({
      where: {
        ...(exceptId ? { id: { not: exceptId } } : {}),
        abandonedAt: null,
        OR: [
          { status: 'PENDING', lastError: { equals: Prisma.DbNull } },
          { status: 'RETRYING', nextAttemptAt: { lte: new Date() } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: KICK_BATCH,
      select: { id: true },
    });
    for (const { id } of waiting) await this.jobs.process(id);
  }
}
