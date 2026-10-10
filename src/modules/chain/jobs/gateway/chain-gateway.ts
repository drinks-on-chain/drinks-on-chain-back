import type { Account, Transaction, rpc, xdr } from '@stellar/stellar-sdk';
import type { ChainTxFailure } from '../../tx/chain-tx.errors';

/**
 * Puerta a la red (Stellar RPC y Friendbot). Es la única pieza del worker que
 * habla con la red; no conoce claves. Todo fallo de transporte sale como
 * `ChainTxFailure('CHN_RPC_UNAVAILABLE')`. Las pruebas la sustituyen por una
 * que falla a propósito (RPC detenido, secuencia en conflicto).
 */
export interface ChainGateway {
  /** Frase de red que anuncia el RPC (`getNetwork`). */
  networkPassphrase(): Promise<string>;
  latestLedger(): Promise<number>;
  /** Cuenta con su número de secuencia; `null` si no existe en la red. */
  loadAccount(address: string): Promise<Account | null>;
  /** Saldo en stroops; `null` si la cuenta no existe. */
  accountBalance(address: string): Promise<bigint | null>;
  /** ¿Existe la instancia del contrato `C…`? */
  contractExists(contractAddress: string): Promise<boolean>;
  /** ¿Está subido el código `wasmHash`? */
  codeExists(wasmHash: string): Promise<boolean>;
  simulate(tx: Transaction): Promise<rpc.Api.SimulateTransactionResponse>;
  /** Lectura de un contrato por simulación (no envía nada). */
  readContract(
    contractAddress: string,
    method: string,
    args: xdr.ScVal[],
    sourceAddress: string,
  ): Promise<unknown>;
  send(tx: Transaction): Promise<SendOutcome>;
  getTransaction(txHash: string): Promise<TxLookup>;
  /**
   * Eventos de un contrato desde `fromLedger` cuyo primer *topic* es `name`
   * (`getEvents`). El RPC solo guarda ≈ 7 días: un `fromLedger` anterior a su
   * ventana se ajusta al más antiguo que conserva.
   */
  contractEvents(
    contractAddress: string,
    name: string,
    fromLedger: number,
  ): Promise<ChainContractEvent[]>;
  /**
   * Página de eventos de varios contratos (`getEvents`, §8.1), en orden, a
   * partir de `startLedger` o de `cursor` (el de la página anterior). Hasta 25
   * contratos por llamada (cinco filtros de cinco, el tope del RPC).
   */
  eventsPage(query: EventsQuery): Promise<EventsPage>;
  /** Ventana de ledgers que conserva el RPC (`getHealth`). */
  ledgerWindow(): Promise<{ latest: number; oldest: number }>;
  /**
   * Vida de unas entradas (`getLedgerEntries` → `liveUntilLedgerSeq`, §8.3),
   * por su clave en XDR base64. Una entrada que no existe no aparece en el
   * mapa.
   */
  entriesTtl(keys: xdr.LedgerKey[]): Promise<EntriesTtl>;
  /** Friendbot (solo `TESTNET` y `LOCAL`). */
  fund(address: string): Promise<{ txHash: string | null }>;
}

/** Contratos por llamada a `getEvents`: 5 filtros × 5 `contractIds`. */
export const EVENTS_CONTRACTS_PER_CALL = 25;

export interface EventsQuery {
  contractIds: string[];
  /** Primer ledger a leer; se ignora si hay `cursor`. */
  startLedger: number;
  cursor?: string | null;
  limit?: number;
}

/** Evento tal como lo guarda el indexador (`chain_events`). */
export interface IndexedChainEvent extends ChainContractEvent {
  /** Id del RPC (`{toid}-{índice}`): único y ordenable. */
  rpcEventId: string;
  contractAddress: string;
  txHash: string;
  ledger: number;
  closedAt: Date;
}

export interface EventsPage {
  events: IndexedChainEvent[];
  cursor: string | null;
  latestLedger: number;
  oldestLedger: number | null;
}

export interface EntriesTtl {
  latestLedger: number;
  /** `LedgerKey` en XDR base64 → último ledger en que la entrada vive. */
  liveUntil: Map<string, number>;
}

export const CHAIN_GATEWAY = Symbol('CHAIN_GATEWAY');

export type SendOutcome =
  /** La red la aceptó (`PENDING`) o ya la tenía (`DUPLICATE`). */
  | { accepted: true }
  /**
   * `rejected: true` = la red la rechazó y no puede entrar; `false` = no se
   * sabe si llegó (se consulta su hash antes de reconstruirla, §2.3).
   */
  | { accepted: false; rejected: boolean; failure: ChainTxFailure };

/** Evento de contrato decodificado (bigint como texto, bytes en hex). */
export interface ChainContractEvent {
  /** Primer *topic*: `lot_minted`, `consecutive_mint`… */
  name: string;
  /** Contrato que lo emitió (`C…`); `null` si no se pudo leer. */
  contractAddress: string | null;
  /** Resto de *topics*, en orden. */
  topics: unknown[];
  /** Datos: siempre un mapa de símbolo a valor (`docs/funciones.md`). */
  data: Record<string, unknown>;
  /** Solo en los leídos con `contractEvents` (`getEvents`). */
  txHash?: string;
  ledger?: number;
}

export type TxLookup =
  | { status: 'NOT_FOUND' }
  | {
      status: 'SUCCESS';
      ledger: number;
      closedAt: Date;
      feeChargedStroops: bigint;
      rentFeeStroops: bigint | null;
      /** Valor devuelto, ya en JSON (bigint como texto, bytes en hex). */
      returnValue: unknown;
      /** Nombre (primer *topic*) de cada evento de contrato emitido. */
      contractEvents: string[];
      /** Los mismos eventos, decodificados. */
      events: ChainContractEvent[];
      /** Cuenta de origen del sobre (`G…`), leída de la transacción. */
      sourceAccount: string | null;
      /** Memo de tipo `MEMO_HASH` en hex; `null` si no lleva o es de otro tipo. */
      memoHashHex: string | null;
    }
  | {
      status: 'FAILED';
      ledger: number;
      feeChargedStroops: bigint;
      failure: ChainTxFailure;
    };
