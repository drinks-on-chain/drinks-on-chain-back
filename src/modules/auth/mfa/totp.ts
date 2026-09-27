import { randomInt } from 'crypto';
import {
  createGuardrails,
  generateSecret,
  generateSync,
  generateURI,
  verifySync,
} from 'otplib';

/**
 * TOTP (RFC 6238) con `otplib`: SHA-1, 6 dígitos, pasos de 30 s, compatible
 * con Google Authenticator, Authy, 1Password… Se acepta el paso anterior y el
 * siguiente (±30 s de deriva del reloj) y nunca un paso ya usado (repetición).
 */
export const TOTP_ISSUER = 'Drinks on Chain';
export const TOTP_PERIOD_SECONDS = 30;
/** ±1 paso de tolerancia (en segundos para otplib). */
const EPOCH_TOLERANCE_SECONDS = TOTP_PERIOD_SECONDS;

/**
 * Los secretos que genera el backend son de 20 bytes; se admiten de 10 bytes
 * o más para poder usar el secreto de demostración de los mocks
 * (`SEED_DEMO_TOTP_SECRET`).
 */
const GUARDRAILS = createGuardrails({ MIN_SECRET_BYTES: 10 });

export const TOTP_CODE_PATTERN = /^\d{6}$/;

/** Secreto nuevo en base32 (20 bytes → 32 caracteres). */
export function newTotpSecret(): string {
  return generateSecret({ length: 20 });
}

export function totpUri(secret: string, accountName: string): string {
  return generateURI({ issuer: TOTP_ISSUER, label: accountName, secret });
}

/** Código actual (pruebas y semilla). */
export function currentTotp(secret: string, epochSeconds?: number): string {
  return generateSync({
    secret,
    guardrails: GUARDRAILS,
    ...(epochSeconds !== undefined ? { epoch: epochSeconds } : {}),
  });
}

/**
 * Comprueba un código. Devuelve el paso aceptado (para guardarlo y no volver
 * a aceptarlo) o `null` si no vale.
 */
export function verifyTotp(
  secret: string,
  code: string,
  afterTimeStep: number | null,
): number | null {
  if (!TOTP_CODE_PATTERN.test(code)) return null;
  try {
    const result = verifySync({
      secret,
      token: code,
      guardrails: GUARDRAILS,
      epochTolerance: EPOCH_TOLERANCE_SECONDS,
      ...(afterTimeStep !== null ? { afterTimeStep } : {}),
    });
    // El tipo común de otplib junta HOTP y TOTP: el de TOTP trae `timeStep`
    if (!result.valid || !('timeStep' in result)) return null;
    return typeof result.timeStep === 'number' ? result.timeStep : null;
  } catch {
    return null;
  }
}

/** Alfabeto de Crockford sin letras ambiguas (I, L, O, U). */
const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const RECOVERY_CODES_COUNT = 10;

/** Código de recuperación `XXXXX-XXXXX` (50 bits). */
export function newRecoveryCode(): string {
  let raw = '';
  for (let i = 0; i < 10; i++) {
    raw += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
  }
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

/**
 * Forma canónica de un código de recuperación escrito por la persona:
 * mayúsculas, sin espacios ni guiones, con las letras ambiguas corregidas
 * (O → 0, I/L → 1). `null` si no tiene forma de código.
 */
export function normalizeRecoveryCode(input: string): string | null {
  const cleaned = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (cleaned.length !== 10) return null;
  for (const ch of cleaned) {
    if (!RECOVERY_ALPHABET.includes(ch)) return null;
  }
  return cleaned;
}
