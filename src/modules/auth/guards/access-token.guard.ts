import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { TokenExpiredError } from '@nestjs/jwt';
import {
  MembershipStatusEnum,
  OrganizationStatusEnum,
  OrganizationTypeEnum,
} from '@prisma/client';
import { PrismaService } from '@shared/prisma/prisma.service';
import { ErrorCode } from '@shared/exceptions/error-codes';
import type { AuthenticatedUser } from '@shared/decorators/current-user.decorator';
import { setRequestContext } from '@shared/context/request-context';
import {
  IS_PUBLIC_KEY,
  OPTIONAL_AUTH_KEY,
} from '../decorators/public.decorator';
import type { AccessTokenClaims } from '../interfaces/jwt-payload.interface';
import { AccessTokenService } from '../sessions/access-token.service';
import { SessionRevocationStore } from '../sessions/session-revocation.store';
import {
  RevocationReason,
  SessionsService,
  sessionUnauthorized,
} from '../sessions/sessions.service';

export function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') {
    return null;
  }
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Guard global de acceso (contrato O0 §6): token de acceso válido y sesión
 * viva. Comprueba en orden:
 * 1. firma y caducidad del JWT (401 `AUTH_TOKEN_INVALID` / `AUTH_TOKEN_EXPIRED`);
 * 2. lista de revocación en Redis (IAM-13, sin tocar la base);
 * 3. en la base: la sesión no revocada, la persona activa y la membresía de la
 *    organización del token utilizable. Si la persona o la membresía están
 *    bloqueadas, revoca la sesión en el acto (401 `AUTH_SESSION_REVOKED`).
 *
 * Deja la persona en `request.user` y completa el contexto de la petición.
 */
@Injectable()
export class AccessTokenGuard implements CanActivate {
  private readonly logger = new Logger(AccessTokenGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly accessTokens: AccessTokenService,
    private readonly revocations: SessionRevocationStore,
    private readonly sessions: SessionsService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context.switchToHttp().getRequest<Request>();
    const token = bearerToken(request);
    if (isPublic) {
      // Pública con sesión opcional (aceptar una invitación con la cuenta
      // existente): si llega un acceso, se valida igual que en las privadas
      const optional = this.reflector.getAllAndOverride<boolean>(
        OPTIONAL_AUTH_KEY,
        [context.getHandler(), context.getClass()],
      );
      if (!optional || !token) {
        return true;
      }
    }
    if (!token) {
      throw sessionUnauthorized(
        ErrorCode.AUTH_TOKEN_INVALID,
        'Token de acceso ausente',
      );
    }

    let claims: AccessTokenClaims;
    try {
      claims = await this.accessTokens.verify(token);
    } catch (error) {
      if (error instanceof TokenExpiredError) {
        throw sessionUnauthorized(
          ErrorCode.AUTH_TOKEN_EXPIRED,
          'Token de acceso expirado',
        );
      }
      throw sessionUnauthorized(
        ErrorCode.AUTH_TOKEN_INVALID,
        'Token de acceso inválido',
      );
    }
    // Los accesos de 0.1 (sin sesión) ya no valen: hay que iniciar sesión
    if (
      typeof claims.sid !== 'string' ||
      !UUID_RE.test(claims.sid) ||
      typeof claims.sub !== 'string'
    ) {
      throw sessionUnauthorized(
        ErrorCode.AUTH_TOKEN_INVALID,
        'Token de acceso inválido',
      );
    }

    if ((await this.revocations.isRevoked(claims.sid)) === true) {
      throw sessionUnauthorized(
        ErrorCode.AUTH_SESSION_REVOKED,
        'La sesión fue revocada',
      );
    }

    const organizationId =
      typeof claims.org === 'string' && UUID_RE.test(claims.org)
        ? claims.org
        : null;
    const session = await this.prisma.session.findUnique({
      where: { id: claims.sid },
      select: {
        userId: true,
        revokedAt: true,
        mfaVerifiedAt: true,
        user: {
          select: {
            isActive: true,
            // Solo la membresía de la organización del token (ninguna si no hay)
            memberships: {
              where: { organizationId: organizationId ?? undefined },
              take: organizationId ? 1 : 0,
              select: {
                status: true,
                organization: { select: { status: true, type: true } },
              },
            },
          },
        },
      },
    });
    if (!session || session.userId !== claims.sub) {
      throw sessionUnauthorized(
        ErrorCode.AUTH_TOKEN_INVALID,
        'Token de acceso inválido',
      );
    }
    if (session.revokedAt) {
      // La marca de Redis pudo perderse: se repone
      await this.revocations.markRevoked([claims.sid], 'DB');
      throw sessionUnauthorized(
        ErrorCode.AUTH_SESSION_REVOKED,
        'La sesión fue revocada',
      );
    }
    if (!session.user.isActive) {
      await this.sessions.revoke(claims.sid, RevocationReason.USER_BLOCKED);
      throw sessionUnauthorized(
        ErrorCode.AUTH_SESSION_REVOKED,
        'La sesión fue revocada',
      );
    }

    let organizationStatus: AuthenticatedUser['organizationStatus'] = null;
    if (organizationId) {
      const membership = session.user.memberships[0];
      if (
        !membership ||
        membership.status !== MembershipStatusEnum.ACTIVE ||
        membership.organization.status === OrganizationStatusEnum.REVOKED
      ) {
        await this.sessions.revoke(
          claims.sid,
          RevocationReason.MEMBERSHIP_BLOCKED,
        );
        this.logger.warn(
          `Sesión ${claims.sid} revocada: membresía o organización activa no utilizable`,
        );
        throw sessionUnauthorized(
          ErrorCode.AUTH_SESSION_REVOKED,
          'La sesión fue revocada',
        );
      }
      // PLT-05: una organización de plataforma activa exige el segundo factor
      // en la sesión (las abiertas antes de exigirlo se revocan)
      if (
        membership.organization.type === OrganizationTypeEnum.PLATFORM &&
        !session.mfaVerifiedAt
      ) {
        await this.sessions.revoke(claims.sid, RevocationReason.MFA_REQUIRED);
        throw sessionUnauthorized(
          ErrorCode.AUTH_SESSION_REVOKED,
          'La sesión fue revocada: vuelve a entrar con tu segundo factor',
        );
      }
      organizationStatus = membership.organization.status;
    }

    const user: AuthenticatedUser = {
      id: claims.sub,
      userId: claims.sub,
      email: claims.email,
      sessionId: claims.sid,
      audience: claims.aud === 'STAFF' ? 'STAFF' : 'CONSUMER',
      organizationId,
      organizationType: organizationId ? claims.orgType : null,
      organizationStatus,
      role: organizationId ? claims.role : null,
      userRole: claims.userRole,
      wineryId: claims.wineryId ?? null,
      memberRole: claims.memberRole ?? null,
    };
    (request as Request & { user: AuthenticatedUser }).user = user;
    setRequestContext({
      userId: user.id,
      sessionId: user.sessionId,
      audience: user.audience,
      organizationId: user.organizationId,
      organizationType: user.organizationType,
      role: user.role,
    });
    return true;
  }
}
