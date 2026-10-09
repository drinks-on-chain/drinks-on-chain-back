import type { ChainNetwork } from '@modules/chain/chain.constants';
import type { TokenizationRequestKind } from './tokenization.constants';

/**
 * Eventos del outbox que publica la tokenización (contrato O3 §11). Cargas
 * mínimas: identificadores y cifras, sin datos personales.
 */

export const TOKENIZATION_REQUEST_AGGREGATE = 'tokenization_request';
export const COLLECTION_AGGREGATE = 'collection';

export const TOKENIZATION_REQUEST_SUBMITTED = 'tokenization.request_submitted';
export const TOKENIZATION_REQUEST_CHANGES_REQUESTED =
  'tokenization.request_changes_requested';
export const TOKENIZATION_REQUEST_REJECTED = 'tokenization.request_rejected';

export type TokenizationRequestEventPayload = {
  requestId: string;
  wineryId: string;
  lotId: string;
  kind: string;
  quantity: number;
  /** Envío nuevo o reenvío tras los cambios pedidos (solo en `submitted`). */
  resubmitted?: boolean;
};

/**
 * Solicitud aprobada: la colección existe (o su cuota se amplió) y hay un
 * `Mint` `PENDING`. Va por la cola `chain`: quien lo consume (paso 3.4)
 * registra una intención `MINT_BATCH` por trozo con su `intentKey` (idempotente)
 * si el puerto no las registró ya dentro de la transacción de la aprobación.
 */
export const TOKENIZATION_REQUEST_APPROVED = 'tokenization.request_approved';

export type TokenizationRequestApprovedPayload = {
  requestId: string;
  wineryId: string;
  lotId: string;
  collectionId: string;
  mintId: string;
  kind: TokenizationRequestKind;
  /** NFT de esta emisión y cuota total de la colección tras aprobarse. */
  quantity: number;
  resultingQuota: number;
  /** 1 = emisión inicial; 2… = ampliaciones. */
  mintSequence: number;
  network: ChainNetwork;
  /** `nft_contracts.id` y su dirección `C…`. */
  contractId: string;
  contractAddress: string;
  /** Cuenta de la bodega (`G…`): destino de la emisión. */
  toAddress: string;
  /** Argumento `lot` de `mint_batch`: la referencia del lote (S-12). */
  lotArg: string;
  publishOnMint: boolean;
  /** `true` si se autoaprobó (`tokenizacion.requiereAprobacion = false`, S-11). */
  approvedBySystem: boolean;
  approvedByUserId: string | null;
  /** Un `mint_batch` por trozo de hasta 32 000, en orden. */
  chunks: {
    index: number;
    amount: number;
    firstBottleNumber: number;
    lastBottleNumber: number;
    /** `mint:{mintId}:{index}` */
    intentKey: string;
  }[];
};

export const COLLECTION_PUBLISHED = 'collection.published';
export const COLLECTION_PAUSED = 'collection.paused';
export const COLLECTION_RESUMED = 'collection.resumed';
export const COLLECTION_CLOSED = 'collection.closed';

export type CollectionEventPayload = {
  collectionId: string;
  wineryId: string;
  lotId: string;
  slug: string;
  status: string;
  /** Lo hizo el sistema (bodega suspendida o revocada). */
  system: boolean;
};

/** Una emisión terminó de confirmarse en la red (todos sus trozos, §6.1). */
export const COLLECTION_MINTED = 'collection.minted';

export type CollectionMintedPayload = {
  collectionId: string;
  wineryId: string;
  lotId: string;
  mintId: string;
  /** 1 = emisión inicial; 2… = ampliaciones. */
  mintSequence: number;
  /** NFT de esta emisión y total emitido de la colección. */
  quantity: number;
  minted: number;
  status: string;
};

/** El expediente del lote quedó anclado: sus NFT vendidos ya se canjean (§7.2). */
export const COLLECTION_REDEEMABLE = 'collection.redeemable';

export type CollectionRedeemablePayload = {
  collectionId: string;
  wineryId: string;
  lotId: string;
  redeemableSince: string;
  /** NFT que pasaron de `SOLD` a `REDEEMABLE`. */
  tokens: number;
};
