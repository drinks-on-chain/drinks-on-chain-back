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
  /** Friendbot (solo `TESTNET` y `LOCAL`). */
  fund(address: string): Promise<{ txHash: string | null }>;
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
