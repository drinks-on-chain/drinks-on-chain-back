import { Prisma } from '@prisma/client';
import {
  REDACTED,
  isSensitiveKey,
  sanitizeAuditData,
} from '../audit-sanitizer';

describe('sanitizeAuditData', () => {
  it('oculta contraseñas, tokens y secretos a cualquier profundidad', () => {
    const result = sanitizeAuditData({
      email: 'a@b.bo',
      password: 'x',
      passwordHash: '$2b$…',
      nested: {
        accessToken: 't',
        refresh_token: 'r',
        apiKey: 'k',
        clientSecret: 's',
        list: [{ totpSecret: 'z', ok: 1 }],
      },
    });
    expect(result).toEqual({
      email: 'a@b.bo',
      password: REDACTED,
      passwordHash: REDACTED,
      nested: {
        accessToken: REDACTED,
        refresh_token: REDACTED,
        apiKey: REDACTED,
        clientSecret: REDACTED,
        list: [{ totpSecret: REDACTED, ok: 1 }],
      },
    });
  });

  it('conserva claves que solo parecen sensibles', () => {
    expect(isSensitiveKey('tokenId')).toBe(false);
    expect(isSensitiveKey('tokenType')).toBe(false);
    expect(isSensitiveKey('reason')).toBe(false);
    expect(isSensitiveKey('Authorization')).toBe(true);
    expect(isSensitiveKey('pin')).toBe(true);
  });

  it('oculta semillas secretas de Stellar aunque la clave no lo diga', () => {
    const seed = `S${'A'.repeat(55)}`;
    expect(sanitizeAuditData({ note: seed })).toEqual({ note: REDACTED });
    // Una clave pública (G…) se conserva
    const pub = `G${'A'.repeat(55)}`;
    expect(sanitizeAuditData({ key: pub })).toEqual({ key: pub });
  });

  it('convierte fechas, decimales y enteros grandes a JSON puro', () => {
    const at = new Date('2026-09-27T10:00:00.000Z');
    expect(
      sanitizeAuditData({
        at,
        weight: new Prisma.Decimal('12.500'),
        big: BigInt(10),
        nothing: undefined,
        nul: null,
      }),
    ).toEqual({
      at: '2026-09-27T10:00:00.000Z',
      weight: '12.5',
      big: '10',
      nul: null,
    });
  });

  it('null y undefined → null; un valor suelto → { value }', () => {
    expect(sanitizeAuditData(null)).toBeNull();
    expect(sanitizeAuditData(undefined)).toBeNull();
    expect(sanitizeAuditData('texto')).toEqual({ value: 'texto' });
    expect(sanitizeAuditData([1, 2])).toEqual({ value: [1, 2] });
  });
});
