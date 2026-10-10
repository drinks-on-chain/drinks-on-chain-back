import { ErrorCode } from '@shared/exceptions/error-codes';
import type { ErrorDetail } from '@shared/interfaces/api-response.interface';
import { MINT_BATCH_MAX_AMOUNT } from '@modules/chain/chain.constants';
import type {
  TokenizationLimitBasis,
  TokenizationRequestKind,
} from '../tokenization.constants';

/**
 * Reglas de la cuota (contrato O3 §5.2, R6). Funciones puras: quien llama
 * carga los datos del lote dentro de su transacción (con la fila del lote
 * bloqueada) y aplica aquí las reglas.
 */

/** Etapas en las que el lote ya no se puede tokenizar (§5.2.2, P-2). */
export const NON_TOKENIZABLE_STAGES: readonly string[] = [
  'CERTIFIED',
  'ANCHORED',
  'REJECTED',
  'DISCARDED',
];

/** Lo que las reglas necesitan saber del lote. */
export interface QuotaLot {
  stage: string;
  productType: string | null;
  estimatedBottles: number | null;
  /** El lote ya se embotelló (tiene registro de embotellado). */
  bottled: boolean;
  /** Códigos de botella `ACTIVE` (O2 §7.1); solo cuenta si `bottled`. */
  activeBottles: number;
  /** Cuota aprobada vigente (0 sin colección). */
  authorizedQuota: number;
  /** Cantidad pedida en la solicitud abierta del lote (0 si no hay). */
  pendingQuantity: number;
  /** La colección del lote está `CLOSED`: no admite ampliaciones. */
  collectionClosed?: boolean;
}

export interface TokenizationLimits {
  basis: TokenizationLimitBasis;
  estimatedBottles: number | null;
  bottles: number | null;
  authorizedQuota: number;
  pendingQuantity: number;
  maxQuantity: number;
}

const fmt = (n: number): string => n.toLocaleString('es-BO');

/** El techo de la cuota: botellas desde el embotellado; antes, la estimación. */
function ceiling(lot: QuotaLot): number | null {
  return lot.bottled ? lot.activeBottles : lot.estimatedBottles;
}

/** `TokenizationLimits` del lote ahora (§5.1). */
export function computeLimits(lot: QuotaLot): TokenizationLimits {
  const limit = ceiling(lot);
  return {
    basis: lot.bottled ? 'BOTTLES' : 'ESTIMATE',
    estimatedBottles: lot.estimatedBottles,
    bottles: lot.bottled ? lot.activeBottles : null,
    authorizedQuota: lot.authorizedQuota,
    pendingQuantity: lot.pendingQuantity,
    maxQuantity:
      limit === null
        ? 0
        : Math.max(0, limit - lot.authorizedQuota - lot.pendingQuantity),
  };
}

/** Tipo de la solicitud: lo deduce el servidor (§5.2.4). */
export function requestKind(hasCollection: boolean): TokenizationRequestKind {
  return hasCollection ? 'QUOTA_INCREASE' : 'INITIAL';
}

/**
 * Por qué el lote no admite una solicitud (§5.2.2): etapa (409
 * `TOK_LOT_NOT_TOKENIZABLE`), sin tipo de producto o sin estimación (422).
 * Vacío = tokenizable.
 */
export function lotBlockers(lot: QuotaLot): ErrorDetail[] {
  const blockers: ErrorDetail[] = [];
  if (NON_TOKENIZABLE_STAGES.includes(lot.stage)) {
    blockers.push({
      field: null,
      code: ErrorCode.TOK_LOT_NOT_TOKENIZABLE,
      message: STAGE_MESSAGES[lot.stage] ?? 'El lote ya no se puede tokenizar',
      meta: { stage: lot.stage },
    });
  }
  if (lot.collectionClosed) {
    blockers.push({
      field: null,
      code: ErrorCode.TOK_LOT_NOT_TOKENIZABLE,
      message:
        'La colección del lote está cerrada: ya no admite ampliaciones de cuota',
      meta: { stage: lot.stage, collectionStatus: 'CLOSED' },
    });
  }
  if (lot.productType === null) {
    blockers.push({
      field: 'productType',
      code: ErrorCode.TOK_LOT_PRODUCT_UNDEFINED,
      message:
        'El lote aún no tiene tipo de producto: se define al elegir el destino del primer tanque',
    });
  }
  if (lot.estimatedBottles === null) {
    blockers.push({
      field: 'estimatedBottles',
      code: ErrorCode.TOK_LOT_ESTIMATE_MISSING,
      message:
        'Declara la estimación de botellas del lote antes de autorizar su tokenización',
    });
  }
  return blockers;
}

const STAGE_MESSAGES: Record<string, string> = {
  CERTIFIED:
    'El lote ya está certificado: la tokenización se autoriza antes de cerrar el expediente',
  ANCHORED:
    'El lote ya está anclado en la red: la tokenización se autoriza antes de cerrar el expediente',
  REJECTED: 'El lote fue rechazado: no se puede tokenizar',
  DISCARDED: 'El lote fue descartado: no se puede tokenizar',
};

/**
 * Violaciones de la cantidad pedida (§5.2.3). `lot.pendingQuantity` no cuenta
 * aquí: se valida la solicitud que se crea, edita o aprueba, no una ajena
 * (solo puede haber una abierta por lote).
 */
export function quantityViolations(
  lot: QuotaLot,
  quantity: number,
  field = 'quantity',
): ErrorDetail[] {
  if (!Number.isInteger(quantity) || quantity < 1) {
    return [
      {
        field,
        code: ErrorCode.TOK_QUOTA_INVALID,
        message: 'La cantidad debe ser un número entero de al menos 1 botella',
        expected: 1,
        actual: quantity,
      },
    ];
  }
  const limit = ceiling(lot);
  if (limit === null) return [];
  const resultingQuota = lot.authorizedQuota + quantity;
  if (resultingQuota <= limit) return [];
  const maxQuantity = Math.max(0, limit - lot.authorizedQuota);
  const already =
    lot.authorizedQuota > 0
      ? ` y ya hay ${fmt(lot.authorizedQuota)} autorizadas`
      : '';
  const can =
    maxQuantity > 0
      ? `Puedes autorizar hasta ${fmt(maxQuantity)} botellas`
      : 'No quedan botellas por autorizar';
  return [
    {
      field,
      code: lot.bottled
        ? ErrorCode.TOK_QUOTA_EXCEEDS_BOTTLES
        : ErrorCode.TOK_QUOTA_EXCEEDS_ESTIMATE,
      message: lot.bottled
        ? `${can}: el lote tiene ${fmt(limit)} botellas con código activo${already}`
        : `${can}: la estimación del lote es ${fmt(limit)}${already}`,
      rule: lot.bottled ? 'lot.bottles' : 'lot.estimatedBottles',
      expected: limit,
      actual: resultingQuota,
      meta: { maxQuantity, authorizedQuota: lot.authorizedQuota },
    },
  ];
}

/**
 * Bloqueos que muestra `GET /v1/lots/{id}/tokenization` (§5.3): los del lote,
 * la solicitud ya abierta y la cuota agotada. Vacío = se puede enviar una
 * solicitud ahora.
 */
export function submissionBlockers(
  lot: QuotaLot,
  openRequestId: string | null,
): ErrorDetail[] {
  const blockers = lotBlockers(lot);
  if (openRequestId) {
    blockers.push({
      field: null,
      code: ErrorCode.TOK_REQUEST_ALREADY_OPEN,
      message:
        'El lote ya tiene una solicitud de tokenización abierta: espera su respuesta, edítala o retírala',
      meta: { requestId: openRequestId },
    });
  }
  const limit = ceiling(lot);
  if (blockers.length === 0 && limit !== null && limit <= lot.authorizedQuota) {
    blockers.push({
      field: 'quantity',
      code: lot.bottled
        ? ErrorCode.TOK_QUOTA_EXCEEDS_BOTTLES
        : ErrorCode.TOK_QUOTA_EXCEEDS_ESTIMATE,
      message: lot.bottled
        ? `Ya están autorizadas ${fmt(lot.authorizedQuota)} botellas y el lote tiene ${fmt(limit)} con código activo`
        : `Ya están autorizadas ${fmt(lot.authorizedQuota)} botellas, toda la estimación del lote (${fmt(limit)}): sube la estimación para ampliar la cuota`,
      rule: lot.bottled ? 'lot.bottles' : 'lot.estimatedBottles',
      expected: limit,
      actual: lot.authorizedQuota,
      meta: { maxQuantity: 0, authorizedQuota: lot.authorizedQuota },
    });
  }
  return blockers;
}

/**
 * La estimación no baja de lo emitido (§5.2.6): regla de `PATCH /v1/lots/{id}`.
 * Bajarla por debajo de la cuota pero no de lo emitido sí se admite.
 */
export function estimateBelowMinted(
  estimatedBottles: number,
  minted: number,
): ErrorDetail | null {
  if (estimatedBottles >= minted) return null;
  return {
    field: 'estimatedBottles',
    code: ErrorCode.TOK_ESTIMATE_BELOW_MINTED,
    message: `La estimación no puede bajar de las ${fmt(minted)} botellas ya emitidas como NFT`,
    rule: 'collection.minted',
    expected: minted,
    actual: estimatedBottles,
  };
}

export interface MintChunk {
  /** 1, 2…: orden de envío. */
  index: number;
  amount: number;
  firstBottleNumber: number;
  lastBottleNumber: number;
}

/**
 * Trozos de una emisión (§6.1, DS-13): cada `mint_batch` lleva como mucho
 * 32 000 NFT. Los números de botella siguen a los de las emisiones anteriores
 * (`previousQuota + 1`, S-13).
 */
export function mintChunks(
  quantity: number,
  previousQuota: number,
  maxAmount: number = MINT_BATCH_MAX_AMOUNT,
): MintChunk[] {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new RangeError('La emisión necesita al menos 1 NFT');
  }
  const chunks: MintChunk[] = [];
  let next = previousQuota + 1;
  let remaining = quantity;
  while (remaining > 0) {
    const amount = Math.min(remaining, maxAmount);
    chunks.push({
      index: chunks.length + 1,
      amount,
      firstBottleNumber: next,
      lastBottleNumber: next + amount - 1,
    });
    next += amount;
    remaining -= amount;
  }
  return chunks;
}
