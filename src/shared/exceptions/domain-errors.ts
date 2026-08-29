import {
  DomainException,
  ConflictException,
  ResourceNotFoundException,
} from './app.exception';

// ── COSECHAS ──────────────────────────────────────────────
export const HarvestErrors = {
  notFound: (id: string) => new ResourceNotFoundException('Harvest batch', id),
  notApproved: () =>
    new DomainException(
      'HARVEST_BATCH_NOT_APPROVED',
      'Harvest batch must be approved before fermentation',
    ),
  codeDuplicate: (code: string) =>
    new ConflictException(
      'HARVEST_BATCH_CODE_DUPLICATE',
      `Harvest batch code '${code}' already exists`,
    ),
} as const;

// ── EMBOTELLADO ────────────────────────────────────────────
export const BottlingErrors = {
  notFound: (id: string) => new ResourceNotFoundException('Bottling batch', id),
  sourceLocked: () =>
    new DomainException(
      'BOTTLING_BATCH_SOURCE_LOCKED',
      'Source batch is not ready for bottling. Check aging or rest period status.',
    ),
  noLabAnalysis: () =>
    new DomainException(
      'BOTTLING_BATCH_NO_LAB_ANALYSIS',
      'A conforming lab analysis is required before releasing a batch',
    ),
  alreadyAnchored: () =>
    new ConflictException(
      'BOTTLING_BATCH_ALREADY_ANCHORED',
      'This batch is already anchored on the blockchain',
    ),
} as const;

// ── TOKENIZACIÓN ───────────────────────────────────────────
export const CollectionErrors = {
  notFound: (id: string) => new ResourceNotFoundException('Collection', id),
  notPublished: () =>
    new DomainException(
      'COLLECTION_NOT_PUBLISHED',
      'Collection is not available for purchase',
    ),
  soldOut: () =>
    new DomainException(
      'COLLECTION_SOLD_OUT',
      'No units available in this collection',
    ),
  batchNotAnchored: () =>
    new DomainException(
      'COLLECTION_BATCH_NOT_ANCHORED',
      'The bottling batch must be anchored on-chain before tokenizing',
    ),
} as const;

export const TokenErrors = {
  notFound: (id: string) => new ResourceNotFoundException('Token', id),
  notOwned: () =>
    new DomainException('TOKEN_NOT_OWNED', 'You do not own this token'),
  alreadyBurned: () =>
    new DomainException(
      'TOKEN_ALREADY_BURNED',
      'This bottle has already been redeemed',
    ),
} as const;

// ── CLAIMS ────────────────────────────────────────────────
export const ClaimErrors = {
  notFound: (id: string) => new ResourceNotFoundException('Claim pass', id),
  expired: () =>
    new DomainException('CLAIM_PASS_EXPIRED', 'Claim pass has expired'),
  alreadyUsed: () =>
    new DomainException(
      'CLAIM_PASS_ALREADY_USED',
      'Claim pass has already been used',
    ),
  wrongLocation: () =>
    new DomainException(
      'CLAIM_PASS_WRONG_LOCATION',
      'This claim pass is not valid for this pickup location',
    ),
  invalidHash: () =>
    new DomainException(
      'CLAIM_PASS_INVALID_HASH',
      'Claim pass data is invalid or has been tampered with',
    ),
  activePassExists: () =>
    new ConflictException(
      'CLAIM_ACTIVE_PASS_EXISTS',
      'An active claim pass already exists for this token',
    ),
} as const;

// ── PAGOS ─────────────────────────────────────────────────
export const PaymentErrors = {
  invalidWebhookSignature: () =>
    new DomainException(
      'PAYMENT_WEBHOOK_INVALID_SIGNATURE',
      'Webhook signature verification failed',
    ),
  alreadyProcessed: (chargeId: string) =>
    new ConflictException(
      'PAYMENT_CHARGE_ALREADY_PROCESSED',
      `Charge ${chargeId} has already been processed`,
    ),
} as const;
