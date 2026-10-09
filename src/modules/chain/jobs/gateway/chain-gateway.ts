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
    }
  | {
      status: 'FAILED';
      ledger: number;
      feeChargedStroops: bigint;
      failure: ChainTxFailure;
    };
