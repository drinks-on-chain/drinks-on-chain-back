import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  Account,
  BASE_FEE,
  Keypair,
  Operation,
  TransactionBuilder,
  rpc,
} from '@stellar/stellar-sdk';
import type {
  ChainGateway,
  SendOutcome,
  TxLookup,
} from '../../src/modules/chain/jobs/gateway/chain-gateway';
import type { KeyCustody } from '../../src/modules/chain/custody/key-custody';
import { ChainTxFailure } from '../../src/modules/chain/tx/chain-tx.errors';

/**
 * Red local de las pruebas (contrato O3 §14): `stellar/quickstart` en modo
 * `--local` con RPC y Friendbot. La CI la arranca como un paso de Docker y
 * pasa estas variables; sin ellas, las pruebas de la cadena se omiten.
 */
export const LOCAL_CHAIN = {
  rpcUrl: process.env.CHAIN_E2E_RPC_URL ?? '',
  friendbotUrl: process.env.CHAIN_E2E_FRIENDBOT_URL ?? '',
  wasmPath: process.env.CHAIN_E2E_WASM_PATH ?? '',
  passphrase: 'Standalone Network ; February 2017',
};

export const localChainAvailable = (): boolean =>
  LOCAL_CHAIN.rpcUrl !== '' &&
  LOCAL_CHAIN.friendbotUrl !== '' &&
  LOCAL_CHAIN.wasmPath !== '';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** SHA-256 del artefacto `winery_nft.wasm` (el `wasmHash` del contrato). */
export function wasmHashOf(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Sube el código del contrato a la red local con una cuenta de usar y tirar
 * (en testnet ya lo subió la pista SC). Devuelve su hash.
 */
export async function uploadContractCode(): Promise<string> {
  const wasm = readFileSync(LOCAL_CHAIN.wasmPath);
  const wasmHash = createHash('sha256').update(wasm).digest('hex');
  const server = new rpc.Server(LOCAL_CHAIN.rpcUrl, { allowHttp: true });
  const uploader = Keypair.random();
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(
      `${LOCAL_CHAIN.friendbotUrl}?addr=${uploader.publicKey()}`,
    ).catch(() => null);
    if (response?.ok) break;
    if (attempt >= 90) throw new Error('El Friendbot local no responde');
    await sleep(1000);
  }
  // El RPC va un ledger por detrás de Friendbot: espera a ver la cuenta
  let account: Account | null = null;
  for (let attempt = 0; account === null; attempt += 1) {
    account = await server.getAccount(uploader.publicKey()).catch(() => null);
    if (account === null) {
      if (attempt >= 60) throw new Error('La cuenta fondeada no aparece');
      await sleep(500);
    }
  }
  const draft = new TransactionBuilder(
    new Account(uploader.publicKey(), account.sequenceNumber()),
    { fee: BASE_FEE, networkPassphrase: LOCAL_CHAIN.passphrase },
  )
    .addOperation(Operation.uploadContractWasm({ wasm }))
    .setTimeout(120)
    .build();
  const simulation = await server.simulateTransaction(draft);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(`No se pudo simular la subida: ${simulation.error}`);
  }
  const tx = rpc.assembleTransaction(draft, simulation).build();
  tx.sign(uploader);
  const sent = await server.sendTransaction(tx);
  if (sent.status !== 'PENDING' && sent.status !== 'DUPLICATE') {
    throw new Error(`La subida del código no entró: ${sent.status}`);
  }
  for (let i = 0; i < 120; i += 1) {
    const result = await server.getTransaction(sent.hash);
    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) return wasmHash;
    if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new Error('La subida del código falló en la red');
    }
    await sleep(500);
  }
  throw new Error('La subida del código no se confirmó');
}

/**
 * Puerta a la red con fallos provocados (contrato O3 §14: RPC detenido,
 * respuesta perdida a mitad del envío, secuencia en conflicto).
 */
export class FaultyGateway implements ChainGateway {
  /** RPC detenido: toda llamada falla como `CHN_RPC_UNAVAILABLE`. */
  down = false;
  /** El próximo envío llega a la red, pero su respuesta "se pierde". */
  loseNextSendResponse = false;
  /** La próxima cuenta se carga con una secuencia ya gastada. */
  staleSequenceOnce = false;
  /**
   * `getTransaction` responde `NOT_FOUND` (el hash "no aparece") hasta que
   * alguien lee los eventos del contrato: fuerza el camino de idempotencia
   * por `total_minted` y `lot_minted` (§2.3, nivel 3).
   */
  hideLookupsUntilEventsAreRead = false;
  /**
   * Se llama justo antes de reenviar cada transacción a la red; se retira
   * cuando devuelve `true` (era la transacción que esperaba).
   */
  beforeSend:
    ((tx: Parameters<ChainGateway['send']>[0]) => Promise<boolean>) | null =
    null;
  /**
   * RPC simulado (S-25): responde a una simulación como si tocara entradas
   * archivadas. Recibe la respuesta real y devuelve la que se entrega, o
   * `null` si no era la simulación que esperaba.
   */
  archivedOnce:
    | ((
        tx: Parameters<ChainGateway['simulate']>[0],
        real: Awaited<ReturnType<ChainGateway['simulate']>>,
      ) => Awaited<ReturnType<ChainGateway['simulate']>> | null)
    | null = null;
  sends = 0;

  constructor(private readonly real: ChainGateway) {}

  private guard(): void {
    if (this.down) {
      throw new ChainTxFailure('CHN_RPC_UNAVAILABLE', 'RPC detenido (prueba)');
    }
  }

  private async pass<T>(work: () => Promise<T>): Promise<T> {
    this.guard();
    return work();
  }

  networkPassphrase = () => this.pass(() => this.real.networkPassphrase());
  latestLedger = () => this.pass(() => this.real.latestLedger());
  accountBalance = (address: string) =>
    this.pass(() => this.real.accountBalance(address));
  contractExists = (address: string) =>
    this.pass(() => this.real.contractExists(address));
  codeExists = (hash: string) => this.pass(() => this.real.codeExists(hash));
  readContract: ChainGateway['readContract'] = (...args) =>
    this.pass(() => this.real.readContract(...args));
  fund = (address: string) => this.pass(() => this.real.fund(address));
  eventsPage: ChainGateway['eventsPage'] = (query) =>
    this.pass(() => this.real.eventsPage(query));
  ledgerWindow = () => this.pass(() => this.real.ledgerWindow());
  entriesTtl: ChainGateway['entriesTtl'] = (keys) =>
    this.pass(() => this.real.entriesTtl(keys));

  async simulate(
    tx: Parameters<ChainGateway['simulate']>[0],
  ): ReturnType<ChainGateway['simulate']> {
    this.guard();
    const real = await this.real.simulate(tx);
    const fake = this.archivedOnce?.(tx, real) ?? null;
    if (fake) this.archivedOnce = null;
    return fake ?? real;
  }

  async getTransaction(hash: string): Promise<TxLookup> {
    this.guard();
    if (this.hideLookupsUntilEventsAreRead) return { status: 'NOT_FOUND' };
    return this.real.getTransaction(hash);
  }

  async contractEvents(
    ...args: Parameters<ChainGateway['contractEvents']>
  ): ReturnType<ChainGateway['contractEvents']> {
    this.guard();
    // La red ya enseña el evento: desde aquí la transacción se puede leer
    this.hideLookupsUntilEventsAreRead = false;
    return this.real.contractEvents(...args);
  }

  async loadAccount(address: string): Promise<Account | null> {
    this.guard();
    const account = await this.real.loadAccount(address);
    if (account && this.staleSequenceOnce) {
      this.staleSequenceOnce = false;
      return new Account(
        address,
        (BigInt(account.sequenceNumber()) - 1n).toString(),
      );
    }
    return account;
  }

  async send(tx: Parameters<ChainGateway['send']>[0]): Promise<SendOutcome> {
    this.guard();
    this.sends += 1;
    if (this.beforeSend && (await this.beforeSend(tx))) this.beforeSend = null;
    const outcome = await this.real.send(tx);
    if (this.loseNextSendResponse && outcome.accepted) {
      this.loseNextSendResponse = false;
      return {
        accepted: false,
        rejected: false,
        failure: new ChainTxFailure(
          'CHN_RPC_UNAVAILABLE',
          'respuesta del envío perdida (prueba)',
        ),
      };
    }
    return outcome;
  }
}

/** Custodio que firma mal con las claves marcadas (autorización inválida). */
export class FaultyCustody implements KeyCustody {
  readonly driver: KeyCustody['driver'];
  readonly corrupted = new Set<string>();
  /** Firmas pedidas por referencia (para comprobar quién firmó qué). */
  readonly signatures: string[] = [];

  constructor(private readonly real: KeyCustody) {
    this.driver = real.driver;
  }

  publicKey = (ref: string) => this.real.publicKey(ref);
  ensureKey = (ref: string) => this.real.ensureKey(ref);

  async sign(ref: string, payload: Uint8Array): Promise<Uint8Array> {
    this.signatures.push(ref);
    if (this.corrupted.has(ref)) {
      return new Uint8Array(Keypair.random().sign(Buffer.from(payload)));
    }
    return this.real.sign(ref, payload);
  }
}
