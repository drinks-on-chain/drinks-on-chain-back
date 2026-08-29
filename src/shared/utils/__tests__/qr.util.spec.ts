import { QrUtil } from '../qr.util';

describe('QrUtil', () => {
  it('should generate a structured claim payload and a deterministic sha256 passHash', () => {
    const expiresAt = new Date('2026-12-31T23:59:59.000Z');
    const result = QrUtil.generateClaimPassPayload({
      tokenId: 'token-uuid-1',
      userId: 'user-uuid-2',
      pickupLocationId: 'location-uuid-3',
      expiresAt,
      nonce: 'fixed-nonce-1234',
    });

    expect(result.payload.tokenId).toBe('token-uuid-1');
    expect(result.payload.userId).toBe('user-uuid-2');
    expect(result.payload.pickupLocationId).toBe('location-uuid-3');
    expect(result.payload.nonce).toBe('fixed-nonce-1234');
    expect(result.payload.expiresAt).toBe(expiresAt.toISOString());
    expect(result.passHash).toHaveLength(64);

    // Verificamos que parseAndValidateClaimQr lo valida correctamente
    const validation = QrUtil.parseAndValidateClaimQr(result.qrRawString);
    expect(validation.isValid).toBe(true);
    expect(validation.passHash).toBe(result.passHash);
  });

  it('should return isValid: false for invalid QR strings', () => {
    expect(QrUtil.parseAndValidateClaimQr('invalid-json').isValid).toBe(false);
    expect(
      QrUtil.parseAndValidateClaimQr(JSON.stringify({ incomplete: true }))
        .isValid,
    ).toBe(false);
  });
});
