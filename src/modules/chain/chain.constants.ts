/**
 * Enumeraciones de la cadena (contrato O3 §0, §2 y §8). En la base se guardan
 * como texto; estos son sus únicos valores válidos.
 */

/** `LOCAL` = `stellar/quickstart` en las pruebas. */
export const CHAIN_NETWORKS = ['TESTNET', 'PUBLIC', 'LOCAL'] as const;
export type ChainNetwork = (typeof CHAIN_NETWORKS)[number];

/** Papel de una cuenta en la red (§2.1). */
export const CHAIN_ACCOUNT_ROLES = [
  'OPERATIONS',
  'ANCHOR',
  'WINERY',
  'CONSUMER_SEED',
] as const;
export type ChainAccountRole = (typeof CHAIN_ACCOUNT_ROLES)[number];

/** Intenciones de dominio que el firmante acepta (§2.2). */
export const CHAIN_TX_KINDS = [
  'CREATE_WINERY_ACCOUNT',
  'DEPLOY_WINERY_CONTRACT',
  'SET_TOKEN_URI_BASE',
  'MINT_BATCH',
  'ANCHOR_DOSSIER',
  'PAUSE_CONTRACT',
  'UNPAUSE_CONTRACT',
  'BURN_UNSOLD',
  'EXTEND_TTL',
  'RESTORE_ENTRIES',
  'FUND_ACCOUNT',
  'OPERATOR_TRANSFER',
  'REDEEM_BURN',
] as const;
export type ChainTxKind = (typeof CHAIN_TX_KINDS)[number];

/** Reservadas para las Olas 4 y 5: el firmante las rechaza en esta ola. */
export const RESERVED_CHAIN_TX_KINDS: readonly ChainTxKind[] = [
  'OPERATOR_TRANSFER',
  'REDEEM_BURN',
];

/** Deben terminar: no se abandonan (→ 409 `CHN_TX_NOT_ABANDONABLE`). */
export const NON_ABANDONABLE_CHAIN_TX_KINDS: readonly ChainTxKind[] = [
  'MINT_BATCH',
  'ANCHOR_DOSSIER',
  'CREATE_WINERY_ACCOUNT',
  'DEPLOY_WINERY_CONTRACT',
];

export const CHAIN_TX_STATUSES = [
  'PENDING',
  'BUILDING',
  'SUBMITTED',
  'CONFIRMED',
  'RETRYING',
  'FAILED',
] as const;
export type ChainTxStatus = (typeof CHAIN_TX_STATUSES)[number];

export const CHAIN_SUBJECT_TYPES = [
  'WINERY',
  'CONTRACT',
  'MINT',
  'LOT',
  'TOKEN',
  'PLATFORM',
] as const;
export type ChainSubjectType = (typeof CHAIN_SUBJECT_TYPES)[number];

export const CHAIN_SIGNER_ROLES = ['OPERATIONS', 'ANCHOR', 'WINERY'] as const;
export type ChainSignerRole = (typeof CHAIN_SIGNER_ROLES)[number];

/** Identidad de la bodega en la red (§3.1). */
export const CHAIN_IDENTITY_STATUSES = [
  'NOT_PROVISIONED',
  'PROVISIONING',
  'ACTIVE',
  'FAILED',
  'PAUSED',
] as const;
export type ChainIdentityStatus = (typeof CHAIN_IDENTITY_STATUSES)[number];

export const PLATFORM_ACCOUNT_STATUSES = ['OK', 'LOW', 'MISSING'] as const;
export type PlatformAccountBalanceStatus =
  (typeof PLATFORM_ACCOUNT_STATUSES)[number];

/** Anclaje del expediente (§7.1). */
export const DOSSIER_ANCHOR_STATUSES = [
  'PENDING',
  'SUBMITTED',
  'ANCHORED',
  'FAILED',
] as const;
export type DossierAnchorStatus = (typeof DOSSIER_ANCHOR_STATUSES)[number];

/** En público, `FAILED` y `SUBMITTED` se muestran como `PENDING` (S-17). */
export const PUBLIC_ANCHOR_STATUSES = ['PENDING', 'ANCHORED'] as const;
export type PublicAnchorStatus = (typeof PUBLIC_ANCHOR_STATUSES)[number];

export const VERIFICATION_CHECK_KEYS = [
  'DOSSIER_CLOSED',
  'ANCHOR_CONFIRMED',
  'MEMO_MATCHES_HASH',
  'ANCHOR_ACCOUNT_OFFICIAL',
] as const;
export type VerificationCheckKey = (typeof VERIFICATION_CHECK_KEYS)[number];

/** Conciliación y alertas (§8.2). */
export const RECONCILIATION_SCOPES = ['ALL', 'CONTRACT', 'COLLECTION'] as const;
export type ReconciliationScope = (typeof RECONCILIATION_SCOPES)[number];
export const RECONCILIATION_TRIGGERS = [
  'SCHEDULED',
  'MANUAL',
  'INDEXER_GAP',
] as const;
export const RECONCILIATION_DEPTHS = ['LIGHT', 'FULL'] as const;
export type ReconciliationDepth = (typeof RECONCILIATION_DEPTHS)[number];
export const RECONCILIATION_STATUSES = [
  'RUNNING',
  'OK',
  'DIFFERENCES',
  'ERROR',
] as const;
export const CHAIN_ALERT_LEVELS = ['INFO', 'WARNING', 'CRITICAL'] as const;
export type ChainAlertLevel = (typeof CHAIN_ALERT_LEVELS)[number];

/** Códigos de alerta conocidos (el campo es texto: pueden añadirse). */
export const CHAIN_ALERT_CODES = [
  'TOTAL_MINTED_MISMATCH',
  'BALANCE_MISMATCH',
  'OWNER_MISMATCH',
  'BURN_MISMATCH',
  'PAUSE_MISMATCH',
  'ROLE_MISMATCH',
  'QUOTA_EXCEEDED',
  'BOTTLES_SHORTFALL',
  'ANCHOR_MISMATCH',
  'TX_STUCK',
  'LOW_BALANCE',
  'TTL_EXPIRING',
  'UNEXPECTED_EVENT',
  'INDEXER_GAP',
  'NETWORK_RESET',
  'CHN_INTENT_REJECTED',
  'TX_FAILED',
] as const;

/**
 * Códigos internos de `ChainTransaction.lastError` (§2.3 y §9): no son
 * respuestas HTTP; el back office los muestra.
 */
export const CHAIN_TX_ERROR_CODES = [
  'CHN_RPC_UNAVAILABLE',
  'CHN_TX_TIMEOUT',
  'CHN_BAD_SEQUENCE',
  'CHN_INSUFFICIENT_FEE',
  'CHN_TRY_AGAIN_LATER',
  'CHN_ARCHIVED_ENTRY',
  'CHN_CONTRACT_ERROR',
  'CHN_AUTH_FAILED',
  'CHN_INSUFFICIENT_BALANCE',
  'CHN_INTENT_REJECTED',
  'CHN_MINT_DISABLED',
  'CHN_NETWORK_RESET',
] as const;

/** Referencias de las claves en el custodio (§2.1). */
export const CUSTODY_REF_OPERATIONS = 'platform-operations';
export const CUSTODY_REF_ANCHOR = 'platform-anchor';
export const CUSTODY_REF_CONSUMER_SEED = 'consumer-master-seed';
export const wineryCustodyRef = (wineryId: string) => `winery-${wineryId}`;

/** Trozo máximo de `mint_batch` (DS-13). */
export const MINT_BATCH_MAX_AMOUNT = 32_000;
