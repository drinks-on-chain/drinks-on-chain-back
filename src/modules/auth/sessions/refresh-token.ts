import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Token de renovación (contrato O0 §5): `<sid>.<generación>.<secreto>`.
 *
 * - El secreto inicial es aleatorio (32 bytes). Cada rotación deriva el
 *   siguiente con HMAC-SHA256(clave del servidor, `sid.gen+1.secreto`), así que
 *   quien tiene un refresco antiguo no puede calcular el nuevo, pero el servidor
 *   sí puede reconocer que un refresco antiguo es de verdad de esa sesión
 *   (derivándolo hacia delante hasta la generación vigente).
 * - En la base solo se guarda el SHA-256 del secreto vigente.
 * - Un refresco antiguo auténtico = reutilización → se revoca la sesión. Uno
 *   que no encaja en la cadena es inválido y no revoca nada (así nadie puede
 *   cerrar la sesión de otro con solo conocer su `sid`).
 */
export interface ParsedRefreshToken {
  sessionId: string;
  generation: number;
  secret: string;
}

/** Tope de rotaciones que se recorren al comprobar un refresco antiguo. */
export const MAX_CHAIN_STEPS = 20_000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;

export function generateRefreshSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function deriveNextSecret(
  key: string,
  sessionId: string,
  nextGeneration: number,
  secret: string,
): string {
  return createHmac('sha256', key)
    .update(`${sessionId}.${nextGeneration}.${secret}`)
    .digest('base64url');
}

export function hashRefreshSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function formatRefreshToken(token: ParsedRefreshToken): string {
  return `${token.sessionId}.${token.generation}.${token.secret}`;
}

export function parseRefreshToken(
  raw: string | null | undefined,
): ParsedRefreshToken | null {
  if (typeof raw !== 'string' || raw.length > 200) {
    return null;
  }
  const parts = raw.trim().split('.');
  if (parts.length !== 3) {
    return null;
  }
  const [sessionId, generationRaw, secret] = parts;
  if (!UUID_RE.test(sessionId) || !/^\d{1,9}$/.test(generationRaw)) {
    return null;
  }
  if (!SECRET_RE.test(secret)) {
    return null;
  }
  return {
    sessionId: sessionId.toLowerCase(),
    generation: Number(generationRaw),
    secret,
  };
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * - `current`: es el refresco vigente.
 * - `previous`: es el inmediatamente anterior (candidato al periodo de gracia).
 * - `reused`: es uno más antiguo de la misma sesión.
 * - `invalid`: no pertenece a la cadena de la sesión.
 */
export type RefreshTokenMatch =
  | { kind: 'current' }
  | { kind: 'previous'; nextSecret: string }
  | { kind: 'reused' }
  | { kind: 'invalid' };

export function matchRefreshToken(
  key: string,
  presented: ParsedRefreshToken,
  session: { id: string; generation: number; refreshTokenHash: string },
): RefreshTokenMatch {
  if (presented.sessionId !== session.id.toLowerCase()) {
    return { kind: 'invalid' };
  }
  if (presented.generation === session.generation) {
    return sameHash(
      hashRefreshSecret(presented.secret),
      session.refreshTokenHash,
    )
      ? { kind: 'current' }
      : { kind: 'invalid' };
  }
  const steps = session.generation - presented.generation;
  if (steps < 1 || steps > MAX_CHAIN_STEPS) {
    return { kind: 'invalid' };
  }
  let secret = presented.secret;
  let nextSecret = '';
  for (let gen = presented.generation + 1; gen <= session.generation; gen++) {
    secret = deriveNextSecret(key, session.id, gen, secret);
    if (gen === presented.generation + 1) {
      nextSecret = secret;
    }
  }
  if (!sameHash(hashRefreshSecret(secret), session.refreshTokenHash)) {
    return { kind: 'invalid' };
  }
  return steps === 1 ? { kind: 'previous', nextSecret } : { kind: 'reused' };
}
