import {
  deriveNextSecret,
  formatRefreshToken,
  generateRefreshSecret,
  hashRefreshSecret,
  matchRefreshToken,
  parseRefreshToken,
} from '../sessions/refresh-token';

const KEY = 'unit-test-refresh-key-at-least-32-chars';
const SID = '6f1c2b7e-0d4e-4c1a-9f3b-8a7d6e5c4b3a';

/** Cadena de secretos de una sesión: [gen0, gen1, …]. */
function chain(length: number): string[] {
  const secrets = [generateRefreshSecret()];
  for (let gen = 1; gen < length; gen++) {
    secrets.push(deriveNextSecret(KEY, SID, gen, secrets[gen - 1]));
  }
  return secrets;
}

describe('refresh-token (cadena de refrescos)', () => {
  it('formatea y lee <sid>.<generación>.<secreto>', () => {
    const secret = generateRefreshSecret();
    const raw = formatRefreshToken({
      sessionId: SID,
      generation: 7,
      secret,
    });
    expect(raw).toBe(`${SID}.7.${secret}`);
    expect(parseRefreshToken(raw)).toEqual({
      sessionId: SID,
      generation: 7,
      secret,
    });
  });

  it.each([
    [null],
    [''],
    ['no-es-un-token'],
    [`${SID}.x.${'a'.repeat(43)}`],
    [`not-a-uuid.1.${'a'.repeat(43)}`],
    [`${SID}.1.corto`],
    // un JWT de 0.1 (tres partes pero sin sid)
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl'],
  ])('rechaza %p', (raw) => {
    expect(parseRefreshToken(raw)).toBeNull();
  });

  it('la derivación es determinista y depende de la clave, la sesión y la generación', () => {
    const secret = generateRefreshSecret();
    const next = deriveNextSecret(KEY, SID, 1, secret);
    expect(deriveNextSecret(KEY, SID, 1, secret)).toBe(next);
    expect(deriveNextSecret(`${KEY}-otra`, SID, 1, secret)).not.toBe(next);
    expect(deriveNextSecret(KEY, SID, 2, secret)).not.toBe(next);
    expect(next).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  describe('matchRefreshToken', () => {
    const secrets = chain(5); // generaciones 0…4; vigente la 4
    const session = {
      id: SID,
      generation: 4,
      refreshTokenHash: hashRefreshSecret(secrets[4]),
    };
    const token = (generation: number, secret = secrets[generation]) => ({
      sessionId: SID,
      generation,
      secret,
    });

    it('current: el refresco vigente', () => {
      expect(matchRefreshToken(KEY, token(4), session)).toEqual({
        kind: 'current',
      });
    });

    it('previous: el inmediatamente anterior, con el secreto vigente', () => {
      expect(matchRefreshToken(KEY, token(3), session)).toEqual({
        kind: 'previous',
        nextSecret: secrets[4],
      });
    });

    it('reused: uno más antiguo de la misma cadena', () => {
      expect(matchRefreshToken(KEY, token(0), session)).toEqual({
        kind: 'reused',
      });
      expect(matchRefreshToken(KEY, token(2), session)).toEqual({
        kind: 'reused',
      });
    });

    it('invalid: secreto ajeno, generación futura u otra sesión (no revoca nada)', () => {
      const forged = generateRefreshSecret();
      expect(matchRefreshToken(KEY, token(4, forged), session).kind).toBe(
        'invalid',
      );
      expect(matchRefreshToken(KEY, token(2, forged), session).kind).toBe(
        'invalid',
      );
      expect(matchRefreshToken(KEY, token(5, secrets[4]), session).kind).toBe(
        'invalid',
      );
      expect(
        matchRefreshToken(
          KEY,
          { ...token(4), sessionId: '00000000-0000-4000-8000-000000000009' },
          session,
        ).kind,
      ).toBe('invalid');
    });

    it('con otra clave del servidor la cadena no encaja', () => {
      expect(matchRefreshToken(`${KEY}-otra`, token(3), session).kind).toBe(
        'invalid',
      );
    });
  });
});
