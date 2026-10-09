import { Keypair } from '@stellar/stellar-sdk';
import {
  CUSTODY_REF_ANCHOR,
  CUSTODY_REF_CONSUMER_SEED,
  CUSTODY_REF_OPERATIONS,
} from '../chain.constants';
import { CustodyError, KeyCustody } from './key-custody';
import { deriveSep5Keypair, masterSeedFromSecret } from './sep5';

/** Secretos del custodio `ENV`, tal como llegan del entorno. */
export interface EnvCustodySecrets {
  /** `CHAIN_SECRET_OPERATIONS` (semilla `S…`). */
  operations?: string | null;
  /** `CHAIN_SECRET_ANCHOR` (semilla `S…`). */
  anchor?: string | null;
  /** `CHAIN_DEV_WINERY_SEED` (semilla maestra SEP-0005 de las bodegas). */
  winerySeed?: string | null;
}

/**
 * Índice de derivación de la clave de una bodega: lo guarda
 * `chain_accounts.derivation_index` (el paso 3.1 lo asigna al crear la fila,
 * antes de llamar a `ensureKey`). `null` = sin asignar.
 */
export type DerivationIndexLookup = (ref: string) => Promise<number | null>;

/**
 * Asigna a la fila de `ref` el siguiente índice libre de su red (único y
 * nunca reutilizado) y lo devuelve; `null` si esa cuenta no está registrada.
 */
export type DerivationIndexAllocator = (ref: string) => Promise<number | null>;

const WINERY_REF = /^winery-[0-9a-f-]{36}$/;

/**
 * Custodio `ENV` (contrato O3 §2.1; decisión del 08-10-2026: **solo testnet y
 * red local**). Las claves de operaciones y anclaje son secretos del entorno;
 * las de las bodegas se derivan de una semilla de desarrollo con SEP-0005,
 * porque un driver de variables de entorno no puede guardar una clave nueva
 * por bodega (S-1). Ninguna clave se guarda en la base ni se escribe en un log.
 *
 * Solo resuelve claves y firma el *payload* que le pasa el firmante del
 * worker (`jobs/signer/chain-signer.service.ts`); no construye ni envía nada.
 */
export class EnvKeyCustody implements KeyCustody {
  readonly driver = 'ENV' as const;

  constructor(
    private readonly secrets: EnvCustodySecrets,
    private readonly derivationIndexOf: DerivationIndexLookup,
    private readonly allocateIndex: DerivationIndexAllocator = () =>
      Promise.resolve(null),
  ) {}

  async publicKey(ref: string): Promise<string> {
    return (await this.keypair(ref)).publicKey();
  }

  async sign(ref: string, payload: Uint8Array): Promise<Uint8Array> {
    const keypair = await this.keypair(ref);
    return new Uint8Array(keypair.sign(Buffer.from(payload)));
  }

  /**
   * Las claves de este driver existen por configuración (o por derivación):
   * "crear" la de una bodega es asegurar que su cuenta tiene índice de
   * derivación (lo asigna si falta) y devolver su dirección.
   */
  async ensureKey(ref: string): Promise<string> {
    if (WINERY_REF.test(ref) && (await this.derivationIndexOf(ref)) === null) {
      await this.allocateIndex(ref);
    }
    return this.publicKey(ref);
  }

  private async keypair(ref: string): Promise<Keypair> {
    if (ref === CUSTODY_REF_OPERATIONS) {
      return this.fromSecret(
        this.secrets.operations,
        'CHAIN_SECRET_OPERATIONS',
      );
    }
    if (ref === CUSTODY_REF_ANCHOR) {
      return this.fromSecret(this.secrets.anchor, 'CHAIN_SECRET_ANCHOR');
    }
    if (ref === CUSTODY_REF_CONSUMER_SEED) {
      throw new CustodyError(
        'CUSTODY_KEY_NOT_SIGNABLE',
        'La semilla maestra de consumidores no firma ni tiene dirección propia',
      );
    }
    if (WINERY_REF.test(ref)) {
      const seed = this.secrets.winerySeed?.trim();
      if (!seed) {
        throw new CustodyError(
          'CUSTODY_SECRET_MISSING',
          'Falta CHAIN_DEV_WINERY_SEED en el entorno',
        );
      }
      const index = await this.derivationIndexOf(ref);
      if (index === null) {
        throw new CustodyError(
          'CUSTODY_INDEX_NOT_ALLOCATED',
          `La clave ${ref} no tiene índice de derivación asignado`,
        );
      }
      return deriveSep5Keypair(masterSeedFromSecret(seed), index);
    }
    throw new CustodyError(
      'CUSTODY_KEY_NOT_FOUND',
      `No hay ninguna clave con la referencia ${ref}`,
    );
  }

  private fromSecret(secret: string | null | undefined, name: string): Keypair {
    const value = secret?.trim();
    if (!value) {
      throw new CustodyError(
        'CUSTODY_SECRET_MISSING',
        `Falta ${name} en el entorno`,
      );
    }
    try {
      return Keypair.fromSecret(value);
    } catch {
      // Sin el error original: su mensaje podría repetir el valor
      throw new CustodyError(
        'CUSTODY_SECRET_MISSING',
        `${name} no es una semilla válida`,
      );
    }
  }
}
