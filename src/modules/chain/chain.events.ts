/**
 * Eventos del outbox y trabajos de las colas de la cadena (contrato O3 §11).
 * Cargas mínimas: identificadores, nunca claves, semillas ni XDR.
 */

export const CHAIN_TX_AGGREGATE = 'chain_transaction';

/** Intención registrada: el firmante del worker la toma (cola `chain`). */
export const CHAIN_TX_REQUESTED = 'chain.tx.requested';
export const CHAIN_TX_CONFIRMED = 'chain.tx.confirmed';
export const CHAIN_TX_FAILED = 'chain.tx.failed';
export const CHAIN_ALERT_RAISED = 'chain.alert.raised';
/** Cuenta y contrato confirmados y leídos de vuelta (§3.1). */
export const WINERY_CHAIN_IDENTITY_READY = 'winery.chain_identity_ready';

export type ChainTxEventPayload = {
  transactionId: string;
  kind: string;
  wineryId: string | null;
};

export type ChainTxFailedPayload = ChainTxEventPayload & {
  errorCode: string;
};

export type ChainAlertRaisedPayload = {
  alertId: string;
  code: string;
  level: string;
  wineryId: string | null;
};

export type WineryChainIdentityReadyPayload = {
  wineryId: string;
  network: string;
  account: string;
  contract: string;
};

// ── Trabajos directos (no pasan por el outbox: no cambian nada por sí solos) ──

/** Cola `chain`: vuelve a intentar tomar una transacción en espera. */
export const CHAIN_TX_PROCESS_JOB = 'chain.tx.process';
/** Cola `chain-poll`: consulta en la red una transacción enviada. */
export const CHAIN_TX_CONFIRM_JOB = 'chain.tx.confirm';
/** Cola `chain`: relleno de identidades, de una en una (§3.3 paso 4). */
export const CHAIN_IDENTITY_BACKFILL_JOB = 'chain.identity.backfill';
/** Cola `chain`: ancla los expedientes cerrados que aún no tienen anclaje (§7.1). */
export const CHAIN_ANCHOR_BACKFILL_JOB = 'chain.anchor.backfill';

// ── Tareas programadas ──────────────────────────────────────────────────────

export const CHAIN_TX_POLL_TASK = 'chain.tx.poll';
export const CHAIN_BALANCE_CHECK_TASK = 'chain.balance.check';
export const CHAIN_TESTNET_FUND_TASK = 'chain.testnet.fund';

export type ChainTxJobData = { transactionId: string };
