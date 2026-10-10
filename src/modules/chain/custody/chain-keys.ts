import { randomBytes } from 'crypto';
import { Keypair } from '@stellar/stellar-sdk';
import { deriveSep5Address, masterSeedFromSecret, sep5Path } from './sep5';

/**
 * Secretos del custodio `ENV` (contrato O3 §2.1): generación en el propio
 * entorno y lectura de sus direcciones públicas. Lo usa
 * `deploy/dev/generar-claves-cadena.sh` a través de `dist/scripts/chain-keys.js`.
 *
 * Nada de aquí escribe un secreto en un log: `generate` devuelve las líneas
 * para el `.env` (el script las redirige al archivo, nunca a la pantalla) y
 * `addresses` solo devuelve direcciones `G…`.
 */

export const CHAIN_SECRET_NAMES = [
  'CHAIN_SECRET_OPERATIONS',
  'CHAIN_SECRET_ANCHOR',
  'CHAIN_DEV_WINERY_SEED',
  'CHAIN_CONSUMER_MASTER_SEED',
] as const;
export type ChainSecretName = (typeof CHAIN_SECRET_NAMES)[number];

/** Bytes de una semilla maestra SEP-0005 (64 caracteres hexadecimales). */
const MASTER_SEED_BYTES = 32;

export function isChainSecretName(value: string): value is ChainSecretName {
  return (CHAIN_SECRET_NAMES as readonly string[]).includes(value);
}

/**
 * Valor nuevo de un secreto: una semilla `S…` de 56 caracteres para las
 * cuentas de operaciones y de anclaje; 32 bytes aleatorios en hexadecimal
 * para las semillas maestras.
 */
export function generateChainSecret(name: ChainSecretName): string {
  return name === 'CHAIN_SECRET_OPERATIONS' || name === 'CHAIN_SECRET_ANCHOR'
    ? Keypair.random().secret()
    : randomBytes(MASTER_SEED_BYTES).toString('hex');
}

/** Líneas `NOMBRE=valor` para añadir al `.env` (una por secreto pedido). */
export function generateChainEnvLines(names: readonly string[]): string[] {
  return names.map((name) => {
    if (!isChainSecretName(name)) {
      throw new Error(`No es un secreto de la cadena: ${name}`);
    }
    return `${name}=${generateChainSecret(name)}`;
  });
}

/** Lee `NOMBRE=valor` de un `.env` (sin ejecutarlo): la última gana. */
export function parseEnvLines(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    values.set(match[1], match[2].replace(/^(['"])(.*)\1$/, '$2'));
  }
  return values;
}

export interface ChainPublicAddresses {
  /** Cuenta de operaciones (`G…`): paga comisiones y renta, opera y despliega. */
  operations: string | null;
  /** Cuenta de anclaje (`G…`). */
  anchor: string | null;
  /** Primera clave de bodega (`m/44'/148'/0'`), para reconocer la semilla. */
  firstWinery: { path: string; address: string } | null;
  /** Índice 0 de la semilla de consumidores: `CHAIN_CONSUMER_SEED_CHECK_ADDRESS`. */
  consumerSeedCheck: { path: string; address: string } | null;
}

/**
 * Direcciones públicas de los secretos de un `.env`. Un secreto ausente, sin
 * rellenar (`change-me`) o mal formado da `null`; nunca se devuelve su valor.
 */
export function chainPublicAddresses(
  env: ReadonlyMap<string, string>,
): ChainPublicAddresses {
  const filled = (name: ChainSecretName): string | null => {
    const value = env.get(name)?.trim();
    return value && value !== 'change-me' ? value : null;
  };
  const account = (name: ChainSecretName): string | null => {
    const secret = filled(name);
    if (!secret) return null;
    try {
      return Keypair.fromSecret(secret).publicKey();
    } catch {
      return null;
    }
  };
  const derived = (
    name: ChainSecretName,
  ): { path: string; address: string } | null => {
    const seed = filled(name);
    if (!seed) return null;
    try {
      return {
        path: sep5Path(0),
        address: deriveSep5Address(masterSeedFromSecret(seed), 0),
      };
    } catch {
      return null;
    }
  };
  return {
    operations: account('CHAIN_SECRET_OPERATIONS'),
    anchor: account('CHAIN_SECRET_ANCHOR'),
    firstWinery: derived('CHAIN_DEV_WINERY_SEED'),
    consumerSeedCheck: derived('CHAIN_CONSUMER_MASTER_SEED'),
  };
}
