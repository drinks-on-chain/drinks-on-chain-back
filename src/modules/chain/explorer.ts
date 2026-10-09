/**
 * Enlaces al explorador (contrato O3 §0): los construye **el backend** con
 * `STELLAR_EXPLORER_BASE_URL` y los devuelve en cada `explorerUrl`; las apps
 * nunca escriben el host. Sin explorador configurado (red local) → `null`.
 */

const TX_HASH = /^[0-9a-f]{64}$/;
const ACCOUNT = /^G[A-Z2-7]{55}$/;
const CONTRACT = /^C[A-Z2-7]{55}$/;

const join = (base: string | null, path: string): string | null =>
  base ? `${base.replace(/\/+$/, '')}/${path}` : null;

/** `{base}/tx/{hash}`; `null` sin hash (aún no firmada) o si no es un hash. */
export function explorerTxUrl(
  base: string | null,
  txHash: string | null | undefined,
): string | null {
  return txHash && TX_HASH.test(txHash) ? join(base, `tx/${txHash}`) : null;
}

/** `{base}/account/{G…}`. */
export function explorerAccountUrl(
  base: string | null,
  address: string | null | undefined,
): string | null {
  return address && ACCOUNT.test(address)
    ? join(base, `account/${address}`)
    : null;
}

/** `{base}/contract/{C…}`. */
export function explorerContractUrl(
  base: string | null,
  address: string | null | undefined,
): string | null {
  return address && CONTRACT.test(address)
    ? join(base, `contract/${address}`)
    : null;
}

/**
 * Memo del anclaje (§7.1): los 32 bytes del SHA-256 del expediente, en hex
 * (como lo guarda `lot_dossiers.hash`) y en base64 (como lo muestra un
 * explorador).
 */
export function memoHashFromHex(hashHex: string): {
  bytes: Buffer;
  hex: string;
  base64: string;
} {
  const hex = hashHex.trim().toLowerCase();
  if (!TX_HASH.test(hex)) {
    throw new RangeError('El hash del expediente debe ser un SHA-256 en hex');
  }
  const bytes = Buffer.from(hex, 'hex');
  return { bytes, hex, base64: bytes.toString('base64') };
}
