import { createHmac, pbkdf2Sync } from 'crypto';
import { Keypair } from '@stellar/stellar-sdk';

/**
 * Derivación de claves de SEP-0005 (SLIP-0010 sobre Ed25519, solo rutas
 * endurecidas): `m/44'/148'/{index}'`. Se usa para las claves de las bodegas
 * del custodio `ENV` (S-1) y para las direcciones custodiales de los
 * consumidores (§4). Quien llama recibe un `Keypair`; nada de aquí escribe en
 * un log.
 */

const HARDENED_OFFSET = 0x80000000;
const ED25519_CURVE = 'ed25519 seed';
/** `44'` (BIP-44) y `148'` (tipo de moneda de Stellar). */
const STELLAR_PATH_PREFIX = [44, 148] as const;

export const sep5Path = (index: number) => `m/44'/148'/${index}'`;

interface Node {
  key: Buffer;
  chainCode: Buffer;
}

function master(seed: Buffer): Node {
  const digest = createHmac('sha512', ED25519_CURVE).update(seed).digest();
  return { key: digest.subarray(0, 32), chainCode: digest.subarray(32) };
}

function hardenedChild(parent: Node, index: number): Node {
  const data = Buffer.alloc(37);
  data[0] = 0;
  parent.key.copy(data, 1);
  data.writeUInt32BE(index + HARDENED_OFFSET, 33);
  const digest = createHmac('sha512', parent.chainCode).update(data).digest();
  return { key: digest.subarray(0, 32), chainCode: digest.subarray(32) };
}

/**
 * Semilla maestra en bytes: hexadecimal (32–64 bytes) tal cual, o una frase
 * mnemónica BIP-39 (PBKDF2-HMAC-SHA512, 2048 vueltas, sal `mnemonic`). La
 * lista de palabras no se valida: la frase la genera y la guarda el entorno.
 */
export function masterSeedFromSecret(secret: string): Buffer {
  const trimmed = secret.trim();
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
    return Buffer.from(trimmed, 'hex');
  }
  const mnemonic = trimmed.split(/\s+/).join(' ').normalize('NFKD');
  return pbkdf2Sync(mnemonic, 'mnemonic', 2048, 64, 'sha512');
}

/** Par de claves de `m/44'/148'/{index}'`. */
export function deriveSep5Keypair(seed: Buffer, index: number): Keypair {
  if (!Number.isInteger(index) || index < 0 || index >= HARDENED_OFFSET) {
    throw new RangeError('Índice de derivación fuera de rango');
  }
  let node = master(seed);
  for (const segment of [...STELLAR_PATH_PREFIX, index]) {
    node = hardenedChild(node, segment);
  }
  return Keypair.fromRawEd25519Seed(node.key);
}

/** Dirección `G…` de `m/44'/148'/{index}'` (lo único que guarda el backend). */
export function deriveSep5Address(seed: Buffer, index: number): string {
  return deriveSep5Keypair(seed, index).publicKey();
}
