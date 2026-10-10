import type { Prisma, PrismaClient } from '@prisma/client';
import type {
  ChainIdentityStatus,
  ChainNetwork,
} from '@modules/chain/chain.constants';
import type { WineryChainIdentityDto } from '@modules/chain/dto/chain.dto';

/**
 * Puerto de la tokenización hacia la cadena (contrato O3 §3.1 y §6.1). La
 * tokenización no depende del módulo `chain` ni de la red: pregunta por este
 * puerto si la identidad de la bodega está lista y deja registrada la
 * intención de emitir. Lo cumple `ChainTokenizationAdapter`, sobre el núcleo
 * del módulo `chain` (identidad e intenciones por el outbox).
 */
export const TOKENIZATION_CHAIN_PORT = Symbol('TOKENIZATION_CHAIN_PORT');

/** Cliente de la API o de una transacción. */
export type ChainPortClient = PrismaClient | Prisma.TransactionClient;

/** Contrato vigente de la bodega (`nft_contracts`), ya desplegado. */
export interface WineryChainContractRef {
  /** `nft_contracts.id`: lo que guarda `collections.contract_id`. */
  id: string;
  /** StrKey `C…`. */
  address: string;
  paused: boolean;
}

/** Lo que la tokenización necesita saber de la identidad de la bodega. */
export interface WineryChainReadiness {
  wineryId: string;
  network: ChainNetwork;
  status: ChainIdentityStatus;
  /** `status === 'ACTIVE'` con cuenta y contrato confirmados: se puede aprobar y emitir. */
  ready: boolean;
  /** Cuenta de la bodega (`G…`): destino de la emisión (`to`, A-02). */
  accountAddress: string | null;
  contract: WineryChainContractRef | null;
}

/** Un `mint_batch` (trozo de hasta 32 000, DS-13) de una emisión. */
export interface MintIntentChunk {
  /** 1, 2…: orden de envío. */
  index: number;
  amount: number;
  firstBottleNumber: number;
  lastBottleNumber: number;
  /** Idempotencia de la intención: `mint:{mintId}:{index}` (`chain_transactions.intent_key`). */
  intentKey: string;
}

/** Emisión aprobada: lo necesario para registrar sus intenciones `MINT_BATCH`. */
export interface MintIntentRequest {
  mintId: string;
  requestId: string;
  collectionId: string;
  wineryId: string;
  lotId: string;
  network: ChainNetwork;
  /** `nft_contracts.id` y su dirección `C…`. */
  contractId: string;
  contractAddress: string;
  /** Cuenta de la bodega: dueña inicial de los NFT. */
  toAddress: string;
  /** Argumento `lot` de `mint_batch`: la referencia del lote (S-12). */
  lotArg: string;
  quantity: number;
  chunks: MintIntentChunk[];
  /** Quién aprobó (`null` si se autoaprobó, S-11). */
  requestedBy: {
    userId: string | null;
    fullName: string | null;
    /** `WORKER` cuando la registra el procesador del outbox. */
    source?: 'API' | 'WORKER';
  };
}

export interface TokenizationChainPort {
  /**
   * Identidad de la bodega en la red. Se llama dentro de la transacción de
   * la aprobación (y de publicar o reanudar) para decidir 409
   * `TOK_WINERY_CHAIN_NOT_READY` o `CHN_CONTRACT_PAUSED`; nunca habla con la
   * red.
   */
  wineryIdentity(
    client: ChainPortClient,
    wineryId: string,
  ): Promise<WineryChainReadiness>;

  /** Identidad completa (§3.1) para `review.chainIdentity` de la bandeja. */
  wineryIdentityView(
    client: ChainPortClient,
    wineryId: string,
  ): Promise<WineryChainIdentityDto>;

  /**
   * Registra las intenciones `MINT_BATCH` de una emisión recién aprobada, en
   * la misma transacción `tx` que crea la colección y el `Mint` (si falla,
   * no hay aprobación). No envía nada: el worker las firma después. Debe ser
   * idempotente por `chunk.intentKey`.
   */
  registerMintIntents(
    tx: Prisma.TransactionClient,
    request: MintIntentRequest,
  ): Promise<void>;
}

/** `mint:{mintId}:{index}`: clave de la intención de un trozo. */
export function mintIntentKey(mintId: string, index: number): string {
  return `mint:${mintId}:${index}`;
}
