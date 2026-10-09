import { ErrorCode } from '@shared/exceptions/error-codes';
import { stateError } from '@modules/lots/domain/trace-errors';
import {
  OPEN_TOKENIZATION_REQUEST_STATUSES,
  type CollectionStatus,
  type LotTokenizationState,
  type MintStatus,
  type SaleState,
  type TokenizationRequestStatus,
} from '../tokenization.constants';

/**
 * Máquinas de estado de la solicitud (contrato O3 §5.3 y §5.4) y de la
 * colección (§6.2). Transición no válida → 409 con `meta: { from, to }`.
 */

export type RequestAction =
  | 'EDIT'
  | 'RESUBMIT'
  | 'WITHDRAW'
  | 'TAKE'
  | 'REVIEW'
  | 'REQUEST_CHANGES'
  | 'APPROVE'
  | 'REJECT';

interface RequestRule {
  from: readonly TokenizationRequestStatus[];
  /** `null`: la acción no cambia el estado. */
  to: TokenizationRequestStatus | null;
}

const OPEN = OPEN_TOKENIZATION_REQUEST_STATUSES;

export const REQUEST_TRANSITIONS: Record<RequestAction, RequestRule> = {
  // La bodega edita mientras operaciones no la tenga tomada
  EDIT: { from: ['SUBMITTED', 'CHANGES_REQUESTED'], to: null },
  RESUBMIT: { from: ['CHANGES_REQUESTED'], to: 'SUBMITTED' },
  WITHDRAW: { from: OPEN, to: 'WITHDRAWN' },
  TAKE: { from: ['SUBMITTED'], to: 'IN_REVIEW' },
  REVIEW: { from: ['IN_REVIEW'], to: null },
  REQUEST_CHANGES: { from: ['IN_REVIEW'], to: 'CHANGES_REQUESTED' },
  APPROVE: { from: ['IN_REVIEW'], to: 'APPROVED' },
  REJECT: { from: OPEN, to: 'REJECTED' },
};

const REQUEST_ACTION_LABELS: Record<RequestAction, string> = {
  EDIT: 'editar',
  RESUBMIT: 'reenviar',
  WITHDRAW: 'retirar',
  TAKE: 'tomar',
  REVIEW: 'completar',
  REQUEST_CHANGES: 'pedir cambios en',
  APPROVE: 'aprobar',
  REJECT: 'rechazar',
};

export function isOpenRequest(status: string): boolean {
  return (OPEN as readonly string[]).includes(status);
}

/**
 * Estado al que lleva `action` desde `from` (el mismo si la acción no lo
 * cambia); 409 `TOK_REQUEST_INVALID_TRANSITION` si no se admite.
 */
export function nextRequestStatus(
  from: TokenizationRequestStatus,
  action: RequestAction,
): TokenizationRequestStatus {
  const rule = REQUEST_TRANSITIONS[action];
  if (!rule.from.includes(from)) {
    const to = rule.to ?? from;
    throw stateError(
      ErrorCode.TOK_REQUEST_INVALID_TRANSITION,
      `No se puede ${REQUEST_ACTION_LABELS[action]} una solicitud en estado ${from}`,
      [
        {
          field: null,
          code: ErrorCode.TOK_REQUEST_INVALID_TRANSITION,
          message: `La acción solo se admite desde ${rule.from.join(', ')}`,
          expected: [...rule.from],
          actual: from,
          meta: { from, to, action },
        },
      ],
    );
  }
  return rule.to ?? from;
}

export type CollectionAction = 'PUBLISH' | 'PAUSE' | 'RESUME' | 'CLOSE';

interface CollectionRule {
  from: readonly CollectionStatus[];
  to: CollectionStatus;
}

export const COLLECTION_TRANSITIONS: Record<CollectionAction, CollectionRule> =
  {
    PUBLISH: { from: ['READY'], to: 'PUBLISHED' },
    PAUSE: { from: ['PUBLISHED'], to: 'PAUSED' },
    RESUME: { from: ['PAUSED'], to: 'PUBLISHED' },
    CLOSE: { from: ['READY', 'PUBLISHED', 'PAUSED'], to: 'CLOSED' },
  };

const COLLECTION_ACTION_LABELS: Record<CollectionAction, string> = {
  PUBLISH: 'publicar',
  PAUSE: 'pausar',
  RESUME: 'reanudar',
  CLOSE: 'cerrar',
};

/** 409 `TOK_COLLECTION_INVALID_TRANSITION` si `action` no se admite desde `from`. */
export function nextCollectionStatus(
  from: CollectionStatus,
  action: CollectionAction,
): CollectionStatus {
  const rule = COLLECTION_TRANSITIONS[action];
  if (!rule.from.includes(from)) {
    throw stateError(
      ErrorCode.TOK_COLLECTION_INVALID_TRANSITION,
      `No se puede ${COLLECTION_ACTION_LABELS[action]} una colección en estado ${from}`,
      [
        {
          field: null,
          code: ErrorCode.TOK_COLLECTION_INVALID_TRANSITION,
          message: `La acción solo se admite desde ${rule.from.join(', ')}`,
          expected: [...rule.from],
          actual: from,
          meta: { from, to: rule.to, action },
        },
      ],
    );
  }
  return rule.to;
}

/**
 * Estado de venta (§6.2), derivado: `null` si no está `PUBLISHED`; agotada si
 * no queda ninguno disponible; preventa hasta el anclaje y venta después.
 */
export function saleState(collection: {
  status: string;
  redeemable: boolean;
  minted: number;
  available: number;
}): SaleState | null {
  if (collection.status !== 'PUBLISHED') return null;
  if (collection.minted > 0 && collection.available === 0) return 'SOLD_OUT';
  return collection.redeemable ? 'ON_SALE' : 'PRESALE';
}

/**
 * Marca de tokenización del lote (§5.3, `LotSummary.tokenization.state`): la
 * solicitud abierta manda sobre la colección (una ampliación en revisión se
 * ve como `REQUESTED`); sin solicitud abierta, el estado de la colección, con
 * `MINT_FAILED` si su última emisión falló.
 */
export function lotTokenizationState(
  openRequestStatus: string | null,
  collection: { status: string; mintStatus: string } | null,
): LotTokenizationState {
  if (openRequestStatus === 'CHANGES_REQUESTED') return 'CHANGES_REQUESTED';
  if (openRequestStatus !== null && isOpenRequest(openRequestStatus)) {
    return 'REQUESTED';
  }
  if (!collection) return 'NONE';
  if (collection.status === 'CLOSED') return 'CLOSED';
  if ((collection.mintStatus as MintStatus) === 'FAILED') return 'MINT_FAILED';
  return collection.status as CollectionStatus;
}
