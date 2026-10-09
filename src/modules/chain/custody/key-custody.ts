/**
 * Custodia de claves (contrato O3 §2.1, CHN-04). Interfaz única del firmante
 * con el custodio: la clave privada **nunca sale** de la implementación; el
 * resto del backend solo ve direcciones y firmas.
 *
 * Implementaciones:
 * - `LOCAL`: claves en memoria, generadas al pedirlas y descartadas al terminar
 *   el proceso (pruebas y red local).
 * - `ENV`: desarrollo y staging en testnet. Operaciones y anclaje en variables
 *   del entorno; las bodegas, derivadas con SEP-0005 de `CHAIN_DEV_WINERY_SEED`
 *   por `ChainAccount.derivationIndex` (S-1).
 * - `VAULT_TRANSIT` / `AWS_KMS`: producción (D7, sin decidir).
 *
 * No existe ninguna función `sign(xdr)` de uso general: `sign` solo la llama
 * el firmante del worker con el hash de una transacción que él mismo construyó
 * a partir de una intención validada (§2.2).
 */
export interface KeyCustody {
  readonly driver: 'ENV' | 'LOCAL' | 'DISABLED';

  /** Dirección `G…` de la clave `ref`. Falla si no existe. */
  publicKey(ref: string): Promise<string>;

  /** Firma Ed25519 de 64 bytes de `payload` con la clave `ref`. */
  sign(ref: string, payload: Uint8Array): Promise<Uint8Array>;

  /** Crea la clave si no existe (bodegas nuevas) y devuelve su dirección. */
  ensureKey(ref: string): Promise<string>;
}

export const KEY_CUSTODY = Symbol('KEY_CUSTODY');

export type CustodyErrorCode =
  /** La cadena está deshabilitada (sin `CHAIN_CUSTODY_DRIVER`). */
  | 'CUSTODY_DISABLED'
  /** La referencia no es de ninguna clave conocida. */
  | 'CUSTODY_KEY_NOT_FOUND'
  /** Falta el secreto o la semilla de esa clave en el entorno. */
  | 'CUSTODY_SECRET_MISSING'
  /** La bodega aún no tiene índice de derivación (`chain_accounts`). */
  | 'CUSTODY_INDEX_NOT_ALLOCATED'
  /** Esa clave no firma (p. ej. la semilla maestra de consumidores). */
  | 'CUSTODY_KEY_NOT_SIGNABLE';

/** Error del custodio. Su mensaje nunca lleva material de claves. */
export class CustodyError extends Error {
  constructor(
    public readonly code: CustodyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CustodyError';
  }
}

/** Custodio de una instalación sin cadena configurada: no tiene claves. */
export class DisabledKeyCustody implements KeyCustody {
  readonly driver = 'DISABLED' as const;

  private disabled<T>(): Promise<T> {
    return Promise.reject(
      new CustodyError(
        'CUSTODY_DISABLED',
        'La cadena está deshabilitada: define CHAIN_CUSTODY_DRIVER y STELLAR_RPC_URL',
      ),
    );
  }

  publicKey(): Promise<string> {
    return this.disabled();
  }

  sign(): Promise<Uint8Array> {
    return this.disabled();
  }

  ensureKey(): Promise<string> {
    return this.disabled();
  }
}
