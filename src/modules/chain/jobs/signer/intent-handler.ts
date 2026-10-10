import type { ChainTransaction, Prisma } from '@prisma/client';
import type { xdr } from '@stellar/stellar-sdk';
import type { ChainSettings } from '../../chain.config';
import type { ChainSignerRole, ChainTxKind } from '../../chain.constants';
import type { ChainTxFailure } from '../../tx/chain-tx.errors';
import type { ChainGateway, TxLookup } from '../gateway/chain-gateway';

/**
 * Lo que un manejador de intención puede pedir al custodio: direcciones.
 * **No puede firmar**: la firma solo la pide el firmante (`ChainSigner`) con
 * el hash de la transacción que él mismo construyó.
 */
export interface KeyDirectory {
  publicKey(ref: string): Promise<string>;
  ensureKey(ref: string): Promise<string>;
}

export interface IntentEnv {
  settings: ChainSettings;
  gateway: ChainGateway;
  keys: KeyDirectory;
  /** Cuenta de operaciones (`G…`): paga, opera y despliega. */
  operationsAddress: string;
}

/** Quién firma además de la cuenta de origen: siempre una clave custodiada. */
export interface SignerSpec {
  role: ChainSignerRole;
  /** Referencia en el custodio (`winery-{id}`…). */
  ref: string;
  address: string;
  wineryId: string | null;
}

export type PreparedIntent =
  /**
   * La red ya tiene el efecto (idempotencia): se confirma sin enviar nada.
   * Con `txHash` (un intento anterior de esta misma intención que sí entró),
   * el firmante lee esa transacción y la confirma con sus datos.
   */
  | { type: 'ALREADY_DONE'; note: string; txHash?: string }
  /** Transacción clásica; `extraSigners` firman el sobre junto al origen. */
  | {
      type: 'CLASSIC';
      operations: xdr.Operation[];
      extraSigners: SignerSpec[];
      /** `MEMO_HASH`: 32 bytes en hex (anclaje del expediente, §7.1). */
      memoHashHex?: string;
    }
  /**
   * Una operación de Soroban; `authSigners` son las únicas direcciones cuya
   * entrada de autorización se firma (firma separada del sobre, S-3).
   */
  | {
      type: 'SOROBAN';
      operation: xdr.Operation;
      authSigners: SignerSpec[];
      /** Tope de comisión propio de esta intención (si no, el general). */
      maxFeeStroops?: string;
    }
  /** Friendbot: no firma nada. */
  | { type: 'FRIENDBOT'; address: string };

export type ConfirmedLookup = Extract<TxLookup, { status: 'SUCCESS' }>;

/**
 * Manejador de un tipo de intención (contrato O3 §2.2). El firmante solo
 * acepta los tipos que tienen manejador; cada uno:
 *
 * 1. **valida** la intención contra la base con la fila del sujeto bloqueada
 *    (si no cuadra lanza `IntentRejected`: nunca se firma);
 * 2. **prepara** las operaciones leyendo de la base y de la red (nunca de un
 *    XDR recibido de fuera);
 * 3. tras la confirmación, puede **leer de vuelta** la red y aplicar sus
 *    efectos en la misma transacción de base de datos que confirma.
 */
export interface IntentHandler<TPlan = unknown, TVerification = unknown> {
  readonly kind: ChainTxKind;
  /** Cuenta que origina y paga el sobre; `null` si la intención no firma. */
  readonly source: 'OPERATIONS' | 'ANCHOR' | null;

  validate(
    db: Prisma.TransactionClient,
    transaction: ChainTransaction,
    env: IntentEnv,
  ): Promise<TPlan>;

  prepare(
    plan: TPlan,
    transaction: ChainTransaction,
    env: IntentEnv,
  ): Promise<PreparedIntent>;

  /**
   * Lectura de vuelta en la red antes de dar la transacción por confirmada.
   * `lookup` es la transacción tal como quedó en la red (`null` si la
   * intención se dio por hecha sin enviar nada).
   */
  verify?(
    transaction: ChainTransaction,
    env: IntentEnv,
    lookup: ConfirmedLookup | null,
  ): Promise<TVerification>;

  onConfirmed?(
    db: Prisma.TransactionClient,
    transaction: ChainTransaction,
    verification: TVerification | undefined,
    env: IntentEnv,
  ): Promise<void>;

  /** La transacción pasó a `FAILED` (definitivo o reintentos agotados). */
  onFailed?(
    db: Prisma.TransactionClient,
    transaction: ChainTransaction,
    failure: ChainTxFailure,
  ): Promise<void>;
}

export const INTENT_HANDLERS = Symbol('INTENT_HANDLERS');
