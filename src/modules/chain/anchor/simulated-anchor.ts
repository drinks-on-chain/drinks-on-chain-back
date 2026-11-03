import { createHash } from 'crypto';
import { Keypair } from '@stellar/stellar-sdk';

/**
 * Identidad fija del anclaje simulado (`ANCHOR_LEDGER=SIMULATED`). Nada de
 * esto existe en ninguna red: sirve para que el ERP, el back office y el
 * pasaporte muestren un anclaje completo con datos coherentes, y para que el
 * anclaje real lo reconozca y lo sustituya cuando se habilite.
 */

/** Red con la que se guardan los anclajes simulados (la de los esquemas: `LOCAL`). */
export const SIMULATED_ANCHOR_NETWORK = 'LOCAL' as const;

/**
 * Cuenta de anclaje simulada: una dirección `G…` válida derivada de una
 * semilla pública y fija. **No tiene clave secreta en uso ni fondos.**
 */
export const SIMULATED_ANCHOR_ACCOUNT = Keypair.fromRawEd25519Seed(
  createHash('sha256').update('drinks-on-chain/simulated-anchor/v1').digest(),
).publicKey();

/** Prefijo de la intención simulada: no choca con `anchor:{lotId}` del anclaje real. */
export const SIMULATED_INTENT_PREFIX = 'simulated-anchor:';

export const simulatedIntentKey = (lotId: string): string =>
  `${SIMULATED_INTENT_PREFIX}${lotId}`;

/** Hash de transacción simulado: determinista por lote y huella (64 hex). */
export function simulatedTxHash(lotId: string, memoHashHex: string): string {
  return createHash('sha256')
    .update(`drinks-on-chain/simulated-anchor-tx|${lotId}|${memoHashHex}`)
    .digest('hex');
}

/** ¿Es un anclaje simulado? (por su cuenta de anclaje, que es fija). */
export function isSimulatedAnchor(
  row: { account: string } | null | undefined,
): boolean {
  return row?.account === SIMULATED_ANCHOR_ACCOUNT;
}
