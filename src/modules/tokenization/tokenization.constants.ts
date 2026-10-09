/**
 * Enumeraciones de la tokenización (contrato O3 §5, §6 y §8.4). En la base
 * se guardan como texto; estos son sus únicos valores válidos.
 */

export const TOKENIZATION_REQUEST_KINDS = [
  'INITIAL',
  'QUOTA_INCREASE',
] as const;
export type TokenizationRequestKind =
  (typeof TOKENIZATION_REQUEST_KINDS)[number];

export const TOKENIZATION_REQUEST_STATUSES = [
  'SUBMITTED',
  'IN_REVIEW',
  'CHANGES_REQUESTED',
  'APPROVED',
  'REJECTED',
  'WITHDRAWN',
] as const;
export type TokenizationRequestStatus =
  (typeof TOKENIZATION_REQUEST_STATUSES)[number];

/** Una sola solicitud abierta por lote (índice único parcial en la base). */
export const OPEN_TOKENIZATION_REQUEST_STATUSES: readonly TokenizationRequestStatus[] =
  ['SUBMITTED', 'IN_REVIEW', 'CHANGES_REQUESTED'];

export const TOKENIZATION_LIMIT_BASES = ['ESTIMATE', 'BOTTLES'] as const;
export type TokenizationLimitBasis = (typeof TOKENIZATION_LIMIT_BASES)[number];

/** Marca de tokenización de `LotSummary` (§5.3): no es una etapa del lote. */
export const LOT_TOKENIZATION_STATES = [
  'NONE',
  'REQUESTED',
  'CHANGES_REQUESTED',
  'MINTING',
  'MINT_FAILED',
  'READY',
  'PUBLISHED',
  'PAUSED',
  'CLOSED',
] as const;
export type LotTokenizationState = (typeof LOT_TOKENIZATION_STATES)[number];

export const COLLECTION_STATUSES = [
  'MINTING',
  'READY',
  'PUBLISHED',
  'PAUSED',
  'CLOSED',
] as const;
export type CollectionStatus = (typeof COLLECTION_STATUSES)[number];

export const MINT_STATUSES = [
  'PENDING',
  'IN_PROGRESS',
  'CONFIRMED',
  'FAILED',
] as const;
export type MintStatus = (typeof MINT_STATUSES)[number];

/** Derivado; `null` si la colección no está `PUBLISHED`. */
export const SALE_STATES = ['PRESALE', 'ON_SALE', 'SOLD_OUT'] as const;
export type SaleState = (typeof SALE_STATES)[number];

export const TOKEN_STATUSES = [
  'MINTED',
  'RESERVED',
  'SOLD',
  'REDEEMABLE',
  'PASS_ACTIVE',
  'REDEEMED',
  'BURNED',
  'EXPIRED',
] as const;
export type TokenStatus = (typeof TOKEN_STATUSES)[number];

export const TOKEN_OWNER_KINDS = ['WINERY', 'CONSUMER'] as const;
export type TokenOwnerKind = (typeof TOKEN_OWNER_KINDS)[number];

export const TOKEN_BURN_REASONS = [
  'REDEMPTION',
  'SHORTFALL',
  'WINDOW_EXPIRED',
] as const;
export type TokenBurnReason = (typeof TOKEN_BURN_REASONS)[number];

export const PRICE_SOURCES = ['POLICY_SUGGESTED', 'MANUAL'] as const;
export type PriceSource = (typeof PRICE_SOURCES)[number];

/** A-06, A-32: un solo importe en centavos de boliviano. */
export const PRICE_CURRENCIES = ['BOB'] as const;
export type PriceCurrency = (typeof PRICE_CURRENCIES)[number];

export const LOT_CLOSURE_STATUSES = [
  'NO_SHORTFALL',
  'SHORTFALL_OPEN',
  'DECIDED',
  'RESOLVED',
] as const;
export type LotClosureStatus = (typeof LOT_CLOSURE_STATUSES)[number];

export const UNSOLD_POLICIES = ['KEEP_ON_SALE', 'BURN'] as const;
export type UnsoldPolicy = (typeof UNSOLD_POLICIES)[number];

export const CLOSURE_ITEM_OUTCOMES = [
  'BURN_UNSOLD',
  'MANUAL_REFUND',
  'MANUAL_SUBSTITUTE',
  'PENDING',
] as const;
export type ClosureItemOutcome = (typeof CLOSURE_ITEM_OUTCOMES)[number];

/** Lo que operaciones puede registrar a mano en un ítem del cierre. */
export const MANUAL_CLOSURE_OUTCOMES = [
  'MANUAL_REFUND',
  'MANUAL_SUBSTITUTE',
] as const;

/** Imágenes por colección (§5.5). */
export const COLLECTION_MAX_IMAGES = 8;

/** Marca de tokenización de un lote sin solicitud ni colección. */
export const NO_LOT_TOKENIZATION = {
  state: 'NONE',
  quota: 0,
  minted: 0,
  collectionId: null,
} as const satisfies {
  state: LotTokenizationState;
  quota: number;
  minted: number;
  collectionId: string | null;
};
