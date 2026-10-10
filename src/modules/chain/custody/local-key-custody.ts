import { Keypair } from '@stellar/stellar-sdk';
import { CustodyError, KeyCustody } from './key-custody';

/**
 * Custodio `LOCAL` (contrato O3 §2.1, "Pruebas"): claves en memoria, creadas
 * con `ensureKey` y descartadas al terminar el proceso. Para las pruebas y la
 * red local (`stellar/quickstart`); nunca para datos que deban sobrevivir.
 */
export class LocalKeyCustody implements KeyCustody {
  readonly driver = 'LOCAL' as const;

  private readonly keys = new Map<string, Keypair>();

  private require(ref: string): Keypair {
    const keypair = this.keys.get(ref);
    if (!keypair) {
      throw new CustodyError(
        'CUSTODY_KEY_NOT_FOUND',
        `No hay ninguna clave con la referencia ${ref}`,
      );
    }
    return keypair;
  }

  publicKey(ref: string): Promise<string> {
    return this.attempt(() => this.require(ref).publicKey());
  }

  sign(ref: string, payload: Uint8Array): Promise<Uint8Array> {
    return this.attempt(
      () => new Uint8Array(this.require(ref).sign(Buffer.from(payload))),
    );
  }

  ensureKey(ref: string): Promise<string> {
    let keypair = this.keys.get(ref);
    if (!keypair) {
      keypair = Keypair.random();
      this.keys.set(ref, keypair);
    }
    return Promise.resolve(keypair.publicKey());
  }

  private attempt<T>(work: () => T): Promise<T> {
    try {
      return Promise.resolve(work());
    } catch (error) {
      return Promise.reject(error as Error);
    }
  }
}
