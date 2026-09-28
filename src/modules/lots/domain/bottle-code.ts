import { randomBytes, randomInt } from 'node:crypto';

/**
 * Códigos de botella (contrato O2 §7.1, A-26): 8 caracteres del alfabeto
 * Crockford (sin I, L, O, U): 7 aleatorios con generador criptográfico
 * (32⁷ ≈ 3,4 × 10¹⁰) + 1 de control Luhn mod 32 sobre los 7 anteriores
 * (detecta cualquier error de un carácter y casi todas las transposiciones).
 */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const BASE = CROCKFORD_ALPHABET.length; // 32
export const BOTTLE_CODE_LENGTH = 8;

function codePoint(char: string): number {
  const index = CROCKFORD_ALPHABET.indexOf(char);
  if (index < 0) throw new Error(`Carácter fuera del alfabeto: ${char}`);
  return index;
}

/** Carácter de control Luhn mod 32 de `payload` (7 caracteres del alfabeto). */
export function luhnMod32CheckChar(payload: string): string {
  let factor = 2;
  let sum = 0;
  for (let i = payload.length - 1; i >= 0; i--) {
    let addend = factor * codePoint(payload[i]);
    factor = factor === 2 ? 1 : 2;
    addend = Math.floor(addend / BASE) + (addend % BASE);
    sum += addend;
  }
  return CROCKFORD_ALPHABET[(BASE - (sum % BASE)) % BASE];
}

/** ¿El último carácter es el control Luhn mod 32 de los anteriores? */
export function hasValidCheckChar(code: string): boolean {
  let factor = 1;
  let sum = 0;
  for (let i = code.length - 1; i >= 0; i--) {
    const index = CROCKFORD_ALPHABET.indexOf(code[i]);
    if (index < 0) return false;
    let addend = factor * index;
    factor = factor === 2 ? 1 : 2;
    addend = Math.floor(addend / BASE) + (addend % BASE);
    sum += addend;
  }
  return sum % BASE === 0;
}

/** Código nuevo (7 aleatorios + control). */
export function generateBottleCode(): string {
  let payload = '';
  for (let i = 0; i < BOTTLE_CODE_LENGTH - 1; i++) {
    payload += CROCKFORD_ALPHABET[randomInt(BASE)];
  }
  return payload + luhnMod32CheckChar(payload);
}

/** Sal aleatoria de la hoja Merkle del expediente (16 bytes en hex, §10). */
export function generateBottleSalt(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Normalización al leer (§7.1): mayúsculas, sin espacios ni guiones,
 * `O → 0`, `I`/`L → 1`.
 */
export function normalizeBottleCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]+/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

/** ¿Es un código de botella con forma y control válidos (tras normalizar)? */
export function isValidBottleCode(normalized: string): boolean {
  return (
    normalized.length === BOTTLE_CODE_LENGTH &&
    [...normalized].every((c) => CROCKFORD_ALPHABET.includes(c)) &&
    hasValidCheckChar(normalized)
  );
}

/** `XXXX-XXXX` para imprimir. */
export function formatBottleCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
