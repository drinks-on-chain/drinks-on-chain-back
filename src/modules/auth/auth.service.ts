import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  AudienceEnum,
  MembershipStatusEnum,
  OrganizationStatusEnum,
  User,
  UserRoleEnum,
  WalletPurposeEnum,
} from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '@shared/prisma/prisma.service';
import {
  AppException,
  RetryAfterException,
} from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';
import type { AuthenticatedUser } from '@shared/decorators/current-user.decorator';
import { WalletsService } from '@modules/wallets/wallets.service';
import {
  MembershipsService,
  MembershipView,
  isUsableMembership,
  pickActiveOrganizationId,
  requiresMfa,
} from '@modules/organizations/memberships.service';
import { legacyUserRoleFor } from '@modules/organizations/organization.constants';
import { SignupDto } from './dto/signup.dto';
import { LoginDto } from './dto/login.dto';
import { AuthResponseDto } from './dto/auth-response.dto';
import {
  ClientInfo,
  RevocationReason,
  SessionsService,
  ValidatedRefresh,
  sessionUnauthorized,
} from './sessions/sessions.service';
import { SessionRevocationStore } from './sessions/session-revocation.store';
import { AccessTokenService } from './sessions/access-token.service';
import { parseRefreshToken } from './sessions/refresh-token';
import { LoginAttemptsService } from './rate-limit/login-attempts.service';
import { MfaChallengeBody, MfaPassed, MfaService } from './mfa/mfa.service';
import type { IssuedSession } from './sessions/session-response';

/**
 * Hash bcrypt de un valor aleatorio descartado: si el correo no existe se
 * compara igual contra él, para que el tiempo de respuesta no delate qué
 * correos están registrados.
 */
const DUMMY_PASSWORD_HASH =
  '$2b$12$WuVygc4/zA0DuyXc86ytwOqVAWPykc3ApfmtBtI/oFBa4CWWgGhPm';

export type { IssuedSession };

/**
 * Resultado del login: la sesión o, para el personal de plataforma, el reto
 * del segundo factor (sin tokens ni cookie; contrato O1 §1).
 */
export type LoginOutcome =
  | { kind: 'session'; issued: IssuedSession }
  | { kind: 'mfa'; body: MfaChallengeBody };

function isPlatformOrganization(
  memberships: readonly MembershipView[],
  organizationId: string | null,
): boolean {
  return memberships.some(
    (m) =>
      m.organizationId === organizationId && m.organizationType === 'PLATFORM',
  );
}

function mfaRequiredError(): AppException {
  return new AppException(
    403,
    ErrorCode.AUTH_MFA_REQUIRED,
    'La organización de plataforma exige el segundo factor: cierra la sesión y vuelve a entrar con tu código',
  );
}

type SessionUser = Pick<
  User,
  | 'id'
  | 'email'
  | 'fullName'
  | 'phoneNumber'
  | 'preferredLocale'
  | 'userRole'
  | 'isActive'
  | 'lastOrganizationId'
>;

export function audienceFor(
  memberships: readonly MembershipView[],
): AudienceEnum {
  return memberships.length > 0 ? AudienceEnum.STAFF : AudienceEnum.CONSUMER;
}

/**
 * Autenticación y sesión (contrato O0 §5; IAM-02, 03, 04, 07, 08, 13).
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly bcryptRounds = 12;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    private readonly revocations: SessionRevocationStore,
    private readonly accessTokens: AccessTokenService,
    private readonly memberships: MembershipsService,
    private readonly loginAttempts: LoginAttemptsService,
    private readonly walletsService: WalletsService,
    private readonly mfa: MfaService,
  ) {}

  /** Registro público (consumidores; `WINERY_ADMIN` hasta H1). Abre sesión. */
  async signup(dto: SignupDto, client: ClientInfo): Promise<IssuedSession> {
    const email = dto.email.toLowerCase().trim();
    const existingUser = await this.prisma.user.findUnique({
      where: { email },
    });
    if (existingUser) {
      throw new ConflictException(
        'El correo electrónico ya se encuentra registrado en el sistema',
      );
    }

    if (dto.phoneNumber) {
      const existingPhone = await this.prisma.user.findUnique({
        where: { phoneNumber: dto.phoneNumber.trim() },
      });
      if (existingPhone) {
        throw new ConflictException(
          'El número de teléfono ya se encuentra registrado',
        );
      }
    }

    const allowedPublicRoles: UserRoleEnum[] = [
      UserRoleEnum.CONSUMER,
      UserRoleEnum.WINERY_ADMIN,
    ];
    const targetRole = dto.userRole ?? UserRoleEnum.CONSUMER;
    if (!allowedPublicRoles.includes(targetRole)) {
      throw new ForbiddenException(
        `El rol '${targetRole}' no puede ser asignado mediante registro público. Los administradores globales se inicializan mediante Seeder y el personal operativo es incorporado por la bodega.`,
      );
    }

    const passwordHash = await bcrypt.hash(dto.password, this.bcryptRounds);
    const user = await this.prisma.user.create({
      data: {
        email,
        passwordHash,
        fullName: dto.fullName.trim(),
        userRole: targetRole,
        phoneNumber: dto.phoneNumber?.trim() ?? null,
        preferredLocale: dto.preferredLocale ?? 'es',
        isActive: true,
      },
    });

    await this.walletsService.provisionUserWallet(
      user.id,
      WalletPurposeEnum.CONSUMER_NFT,
    );
    this.logger.log(`Usuario registrado: ${user.id}`);

    return this.openSession(user, [], client);
  }

  /**
   * Inicio de sesión con correo y contraseña (IAM-02, IAM-07). El personal de
   * plataforma no recibe tokens: recibe el reto del segundo factor (PLT-05).
   */
  async login(dto: LoginDto, client: ClientInfo): Promise<LoginOutcome> {
    const email = dto.email.toLowerCase().trim();

    const lockedFor = await this.loginAttempts.lockedFor(email, client.ip);
    if (lockedFor > 0) {
      throw new RetryAfterException(
        ErrorCode.AUTH_TOO_MANY_ATTEMPTS,
        'Demasiados intentos fallidos. Vuelve a intentarlo más tarde',
        lockedFor,
      );
    }

    const user = await this.prisma.user.findUnique({ where: { email } });
    const passwordOk = await bcrypt.compare(
      dto.password,
      user?.passwordHash ?? DUMMY_PASSWORD_HASH,
    );
    if (!user || !passwordOk || !user.isActive) {
      const lock = await this.loginAttempts.recordFailure(email, client.ip);
      if (lock > 0) {
        throw new RetryAfterException(
          ErrorCode.AUTH_TOO_MANY_ATTEMPTS,
          'Demasiados intentos fallidos. Vuelve a intentarlo más tarde',
          lock,
        );
      }
      throw new AppException(
        401,
        ErrorCode.AUTH_INVALID_CREDENTIALS,
        'Credenciales de acceso inválidas',
      );
    }
    await this.loginAttempts.recordSuccess(email);

    const memberships = await this.memberships.listForUser(user.id);
    if (requiresMfa(memberships)) {
      const body = await this.mfa.startChallenge(user, { client });
      this.logger.log(`Segundo factor pedido a ${user.id}`);
      return { kind: 'mfa', body };
    }
    const issued = await this.openSession(user, memberships, client);
    this.logger.log(`Sesión abierta para ${user.id}`);
    return { kind: 'session', issued };
  }

  /**
   * Reto del segundo factor superado (`mfa/verify`, `mfa/enroll/confirm`):
   * abre la sesión marcada con el segundo factor. La organización activa es
   * la del reto (invitación aceptada) o la de por defecto.
   */
  async completeMfa(
    passed: MfaPassed,
    client: ClientInfo,
  ): Promise<IssuedSession> {
    const user = await this.prisma.user.findUnique({
      where: { id: passed.userId },
    });
    if (!user || !user.isActive) {
      throw new AppException(
        401,
        ErrorCode.AUTH_MFA_TOKEN_INVALID,
        'El reto de segundo factor caducó o no es válido: inicia sesión de nuevo',
      );
    }
    await this.loginAttempts.recordSuccess(user.email);
    const memberships = await this.memberships.listForUser(user.id);
    const invited = passed.organizationId
      ? memberships.find(
          (m) =>
            m.organizationId === passed.organizationId && isUsableMembership(m),
        )
      : undefined;
    const issued = await this.openSession(user, memberships, client, {
      mfaVerified: true,
      preferredOrganizationId: invited
        ? invited.organizationId
        : user.lastOrganizationId,
    });
    this.logger.log(`Sesión abierta con segundo factor para ${user.id}`);
    return issued;
  }

  /**
   * Abre una sesión para una persona ya comprobada por otro medio (invitación
   * aceptada con una cuenta nueva), con `organizationId` como activa si
   * puede. La organización de plataforma nunca queda activa así: el personal
   * de plataforma pasa por el segundo factor.
   */
  async openSessionForUser(
    userId: string,
    options: { client: ClientInfo; organizationId: string | null },
  ): Promise<IssuedSession> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    const memberships = await this.memberships.listForUser(user.id);
    return this.openSession(user, memberships, options.client, {
      mfaVerified: false,
      preferredOrganizationId: options.organizationId,
    });
  }

  /**
   * Renovación rotativa (contrato O0 §5): el refresco llega en la cookie o en
   * el cuerpo; se rota siempre y se responde como el login.
   */
  async refresh(rawRefreshToken: string | null): Promise<IssuedSession> {
    const validated = await this.sessions.validateRefresh(rawRefreshToken);
    const { user, memberships } = await this.loadLiveSessionOwner(validated);

    let activeOrganizationId = validated.session.activeOrganizationId;
    if (!activeOrganizationId) {
      // Sin organización activa (p. ej. acaba de registrar su bodega): la de
      // por defecto (la de plataforma solo si la sesión pasó el TOTP)
      activeOrganizationId = pickActiveOrganizationId(
        memberships,
        user.lastOrganizationId,
        { allowPlatform: Boolean(validated.session.mfaVerifiedAt) },
      );
    }
    return this.rotateAndIssue(
      validated,
      user,
      memberships,
      activeOrganizationId,
    );
  }

  /**
   * Cambia la organización activa (IAM-08): misma sesión (`sid`), tokens
   * nuevos. Exige el refresco vigente de esa misma sesión (cookie o cuerpo),
   * que se rota: con un acceso robado no se obtiene una renovación.
   */
  async switchOrganization(
    principal: AuthenticatedUser,
    organizationId: string,
    rawRefreshToken: string | null,
  ): Promise<IssuedSession> {
    const membership = await this.memberships.findForUser(
      principal.id,
      organizationId,
    );
    if (!membership) {
      throw new AppException(
        404,
        ErrorCode.ORG_NOT_FOUND,
        'Organización no encontrada',
      );
    }
    if (membership.status !== MembershipStatusEnum.ACTIVE) {
      throw new AppException(
        403,
        ErrorCode.ORG_MEMBERSHIP_BLOCKED,
        'Tu membresía en esta organización está bloqueada',
      );
    }
    if (membership.organizationStatus === OrganizationStatusEnum.REVOKED) {
      throw new AppException(
        403,
        ErrorCode.ORG_REVOKED,
        'La organización está revocada',
      );
    }

    if (membership.organizationType === 'PLATFORM') {
      const current = await this.sessions.findById(principal.sessionId);
      if (!current?.mfaVerifiedAt) {
        throw mfaRequiredError();
      }
    }

    const parsed = parseRefreshToken(rawRefreshToken);
    if (!parsed || parsed.sessionId !== principal.sessionId) {
      throw sessionUnauthorized(
        ErrorCode.AUTH_REFRESH_INVALID,
        'Falta el token de renovación de esta sesión',
      );
    }
    const validated = await this.sessions.validateRefresh(rawRefreshToken);
    const { user, memberships } = await this.loadLiveSessionOwner(validated, {
      skipActiveCheck: true,
    });

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastOrganizationId: organizationId },
    });
    const issued = await this.rotateAndIssue(
      validated,
      user,
      memberships,
      organizationId,
    );
    // En el periodo de gracia la rotación no escribe: se fija aquí
    await this.sessions.setActiveOrganization(
      validated.session.id,
      organizationId,
    );
    this.logger.log(
      `Sesión ${validated.session.id}: organización activa ${organizationId}`,
    );
    return issued;
  }

  /**
   * Cierra la sesión actual (IAM-04). Se identifica por el acceso (aunque haya
   * caducado) o por el refresco; sin ninguno válido no hace nada (204).
   */
  async logout(
    accessToken: string | null,
    rawRefreshToken: string | null,
  ): Promise<void> {
    let sessionId: string | null = null;
    if (accessToken) {
      try {
        const claims = await this.accessTokens.verify(accessToken, {
          ignoreExpiration: true,
        });
        sessionId = typeof claims.sid === 'string' ? claims.sid : null;
      } catch {
        sessionId = null;
      }
    }
    if (!sessionId) {
      sessionId = await this.sessions.identifyByRefresh(rawRefreshToken);
    }
    if (sessionId) {
      await this.sessions.revoke(sessionId, RevocationReason.LOGOUT);
    }
  }

  /** Cierra todas las sesiones de la persona (IAM-04). */
  async logoutAll(principal: AuthenticatedUser): Promise<number> {
    return this.sessions.revokeAllForUser(
      principal.id,
      RevocationReason.LOGOUT_ALL,
    );
  }

  // ─── Internos ──────────────────────────────────────────────────────────

  /**
   * Abre una sesión nueva (login, signup, segundo factor, invitación). La
   * organización de plataforma solo queda activa si pasó el segundo factor.
   */
  private async openSession(
    user: SessionUser,
    memberships: MembershipView[],
    client: ClientInfo,
    options: {
      mfaVerified?: boolean;
      preferredOrganizationId?: string | null;
    } = {},
  ): Promise<IssuedSession> {
    const audience = audienceFor(memberships);
    const mfaVerified = options.mfaVerified ?? false;
    const activeOrganizationId = pickActiveOrganizationId(
      memberships,
      options.preferredOrganizationId !== undefined
        ? options.preferredOrganizationId
        : user.lastOrganizationId,
      { allowPlatform: mfaVerified },
    );
    const { session, refreshToken } = await this.sessions.create({
      userId: user.id,
      audience,
      activeOrganizationId,
      client,
      mfaVerified,
    });
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        lastLoginAt: new Date(),
        ...(activeOrganizationId
          ? { lastOrganizationId: activeOrganizationId }
          : {}),
      },
    });
    const accessToken = await this.signAccess(
      user,
      memberships,
      activeOrganizationId,
      session.id,
    );
    return {
      body: this.buildBody(
        user,
        memberships,
        activeOrganizationId,
        accessToken,
        refreshToken,
      ),
      refreshToken,
      cookieMaxAgeSeconds: this.sessions.ttlSecondsFor(audience),
    };
  }

  /**
   * Dueño vivo de la sesión: persona activa y, si hay organización activa,
   * membresía utilizable en ella. Si no, revoca la sesión (IAM-13) y 401.
   */
  private async loadLiveSessionOwner(
    validated: ValidatedRefresh,
    options: { skipActiveCheck?: boolean } = {},
  ): Promise<{ user: SessionUser; memberships: MembershipView[] }> {
    const { session } = validated;
    const user = await this.prisma.user.findUnique({
      where: { id: session.userId },
    });
    if (!user || !user.isActive) {
      await this.sessions.revoke(session.id, RevocationReason.USER_BLOCKED);
      throw sessionUnauthorized(
        ErrorCode.AUTH_SESSION_REVOKED,
        'La sesión fue revocada',
      );
    }
    const memberships = await this.memberships.listForUser(user.id);
    if (session.activeOrganizationId && !options.skipActiveCheck) {
      const active = memberships.find(
        (m) => m.organizationId === session.activeOrganizationId,
      );
      if (!active || !isUsableMembership(active)) {
        await this.sessions.revoke(
          session.id,
          RevocationReason.MEMBERSHIP_BLOCKED,
        );
        throw sessionUnauthorized(
          ErrorCode.AUTH_SESSION_REVOKED,
          'La sesión fue revocada',
        );
      }
    }
    // Sesión de plataforma sin segundo factor (abierta antes de exigirlo)
    if (
      !session.mfaVerifiedAt &&
      isPlatformOrganization(memberships, session.activeOrganizationId)
    ) {
      await this.sessions.revoke(session.id, RevocationReason.MFA_REQUIRED);
      throw sessionUnauthorized(
        ErrorCode.AUTH_SESSION_REVOKED,
        'La sesión fue revocada: vuelve a entrar con tu segundo factor',
      );
    }
    return { user, memberships };
  }

  /** Rota (o reutiliza en el periodo de gracia) y firma el acceso. */
  private async rotateAndIssue(
    validated: ValidatedRefresh,
    user: SessionUser,
    memberships: MembershipView[],
    activeOrganizationId: string | null,
  ): Promise<IssuedSession> {
    const audience = audienceFor(memberships);
    const { session, refreshToken } = await this.sessions.rotate(validated, {
      audience,
      activeOrganizationId,
    });

    let accessToken: string | null = null;
    if (validated.kind === 'grace') {
      accessToken = await this.revocations.readGraceAccess(
        session.id,
        session.generation,
      );
    }
    if (!accessToken) {
      accessToken = await this.signAccess(
        user,
        memberships,
        activeOrganizationId,
        session.id,
      );
      await this.revocations.saveGraceAccess(
        session.id,
        session.generation,
        accessToken,
      );
    }
    return {
      body: this.buildBody(
        user,
        memberships,
        activeOrganizationId,
        accessToken,
        refreshToken,
      ),
      refreshToken,
      cookieMaxAgeSeconds: this.sessions.ttlSecondsFor(audience),
    };
  }

  private async signAccess(
    user: SessionUser,
    memberships: MembershipView[],
    activeOrganizationId: string | null,
    sessionId: string,
  ): Promise<string> {
    const active = memberships.find(
      (m) => m.organizationId === activeOrganizationId,
    );
    const compat = this.compatFields(user, active);
    return this.accessTokens.sign({
      sub: user.id,
      aud: audienceFor(memberships),
      org: active?.organizationId ?? null,
      orgType: active?.organizationType ?? null,
      role: active?.role ?? null,
      sid: sessionId,
      email: user.email,
      ...compat,
    });
  }

  private compatFields(user: SessionUser, active: MembershipView | undefined) {
    const winery = active?.organizationType === 'WINERY' ? active : undefined;
    return {
      userRole: legacyUserRoleFor(
        active?.organizationType ?? null,
        active?.role ?? null,
        user.userRole,
      ),
      wineryId: winery?.organizationId ?? null,
      memberRole: winery?.role ?? null,
    };
  }

  private buildBody(
    user: SessionUser,
    memberships: MembershipView[],
    activeOrganizationId: string | null,
    accessToken: string,
    refreshToken: string,
  ): AuthResponseDto {
    const active = memberships.find(
      (m) => m.organizationId === activeOrganizationId,
    );
    return {
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        phoneNumber: user.phoneNumber,
        preferredLocale: user.preferredLocale,
        audience: audienceFor(memberships),
        ...this.compatFields(user, active),
      },
      memberships,
      activeOrganizationId: active?.organizationId ?? null,
      tokens: {
        accessToken,
        tokenType: 'Bearer',
        expiresIn: this.accessTokens.ttlSeconds,
        refreshToken,
      },
    };
  }
}
