import { createHash, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Tokens opacos de un solo uso que viajan por correo o al cliente
 * (invitaciones, recuperación de contraseña, verificación del correo, reto del
 * segundo factor). Se entregan una vez y en la base solo se guarda su SHA-256:
 * quien lea la base no puede usarlos.
 */

/** Token aleatorio apto para URL (base64url de `bytes` bytes; 32 → 43 caracteres). */
export function generateOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** SHA-256 en hexadecimal (64 caracteres) de un token presentado. */
export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Tamaño máximo razonable de un token presentado (evita hashear basura enorme). */
export const MAX_OPAQUE_TOKEN_LENGTH = 512;

/** ¿Tiene forma de token (no vacío, sin espacios y de longitud razonable)? */
export function isPlausibleToken(token: unknown): token is string {
  return (
    typeof token === 'string' &&
    token.length >= 8 &&
    token.length <= MAX_OPAQUE_TOKEN_LENGTH &&
    !/\s/.test(token)
  );
}

/** Comparación en tiempo constante de dos hashes hexadecimales. */
export function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}
