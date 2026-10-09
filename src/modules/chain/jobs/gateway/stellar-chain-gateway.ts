import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Transaction,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import type { ChainSettings } from '../../chain.config';
import { FRIENDBOT_NETWORKS } from '../../chain.constants';
import {
  ChainTxFailure,
  failureFromDiagnostics,
  failureFromTxResultCode,
} from '../../tx/chain-tx.errors';
import type { ChainGateway, SendOutcome, TxLookup } from './chain-gateway';

/** Reenvíos de la **misma** transacción ante `-32603` o `TRY_AGAIN_LATER`. */
const SEND_ATTEMPTS = 5;
const SEND_RETRY_WAIT_MS = 1_000;
/** Intentos de una lectura ante un corte de transporte. */
const READ_ATTEMPTS = 2;
const READ_RETRY_WAIT_MS = 300;
const FRIENDBOT_TIMEOUT_MS = 30_000;
const RPC_TIMEOUT_MS = 20_000;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Nombre y mensaje acotado de un error de transporte (sin cuerpos ni XDR). */
function transportDetail(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`.slice(0, 200);
  }
  if (typeof error === 'object' && error !== null) {
    const { code, message } = error as { code?: unknown; message?: unknown };
    return `rpc ${String(code ?? '')}: ${String(message ?? '')}`.slice(0, 200);
  }
  return String(error).slice(0, 200);
}

const unavailable = (error: unknown): ChainTxFailure =>
  error instanceof ChainTxFailure
    ? error
    : new ChainTxFailure('CHN_RPC_UNAVAILABLE', transportDetail(error));

/** Valor de un contrato en JSON: `bigint` como texto y bytes en hexadecimal. */
export function toJsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value instanceof Map) {
    return Object.fromEntries(
      [...value.entries()].map(([k, v]) => [String(k), toJsonSafe(v)]),
    );
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, toJsonSafe(v)]),
    );
  }
  return value === undefined ? null : value;
}

function xdrText(value: unknown): string {
  try {
    const json = (value as { toJSON?: () => unknown }).toJSON?.();
    return JSON.stringify(json ?? null, (_k, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
  } catch {
    return '';
  }
}

/**
 * `ChainGateway` sobre `@stellar/stellar-sdk` 17 (protocolo 29). No recibe ni
 * guarda claves: firma quien la llama.
 */
export class StellarChainGateway implements ChainGateway {
  private readonly server: rpc.Server;

  constructor(private readonly settings: ChainSettings) {
    if (!settings.rpcUrl) {
      throw new Error(
        'STELLAR_RPC_URL es obligatoria con la cadena habilitada',
      );
    }
    this.server = new rpc.Server(settings.rpcUrl, {
      allowHttp: settings.rpcUrl.startsWith('http://'),
      timeout: RPC_TIMEOUT_MS,
    });
  }

  /**
   * Lecturas del RPC (idempotentes): un corte de transporte suelto (conexión
   * reutilizada que el servidor ya cerró) se reintenta una vez antes de darlo
   * por "red no disponible".
   */
  private async call<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await work();
      } catch (error) {
        if (error instanceof ChainTxFailure) throw error;
        if (attempt >= READ_ATTEMPTS) throw unavailable(error);
        await sleep(READ_RETRY_WAIT_MS);
      }
    }
  }

  async networkPassphrase(): Promise<string> {
    return (await this.call(() => this.server.getNetwork())).passphrase;
  }

  async latestLedger(): Promise<number> {
    return (await this.call(() => this.server.getLatestLedger())).sequence;
  }

  private accountKey(address: string): xdr.LedgerKey {
    return xdr.LedgerKey.account(
      new xdr.LedgerKeyAccount({
        accountId: Keypair.fromPublicKey(address).xdrAccountId(),
      }),
    );
  }

  private async accountEntry(
    address: string,
  ): Promise<{ balance: bigint; seqNum: bigint } | null> {
    const response = await this.call(() =>
      this.server.getLedgerEntries(this.accountKey(address)),
    );
    const entry = response.entries[0];
    if (!entry) return null;
    const account = entry.val.value as unknown as {
      balance: bigint;
      seqNum: bigint;
    };
    return {
      balance: BigInt(account.balance),
      seqNum: BigInt(account.seqNum),
    };
  }

  async loadAccount(address: string): Promise<Account | null> {
    const entry = await this.accountEntry(address);
    return entry ? new Account(address, entry.seqNum.toString()) : null;
  }

  async accountBalance(address: string): Promise<bigint | null> {
    return (await this.accountEntry(address))?.balance ?? null;
  }

  async contractExists(contractAddress: string): Promise<boolean> {
    const key = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(contractAddress).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent,
      }),
    );
    const response = await this.call(() => this.server.getLedgerEntries(key));
    return response.entries.length > 0;
  }

  async codeExists(wasmHash: string): Promise<boolean> {
    const key = xdr.LedgerKey.contractCode(
      new xdr.LedgerKeyContractCode({ hash: Buffer.from(wasmHash, 'hex') }),
    );
    const response = await this.call(() => this.server.getLedgerEntries(key));
    return response.entries.length > 0;
  }

  simulate(tx: Transaction): Promise<rpc.Api.SimulateTransactionResponse> {
    return this.call(() => this.server.simulateTransaction(tx));
  }

  async readContract(
    contractAddress: string,
    method: string,
    args: xdr.ScVal[],
    sourceAddress: string,
  ): Promise<unknown> {
    // Una lectura no consume secuencia: basta una cuenta con cualquier número
    const tx = new TransactionBuilder(new Account(sourceAddress, '0'), {
      fee: BASE_FEE,
      networkPassphrase: this.settings.networkPassphrase,
    })
      .addOperation(new Contract(contractAddress).call(method, ...args))
      .setTimeout(30)
      .build();
    const simulation = await this.simulate(tx);
    if (rpc.Api.isSimulationError(simulation)) {
      throw failureFromDiagnostics(simulation.error);
    }
    const value = simulation.result?.retval;
    return value === undefined ? null : toJsonSafe(scValToNative(value));
  }

  async send(tx: Transaction): Promise<SendOutcome> {
    let lastFailure: ChainTxFailure | null = null;
    for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt += 1) {
      try {
        const response = await this.server.sendTransaction(tx);
        if (response.status === 'PENDING' || response.status === 'DUPLICATE') {
          return { accepted: true };
        }
        if (response.status === 'ERROR') {
          const resultCode = String(
            response.errorResult?.result.type ?? 'txInternalError',
          );
          return {
            accepted: false,
            rejected: true,
            failure: failureFromTxResultCode(resultCode),
          };
        }
        lastFailure = new ChainTxFailure(
          'CHN_TRY_AGAIN_LATER',
          'TRY_AGAIN_LATER',
        );
      } catch (error) {
        // `-32603 could not submit transaction to stellar-core` y cortes de
        // red: reenviar la misma transacción es inocuo (mismo hash)
        lastFailure = unavailable(error);
      }
      if (attempt < SEND_ATTEMPTS) await sleep(SEND_RETRY_WAIT_MS);
    }
    return {
      accepted: false,
      rejected: false,
      failure: lastFailure ?? new ChainTxFailure('CHN_RPC_UNAVAILABLE'),
    };
  }

  async getTransaction(txHash: string): Promise<TxLookup> {
    const response = await this.call(() => this.server.getTransaction(txHash));
    if (response.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
      return { status: 'NOT_FOUND' };
    }
    const feeChargedStroops = BigInt(response.resultXdr.feeCharged);
    if (response.status === rpc.Api.GetTransactionStatus.FAILED) {
      const resultCode = String(response.resultXdr.result.type);
      const diagnostics = (response.diagnosticEventsXdr ?? [])
        .map(xdrText)
        .join('\n');
      const failure =
        resultCode === 'txFailed'
          ? failureFromDiagnostics(
              `${xdrText(response.resultXdr)}\n${diagnostics}`,
            )
          : failureFromTxResultCode(resultCode);
      return {
        status: 'FAILED',
        ledger: response.ledger,
        feeChargedStroops,
        failure,
      };
    }
    return {
      status: 'SUCCESS',
      ledger: response.ledger,
      closedAt: new Date(response.createdAt * 1000),
      feeChargedStroops,
      rentFeeStroops: this.rentFee(response.resultMetaXdr),
      returnValue:
        response.returnValue === undefined
          ? null
          : toJsonSafe(scValToNative(response.returnValue)),
      contractEvents: this.eventNames(response.events),
    };
  }

  private rentFee(meta: xdr.TransactionMeta): bigint | null {
    try {
      const soroban = (
        meta.value as unknown as {
          sorobanMeta?: { ext?: { value?: { rentFeeCharged?: bigint } } };
        }
      ).sorobanMeta;
      const rent = soroban?.ext?.value?.rentFeeCharged;
      return rent === undefined ? null : BigInt(rent);
    } catch {
      return null;
    }
  }

  private eventNames(events: rpc.Api.TransactionEvents | undefined): string[] {
    const names: string[] = [];
    for (const operationEvents of events?.contractEventsXdr ?? []) {
      for (const event of operationEvents) {
        try {
          const body = event.body.value as unknown as { topics: xdr.ScVal[] };
          names.push(String(scValToNative(body.topics[0])));
        } catch {
          names.push('?');
        }
      }
    }
    return names;
  }

  async fund(address: string): Promise<{ txHash: string | null }> {
    if (!FRIENDBOT_NETWORKS.includes(this.settings.network)) {
      throw new ChainTxFailure(
        'CHN_INTENT_REJECTED',
        'Friendbot solo existe en TESTNET y LOCAL',
      );
    }
    const base =
      this.settings.friendbotUrl ??
      (await this.call(() => this.server.getNetwork())).friendbotUrl;
    if (!base) {
      throw new ChainTxFailure(
        'CHN_RPC_UNAVAILABLE',
        'El RPC no anuncia ningún Friendbot',
      );
    }
    const url = new URL(base);
    url.searchParams.set('addr', address);
    let response: Response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(FRIENDBOT_TIMEOUT_MS),
      });
    } catch (error) {
      throw unavailable(error);
    }
    const body = (await response.json().catch(() => ({}))) as {
      hash?: unknown;
      detail?: unknown;
    };
    if (!response.ok) {
      const detail = `friendbot ${response.status}: ${String(body.detail ?? '')}`;
      // 5xx: Friendbot aún arrancando o saturado → transitorio
      throw new ChainTxFailure(
        response.status >= 500 ? 'CHN_RPC_UNAVAILABLE' : 'CHN_CONTRACT_ERROR',
        detail.slice(0, 200),
      );
    }
    return {
      txHash:
        typeof body.hash === 'string' && /^[0-9a-f]{64}$/.test(body.hash)
          ? body.hash
          : null,
    };
  }
}

export function createChainGateway(settings: ChainSettings): ChainGateway {
  return settings.enabled
    ? new StellarChainGateway(settings)
    : new DisabledChainGateway();
}

/** Sin cadena configurada: cualquier uso falla como "red no disponible". */
export class DisabledChainGateway implements ChainGateway {
  private fail<T>(): Promise<T> {
    return Promise.reject(
      new ChainTxFailure('CHN_RPC_UNAVAILABLE', 'La cadena está deshabilitada'),
    );
  }
  networkPassphrase = () => this.fail<string>();
  latestLedger = () => this.fail<number>();
  loadAccount = () => this.fail<Account | null>();
  accountBalance = () => this.fail<bigint | null>();
  contractExists = () => this.fail<boolean>();
  codeExists = () => this.fail<boolean>();
  simulate = () => this.fail<rpc.Api.SimulateTransactionResponse>();
  readContract = () => this.fail<unknown>();
  send = () => this.fail<SendOutcome>();
  getTransaction = () => this.fail<TxLookup>();
  fund = () => this.fail<{ txHash: string | null }>();
}
