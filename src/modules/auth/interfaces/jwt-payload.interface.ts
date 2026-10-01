/**
 * Claims del token de acceso (contrato O0 §5). Los de compatibilidad
 * (`email`, `userRole`, `wineryId`, `memberRole`) se retiraron en H1.
 */
export interface AccessTokenClaims {
  sub: string;
  aud: 'STAFF' | 'CONSUMER';
  org: string | null;
  orgType: 'PLATFORM' | 'WINERY' | 'PICKUP_POINT' | null;
  role: string | null;
  sid: string;
  jti: string;
  iat?: number;
  exp?: number;
}
