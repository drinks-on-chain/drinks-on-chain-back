import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AudienceEnum, Prisma, Session } from '@prisma/client';
import { PrismaService } from '@shared/prisma/prisma.service';
import { AppException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';
import {
  deriveNextSecret,
  formatRefreshToken,
  generateRefreshSecret,
  hashRefreshSecret,
  matchRefreshToken,
  parseRefreshToken,
} from './refresh-token';
import { SessionRevocationStore } from './session-revocation.store';
import { SESSION_SETTINGS, SessionSettings } from './session.config';

/** Motivos de revocación (`sessions.revoked_reason`). */
export const RevocationReason = {
  LOGOUT: 'LOGOUT',
  LOGOUT_ALL: 'LOGOUT_ALL',
  REFRESH_REUSED: 'REFRESH_REUSED',
  USER_BLOCKED: 'USER_BLOCKED',
  MEMBERSHIP_BLOCKED: 'MEMBERSHIP_BLOCKED',
  ORGANIZATION_REVOKED: 'ORGANIZATION_REVOKED',
} as const;
export type RevocationReasonValue =
  (typeof RevocationReason)[keyof typeof RevocationReason];

export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
}

export interface IssuedRefresh {
  session: Session;
  refreshToken: string;
}

/** Resultado de validar un refresco presentado. */
export interface ValidatedRefresh {
  session: Session;
  /** `current`: rota ahora; `grace`: ya rotó hace menos del periodo de gracia. */
  kind: 'current' | 'grace';
  /** Secreto de la generación siguiente (el que se entrega). */
  nextSecret: string;
}

export function sessionUnauthorized(code: string, message: string) {
  return new AppException(401, code, message);
}

/**
 * Sesiones (contrato O0 §5): alta al iniciar sesión, rotación del refresco con
 * detección de reutilización y periodo de gracia, revocación (una, todas las
 * de una persona o las que tienen activa una organización).
 */
@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);
  private readonly refreshKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly revocations: SessionRevocationStore,
    @Inject(SESSION_SETTINGS) private readonly settings: SessionSettings,
    config: ConfigService,
  ) {
    this.refreshKey = config.getOrThrow<string>('JWT_REFRESH_SECRET');
  }

  ttlSecondsFor(audience: AudienceEnum): number {
    return audience === AudienceEnum.CONSUMER
      ? this.settings.consumerSessionTtlSeconds
      : this.settings.staffSessionTtlSeconds;
  }

  /** Abre una sesión nueva (login, signup) con su primer refresco. */
  async create(params: {
    userId: string;
    audience: AudienceEnum;
    activeOrganizationId: string | null;
    client: ClientInfo;
  }): Promise<IssuedRefresh> {
    const secret = generateRefreshSecret();
    const now = new Date();
    const session = await this.prisma.session.create({
      data: {
        userId: params.userId,
        audience: params.audience,
        activeOrganizationId: params.activeOrganizationId,
        refreshTokenHash: hashRefreshSecret(secret),
        generation: 0,
        lastUsedAt: now,
        expiresAt: new Date(
          now.getTime() + this.ttlSecondsFor(params.audience) * 1000,
        ),
        ip: params.client.ip?.slice(0, 64) ?? null,
        userAgent: params.client.userAgent?.slice(0, 300) ?? null,
      },
    });
    return {
      session,
      refreshToken: formatRefreshToken({
        sessionId: session.id,
        generation: 0,
        secret,
      }),
    };
  }

  /**
   * Comprueba un refresco presentado. Lanza 401:
   * - `AUTH_REFRESH_INVALID`: ausente, mal formado o ajeno a la sesión;
   * - `AUTH_SESSION_REVOKED`: la sesión ya estaba revocada;
   * - `AUTH_SESSION_EXPIRED`: la sesión caducó;
   * - `AUTH_REFRESH_REUSED`: refresco ya rotado fuera del periodo de gracia
   *   (revoca la sesión entera).
   */
  async validateRefresh(rawToken: string | null): Promise<ValidatedRefresh> {
    const parsed = parseRefreshToken(rawToken);
    if (!parsed) {
      throw sessionUnauthorized(
        ErrorCode.AUTH_REFRESH_INVALID,
        'Token de renovación ausente o inválido',
      );
    }
    const session = await this.prisma.session.findUnique({
      where: { id: parsed.sessionId },
    });
    if (!session) {
      throw sessionUnauthorized(
        ErrorCode.AUTH_REFRESH_INVALID,
        'Token de renovación ausente o inválido',
      );
    }

    const match = matchRefreshToken(this.refreshKey, parsed, session);
    if (match.kind === 'invalid') {
      throw sessionUnauthorized(
        ErrorCode.AUTH_REFRESH_INVALID,
        'Token de renovación ausente o inválido',
      );
    }
    if (session.revokedAt) {
      throw sessionUnauthorized(
        ErrorCode.AUTH_SESSION_REVOKED,
        'La sesión fue revocada',
      );
    }
    if (session.expiresAt.getTime() <= Date.now()) {
      throw sessionUnauthorized(
        ErrorCode.AUTH_SESSION_EXPIRED,
        'La sesión caducó; inicia sesión de nuevo',
      );
    }

    if (match.kind === 'current') {
      return {
        session,
        kind: 'current',
        nextSecret: deriveNextSecret(
          this.refreshKey,
          session.id,
          session.generation + 1,
          parsed.secret,
        ),
      };
    }

    if (match.kind === 'previous' && this.withinGrace(session)) {
      return { session, kind: 'grace', nextSecret: match.nextSecret };
    }

    // Reutilización de un refresco ya rotado: se revoca toda la familia
    await this.revoke(session.id, RevocationReason.REFRESH_REUSED);
    this.logger.warn(
      `Reutilización de refresco en la sesión ${session.id} (generación ${parsed.generation}, vigente ${session.generation}): sesión revocada`,
    );
    throw sessionUnauthorized(
      ErrorCode.AUTH_REFRESH_REUSED,
      'El token de renovación ya se había usado; la sesión se cerró por seguridad',
    );
  }

  private withinGrace(session: Session): boolean {
    return (
      session.rotatedAt !== null &&
      Date.now() - session.rotatedAt.getTime() <=
        this.settings.refreshGraceSeconds * 1000
    );
  }

  /**
   * Rota el refresco a la generación siguiente (deslizante). Si otra
   * petición rotó la misma generación a la vez, no hace nada y devuelve la
   * sesión releída: el refresco nuevo es el mismo (derivación determinista).
   */
  async rotate(
    validated: ValidatedRefresh,
    changes: {
      audience: AudienceEnum;
      activeOrganizationId: string | null;
    },
  ): Promise<IssuedRefresh> {
    const { session } = validated;
    const nextGeneration =
      validated.kind === 'current'
        ? session.generation + 1
        : session.generation;
    let current: Session = session;

    if (validated.kind === 'current') {
      const now = new Date();
      const updated = await this.prisma.session.updateMany({
        where: {
          id: session.id,
          generation: session.generation,
          revokedAt: null,
        },
        data: {
          generation: nextGeneration,
          refreshTokenHash: hashRefreshSecret(validated.nextSecret),
          rotatedAt: now,
          lastUsedAt: now,
          audience: changes.audience,
          activeOrganizationId: changes.activeOrganizationId,
          expiresAt: new Date(
            now.getTime() + this.ttlSecondsFor(changes.audience) * 1000,
          ),
        },
      });
      const reread = await this.prisma.session.findUniqueOrThrow({
        where: { id: session.id },
      });
      if (updated.count === 0 && reread.revokedAt) {
        throw sessionUnauthorized(
          ErrorCode.AUTH_SESSION_REVOKED,
          'La sesión fue revocada',
        );
      }
      current = reread;
    }

    return {
      session: current,
      refreshToken: formatRefreshToken({
        sessionId: current.id,
        generation: nextGeneration,
        secret: validated.nextSecret,
      }),
    };
  }

  async findById(sessionId: string): Promise<Session | null> {
    return this.prisma.session.findUnique({ where: { id: sessionId } });
  }

  /**
   * Sesión a la que pertenece un refresco auténtico (de cualquier generación),
   * sin rotar ni revocar nada. Para el logout con el acceso ya caducado.
   */
  async identifyByRefresh(rawToken: string | null): Promise<string | null> {
    const parsed = parseRefreshToken(rawToken);
    if (!parsed) {
      return null;
    }
    const session = await this.findById(parsed.sessionId);
    if (!session) {
      return null;
    }
    const match = matchRefreshToken(this.refreshKey, parsed, session);
    return match.kind === 'invalid' ? null : session.id;
  }

  /** Cambia la organización activa de la sesión (misma `sid`). */
  async setActiveOrganization(
    sessionId: string,
    organizationId: string | null,
  ): Promise<void> {
    await this.prisma.session.update({
      where: { id: sessionId },
      data: { activeOrganizationId: organizationId, lastUsedAt: new Date() },
    });
  }

  /** Revoca una sesión (idempotente). */
  async revoke(
    sessionId: string,
    reason: RevocationReasonValue,
  ): Promise<void> {
    await this.revokeWhere({ id: sessionId }, reason);
  }

  /** Revoca todas las sesiones vivas de una persona (bloqueo, logout-all). */
  async revokeAllForUser(
    userId: string,
    reason: RevocationReasonValue,
  ): Promise<number> {
    return this.revokeWhere({ userId }, reason);
  }

  /**
   * Revoca las sesiones cuya organización activa es `organizationId`; con
   * `userId`, solo las de esa persona (bloqueo de una membresía).
   */
  async revokeForOrganization(
    organizationId: string,
    reason: RevocationReasonValue,
    userId?: string,
  ): Promise<number> {
    return this.revokeWhere(
      { activeOrganizationId: organizationId, ...(userId ? { userId } : {}) },
      reason,
    );
  }

  private async revokeWhere(
    where: Prisma.SessionWhereInput,
    reason: RevocationReasonValue,
  ): Promise<number> {
    const live = await this.prisma.session.findMany({
      where: { ...where, revokedAt: null },
      select: { id: true },
    });
    if (live.length === 0) {
      return 0;
    }
    const ids = live.map((s) => s.id);
    await this.prisma.session.updateMany({
      where: { id: { in: ids }, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    await this.revocations.markRevoked(ids, reason);
    return ids.length;
  }
}
