import { v4 as uuidv4 } from 'uuid';
import { HashUtil } from './hash.util';

export interface ClaimQrPayload {
  tokenId: string;
  userId: string;
  pickupLocationId: string;
  nonce: string;
  expiresAt: string;
}

export class QrUtil {
  /**
   * Genera la estructura de datos para un código QR de retiro (Claim Pass)
   * junto con su hash SHA-256 canónico para anclaje on-chain en C-05.
   */
  static generateClaimPassPayload(params: {
    tokenId: string;
    userId: string;
    pickupLocationId: string;
    expiresAt: Date;
    nonce?: string;
  }): { payload: ClaimQrPayload; qrRawString: string; passHash: string } {
    const payload: ClaimQrPayload = {
      tokenId: params.tokenId,
      userId: params.userId,
      pickupLocationId: params.pickupLocationId,
      nonce: params.nonce || uuidv4(),
      expiresAt: params.expiresAt.toISOString(),
    };

    const qrRawString = JSON.stringify(payload);
    const passHash = HashUtil.sha256CanonicalJson(payload);

    return { payload, qrRawString, passHash };
  }

  /**
   * Valida y decodifica un string de código QR de claim
   */
  static parseAndValidateClaimQr(rawQrString: string): {
    isValid: boolean;
    payload?: ClaimQrPayload;
    passHash?: string;
  } {
    try {
      const parsed = JSON.parse(rawQrString) as ClaimQrPayload;
      if (
        !parsed.tokenId ||
        !parsed.userId ||
        !parsed.pickupLocationId ||
        !parsed.nonce ||
        !parsed.expiresAt
      ) {
        return { isValid: false };
      }

      const passHash = HashUtil.sha256CanonicalJson(parsed);
      return { isValid: true, payload: parsed, passHash };
    } catch {
      return { isValid: false };
    }
  }
}
