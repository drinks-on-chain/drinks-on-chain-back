import { Prisma } from '@prisma/client';

/**
 * Saneado de los valores "antes" y "después" de la bitácora (AUD-01: sin datos
 * sensibles) y conversión a JSON puro (fechas ISO, decimales y enteros
 * grandes como texto), de modo que lo que se guarda en `jsonb` y lo que se
 * usó para el hash sean exactamente lo mismo.
 */

export const REDACTED = '[REDACTED]';

/** Claves exactas (normalizadas: minúsculas sin `_` ni `-`). */
const SENSITIVE_EXACT = new Set([
  'pin',
  'pinhash',
  'cvv',
  'cvc',
  'cardnumber',
  'creditcardnumber',
  'iban',
  'authorization',
  'cookie',
  'setcookie',
  'otp',
  'totp',
  'totpsecret',
  'recoverycodes',
  'mnemonic',
  'seed',
]);

/** Terminaciones sensibles: `password`, `passwordHash`, `accessToken`… */
const SENSITIVE_SUFFIXES = [
  'password',
  'passwordhash',
  'passwd',
  'secret',
  'secretkey',
  'privatekey',
  'token',
  'tokenhash',
  'apikey',
  'signature',
  'credentials',
];

/** Semilla secreta de Stellar (S + 55 caracteres base32). */
const STELLAR_SECRET = /^S[A-Z2-7]{55}$/;

/** Profundidad máxima que se conserva; más abajo se resume. */
const MAX_DEPTH = 8;

export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, '');
  if (SENSITIVE_EXACT.has(normalized)) return true;
  return SENSITIVE_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function isDecimalLike(value: object): value is { toFixed(): string } {
  return Prisma.Decimal.isDecimal(value);
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case 'string':
      // jsonb no admite \u0000
      if (STELLAR_SECRET.test(value)) return REDACTED;
      return value.includes('\u0000') ? value.split('\u0000').join('') : value;
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'object':
      break;
    default:
      return null; // funciones, símbolos
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return `[binary ${value.byteLength} bytes]`;
  }
  if (isDecimalLike(value)) {
    return value.toFixed();
  }
  if (depth >= MAX_DEPTH) {
    return '[truncated]';
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (inner === undefined) continue;
    out[key] = isSensitiveKey(key) ? REDACTED : sanitizeValue(inner, depth + 1);
  }
  return out;
}

/**
 * Devuelve una copia JSON-segura de `data` con los campos sensibles
 * sustituidos por `[REDACTED]`. `null`/`undefined` → `null`. Un valor que no
 * es un objeto se guarda como `{ value }`.
 */
export function sanitizeAuditData(
  data: unknown,
): Record<string, unknown> | null {
  if (data === null || data === undefined) return null;
  const sanitized = sanitizeValue(data, 0);
  if (
    typeof sanitized === 'object' &&
    sanitized !== null &&
    !Array.isArray(sanitized)
  ) {
    return sanitized as Record<string, unknown>;
  }
  return { value: sanitized };
}
