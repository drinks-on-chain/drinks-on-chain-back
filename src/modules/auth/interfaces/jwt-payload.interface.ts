/**
 * Claims del token de acceso (contrato O0 §5). `email`, `userRole`,
 * `wineryId` y `memberRole` se mantienen por compatibilidad (*retirada* en H1).
 */
export interface AccessTokenClaims {
  sub: string;
  aud: 'STAFF' | 'CONSUMER';
  org: string | null;
  orgType: 'PLATFORM' | 'WINERY' | 'PICKUP_POINT' | null;
  role: string | null;
  sid: string;
  jti: string;
  email: string;
  userRole: string;
  wineryId: string | null;
  memberRole: string | null;
  iat?: number;
  exp?: number;
}
