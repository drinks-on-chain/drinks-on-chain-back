import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * Persona autenticada de la petición (`request.user`), construida por el
 * guard de acceso a partir del token y de la sesión (contrato O0 §5–§6).
 */
export interface AuthenticatedUser {
  id: string;
  /** Igual que `id` (compatibilidad con el código de 0.1). */
  userId: string;
  email: string;
  /** Claim `sid`. */
  sessionId: string;
  /** Claim `aud`. */
  audience: 'STAFF' | 'CONSUMER';
  /** Claim `org`: organización activa. */
  organizationId: string | null;
  /** Claim `orgType`. */
  organizationType: 'PLATFORM' | 'WINERY' | 'PICKUP_POINT' | null;
  /** Estado actual de la organización activa (leído de la base). */
  organizationStatus: 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'REVOKED' | null;
  /** Claim `role`: rol en la organización activa. */
  role: string | null;
  /** Compatibilidad hasta H1: `userRole` equivalente a la organización activa. */
  userRole: string;
  /** Compatibilidad hasta H1: la bodega activa (si la organización activa es una bodega). */
  wineryId: string | null;
  /** Compatibilidad hasta H1: rol en la bodega activa. */
  memberRole: string | null;
}

export const CurrentUser = createParamDecorator(
  (data: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user as AuthenticatedUser;
    return data ? user?.[data] : user;
  },
);
