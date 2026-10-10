import type { ChainTxKind, ChainTxStatus } from '../chain.constants';

/**
 * Ciclo de estados de una transacción de la cadena (contrato O3 §2.3;
 * `docs-back/03` §7). Funciones puras: las usan la API (reintento manual) y
 * el worker (firmante y sondeo).
 */

const TRANSITIONS: Record<ChainTxStatus, readonly ChainTxStatus[]> = {
  // `FAILED` desde `PENDING`: la intención no supera la validación de §2.2
  PENDING: ['BUILDING', 'FAILED'],
  // `CONFIRMED` desde `BUILDING`: la red ya tenía el efecto (idempotencia) o
  // la intención no firma (Friendbot)
  BUILDING: ['SUBMITTED', 'RETRYING', 'FAILED', 'CONFIRMED'],
  SUBMITTED: ['CONFIRMED', 'RETRYING', 'FAILED'],
  RETRYING: ['BUILDING', 'FAILED', 'CONFIRMED'],
  CONFIRMED: [],
  // Reintento manual desde el back office
  FAILED: ['PENDING'],
};

export function canTransition(from: ChainTxStatus, to: ChainTxStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidChainTxTransition extends Error {
  constructor(
    readonly from: ChainTxStatus,
    readonly to: ChainTxStatus,
  ) {
    super(`Transición de transacción no válida: ${from} → ${to}`);
    this.name = 'InvalidChainTxTransition';
  }
}

export function assertTransition(from: ChainTxStatus, to: ChainTxStatus): void {
  if (!canTransition(from, to)) throw new InvalidChainTxTransition(from, to);
}

/** Estados en los que la transacción ocupa la secuencia de su cuenta de origen. */
export const IN_FLIGHT_STATUSES: readonly ChainTxStatus[] = [
  'BUILDING',
  'SUBMITTED',
];

/** Estados sin terminar (`pendingTransactions` de la identidad, refresco de la UI). */
export const OPEN_TX_STATUSES: readonly ChainTxStatus[] = [
  'PENDING',
  'BUILDING',
  'SUBMITTED',
  'RETRYING',
];

export type RetryDecision =
  { retry: true; delayMs: number; nextAttemptAt: Date } | { retry: false };

/**
 * Tras el intento número `attempts` (≥ 1) fallido por un error transitorio:
 * espera `delays[attempts − 1]` y reintenta; agotadas las esperas (6 intentos
 * con las cinco de S-4), `FAILED`.
 */
export function decideRetry(
  attempts: number,
  delays: readonly number[],
  now: Date = new Date(),
): RetryDecision {
  const delayMs = delays[attempts - 1];
  if (attempts < 1 || delayMs === undefined) return { retry: false };
  return {
    retry: true,
    delayMs,
    nextAttemptAt: new Date(now.getTime() + delayMs),
  };
}

/** Intentos máximos con esas esperas (uno más que esperas). */
export const maxAttempts = (delays: readonly number[]): number =>
  delays.length + 1;

/**
 * Idempotencia en la red (§2.3, nivel 3): una transacción enviada sin
 * respuesta solo se reconstruye si la red dice `NOT_FOUND` **y** su `maxTime`
 * ya pasó (la anterior ya no puede entrar).
 */
export function canRebuildAfterNotFound(
  maxTime: Date | null,
  now: Date = new Date(),
  graceMs = 5_000,
): boolean {
  return maxTime === null || now.getTime() > maxTime.getTime() + graceMs;
}

/** Tipos que no firman ni ocupan secuencia (no se serializan por cuenta). */
export const UNSIGNED_TX_KINDS: readonly ChainTxKind[] = ['FUND_ACCOUNT'];
