import { Injectable, Logger } from '@nestjs/common';
import {
  Invitation,
  InvitationStatusEnum,
  MembershipBlockedByEnum,
  MembershipRoleEnum,
  MembershipStatusEnum,
  Organization,
  OrganizationStatusEnum,
  OrganizationTypeEnum,
  Prisma,
  WalletPurposeEnum,
  WineryMemberRoleEnum,
} from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '@shared/prisma/prisma.service';
import { AuditService, AUDIT_TX_OPTIONS } from '@shared/audit/audit.service';
import { AuditAction } from '@shared/audit/audit.actions';
import { AppException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';
import { ValidationException } from '@shared/exceptions/validation.exception';
import {
  generateOpaqueToken,
  hashOpaqueToken,
  isPlausibleToken,
} from '@shared/security/opaque-token';
import { toPage } from '@shared/dto/pagination-query.dto';
import type { Paginated } from '@shared/interfaces/api-response.interface';
import type { AuthenticatedUser } from '@shared/decorators/current-user.decorator';
import { MailService } from '@modules/mail/mail.service';
import { AppLinks, linkAppForOrganization } from '@modules/mail/app-links';
import { formatMailDate, roleLabel } from '@modules/mail/templates/account';
import { SettingsService } from '@modules/settings/settings.service';
import { MembershipsService } from '@modules/organizations/memberships.service';
import {
  PLATFORM_ORGANIZATION_ID,
  isRoleValidForType,
  legacyUserRoleForNewMember,
} from '@modules/organizations/organization.constants';
import { WalletsService } from '@modules/wallets/wallets.service';
import { AuthService } from '@modules/auth/auth.service';
import type { MfaChallengeBody } from '@modules/auth/mfa/mfa.service';
import { MfaService } from '@modules/auth/mfa/mfa.service';
import type { IssuedSession } from '@modules/auth/sessions/session-response';
import type { ClientInfo } from '@modules/auth/sessions/sessions.service';
import { parseRefreshToken } from '@modules/auth/sessions/refresh-token';
import { assertStrongPassword } from '@modules/auth/account/password-policy';
import { PASSWORD_BCRYPT_ROUNDS } from '@modules/auth/account/account.service';
import {
  AcceptInvitationDto,
  InvitationDto,
  InvitationPreviewDto,
} from './dto/invitation.dto';

/** Parámetros de la caducidad y del límite (docs-back/05 §4). */
export const INVITATION_TTL_SETTING = 'invitacion.caducidadHoras';
export const TEAM_LIMIT_SETTING = 'equipo.maxColaboradoresPorBodega';
const DEFAULT_TTL_HOURS = 72;

export type InvitationPurpose =
  'MEMBER' | 'OWNER_ONBOARDING' | 'OWNERSHIP_TRANSFER';

export interface InvitationActor {
  userId: string;
  fullName: string;
  /** Invita el back office en nombre de la organización. */
  viaPlatform: boolean;
}

export interface CreateInvitationParams {
  organizationId: string;
  email: string;
  role: MembershipRoleEnum;
  invitedBy: InvitationActor;
  /** Motivo de la plataforma (bitácora). */
  reason?: string | null;
  /**
   * `MEMBER` (por defecto). `OWNER_ONBOARDING` (alta de bodega) y
   * `OWNERSHIP_TRANSFER` (transferencia) admiten el rol `OWNER` y no cuentan
   * para el límite de colaboradores.
   */
  purpose?: InvitationPurpose;
  /** Nombre propuesto (la persona elige el suyo al crear la cuenta). */
  inviteeName?: string | null;
  /** Datos del proceso que la crea (los lee su gancho al aceptar). */
  metadata?: Prisma.InputJsonObject | null;
  /** Aviso por correo al dueño de la organización (EQP-10). */
  notifyOwner?: boolean;
}

/** Invitación aceptada, en la transacción de la aceptación (ganchos). */
export interface InvitationAcceptedContext {
  tx: Prisma.TransactionClient;
  invitation: Invitation;
  organization: Organization;
  userId: string;
  membershipId: string;
}

/** Gancho de aceptación (p. ej. la parte B activa la bodega del dueño). */
export type InvitationAcceptHook = (
  ctx: InvitationAcceptedContext,
) => Promise<void>;

export type AcceptOutcome =
  | { kind: 'session'; issued: IssuedSession }
  | { kind: 'mfa'; body: MfaChallengeBody };

type InvitationWithOrganization = Invitation & { organization: Organization };

function notFound(): AppException {
  return new AppException(
    404,
    ErrorCode.INVITATION_NOT_FOUND,
    'La invitación no existe o el enlace ya no es válido',
  );
}

/** Estado que se presenta: una `PENDING` vencida es `EXPIRED`. */
export function effectiveStatus(
  invitation: Pick<Invitation, 'status' | 'expiresAt'>,
  now: Date = new Date(),
): InvitationStatusEnum {
  if (
    invitation.status === InvitationStatusEnum.PENDING &&
    invitation.expiresAt.getTime() <= now.getTime()
  ) {
    return InvitationStatusEnum.EXPIRED;
  }
  return invitation.status;
}

/** Filtro de Prisma por estado efectivo. */
export function statusWhere(
  status: InvitationStatusEnum,
  now: Date = new Date(),
): Prisma.InvitationWhereInput {
  switch (status) {
    case InvitationStatusEnum.PENDING:
      return { status, expiresAt: { gt: now } };
    case InvitationStatusEnum.EXPIRED:
      return {
        OR: [
          { status: InvitationStatusEnum.EXPIRED },
          { status: InvitationStatusEnum.PENDING, expiresAt: { lte: now } },
        ],
      };
    default:
      return { status };
  }
}

/** Clave del candado por organización (límite de colaboradores). */
function orgLockKey(organizationId: string): bigint {
  const hex = organizationId.replace(/-/g, '').slice(0, 15);
  return BigInt(`0x${hex}`);
}

/**
 * Invitaciones (IAM-10, EQP-02/03, PLT-02; contrato O1 §2 y docs-back/07 §2).
 *
 * - `create` es reutilizable: la usan el dueño, el back office, los usuarios
 *   internos y (parte B) el alta de bodegas y la transferencia, dentro de su
 *   propia transacción si la pasan.
 * - El token es aleatorio, de un solo uso, y solo se guarda su hash; caduca
 *   a las `invitacion.caducidadHoras` (72).
 * - Aceptar crea la cuenta (correo ya verificado) o añade la membresía a la
 *   cuenta existente con el **mismo correo**, y abre la sesión con la
 *   organización invitada activa (plataforma: reto del segundo factor).
 */
@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name);
  private readonly acceptHooks: InvitationAcceptHook[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly links: AppLinks,
    private readonly settings: SettingsService,
    private readonly memberships: MembershipsService,
    private readonly wallets: WalletsService,
    private readonly auth: AuthService,
    private readonly mfa: MfaService,
  ) {}

  /** Registra un gancho que corre en la transacción de cada aceptación. */
  onAccepted(hook: InvitationAcceptHook): void {
    this.acceptHooks.push(hook);
  }

  // ─── Crear ─────────────────────────────────────────────────────────────

  /**
   * Crea una invitación con sus reglas (§2), encola el correo y registra la
   * bitácora. Con `tx`, dentro de la transacción de quien llama.
   *
   * - `OWNER` solo con `purpose` de alta o transferencia → 403 `ORG_OWNER_ROLE_RESERVED`.
   * - Ya miembro (activo o bloqueado) → 409 `ORG_ALREADY_MEMBER`.
   * - Pendiente para el mismo correo → 409 `INVITATION_ALREADY_PENDING`.
   * - Bodega sin cupo (`equipo.maxColaboradoresPorBodega`, activos +
   *   pendientes) → 422 `ORG_MEMBER_LIMIT_REACHED`.
   */
  async create(
    params: CreateInvitationParams,
    tx?: Prisma.TransactionClient,
  ): Promise<InvitationDto> {
    const run = (client: Prisma.TransactionClient) =>
      this.createInTx(client, params);
    return tx ? run(tx) : this.prisma.$transaction(run, AUDIT_TX_OPTIONS);
  }

  private async createInTx(
    tx: Prisma.TransactionClient,
    params: CreateInvitationParams,
  ): Promise<InvitationDto> {
    const email = params.email.trim().toLowerCase();
    const purpose = params.purpose ?? 'MEMBER';
    const organization = await tx.organization.findUnique({
      where: { id: params.organizationId },
    });
    if (!organization) {
      throw new AppException(
        404,
        ErrorCode.ORG_NOT_FOUND,
        'Organización no encontrada',
      );
    }
    if (!isRoleValidForType(organization.type, params.role)) {
      throw ValidationException.forField(
        'role',
        `El rol ${params.role} no existe en una organización ${organization.type}`,
      );
    }
    if (params.role === MembershipRoleEnum.SUPERADMIN) {
      throw ValidationException.forField(
        'role',
        'El rol SUPERADMIN no se asigna por invitación',
      );
    }
    if (params.role === MembershipRoleEnum.OWNER && purpose === 'MEMBER') {
      throw new AppException(
        403,
        ErrorCode.ORG_OWNER_ROLE_RESERVED,
        'El rol de dueño solo se asigna en el alta de la bodega o al transferir la titularidad',
      );
    }

    // Serializa las invitaciones de la organización (cupo y duplicados)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${orgLockKey(organization.id)})`;

    const now = new Date();
    if (purpose !== 'OWNERSHIP_TRANSFER') {
      const member = await tx.membership.findFirst({
        where: {
          organizationId: organization.id,
          user: { email },
        },
        select: { id: true },
      });
      if (member) {
        throw new AppException(
          409,
          ErrorCode.ORG_ALREADY_MEMBER,
          'Esa persona ya es miembro de la organización',
        );
      }
    }
    const pending = await tx.invitation.findFirst({
      where: {
        organizationId: organization.id,
        email,
        ...statusWhere(InvitationStatusEnum.PENDING, now),
      },
      select: { id: true },
    });
    if (pending) {
      throw new AppException(
        409,
        ErrorCode.INVITATION_ALREADY_PENDING,
        'Ya hay una invitación pendiente para ese correo',
      );
    }
    if (
      organization.type === OrganizationTypeEnum.WINERY &&
      purpose === 'MEMBER'
    ) {
      await this.assertTeamCapacity(tx, organization.id, now);
    }

    const token = generateOpaqueToken();
    const ttlHours = await this.ttlHours();
    const invitation = await tx.invitation.create({
      data: {
        email,
        organizationId: organization.id,
        role: params.role,
        tokenHash: hashOpaqueToken(token),
        expiresAt: new Date(now.getTime() + ttlHours * 3600 * 1000),
        invitedByUserId: params.invitedBy.userId,
        invitedByName: params.invitedBy.fullName.slice(0, 200),
        viaPlatform: params.invitedBy.viaPlatform,
        inviteeName: params.inviteeName?.slice(0, 200) ?? null,
        purpose,
        metadata: params.metadata ?? Prisma.DbNull,
        lastSentAt: now,
      },
    });
    await this.sendInvitationMail(tx, invitation, organization, token);
    if (params.notifyOwner) {
      await this.notifyOwner(tx, organization, {
        cambio: `Se invitó a ${email} con el rol de ${roleLabel(params.role)}.`,
        motivo: params.reason ?? '',
      });
    }
    await this.audit.record(tx, {
      action:
        organization.type === OrganizationTypeEnum.PLATFORM
          ? AuditAction.PLATFORM_USER_INVITED
          : AuditAction.INVITATION_CREATED,
      resource: { type: 'invitation', id: invitation.id },
      organizationId: organization.id,
      after: {
        email,
        role: params.role,
        purpose,
        expiresAt: invitation.expiresAt,
      },
      reason: params.reason ?? null,
    });
    this.logger.log(
      `Invitación ${invitation.id} a ${organization.id} (${params.role})`,
    );
    return this.toView({ ...invitation, organization });
  }

  // ─── Leer ──────────────────────────────────────────────────────────────

  /** `GET /invitations/{token}` (público). */
  async preview(token: string): Promise<InvitationPreviewDto> {
    const invitation = await this.findByToken(token);
    const account = await this.prisma.user.findUnique({
      where: { email: invitation.email },
      select: { id: true },
    });
    return {
      email: invitation.email,
      organizationName: invitation.organization.name,
      organizationType: invitation.organization.type,
      role: invitation.role,
      invitedByName: invitation.invitedByName,
      expiresAt: invitation.expiresAt.toISOString(),
      status: effectiveStatus(invitation),
      accountExists: Boolean(account),
    };
  }

  /** Invitaciones de una organización (más recientes primero). */
  async list(
    organizationId: string,
    query: { status?: InvitationStatusEnum; limit: number; offset: number },
  ): Promise<Paginated<InvitationDto>> {
    const where: Prisma.InvitationWhereInput = {
      organizationId,
      ...(query.status ? statusWhere(query.status) : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.invitation.findMany({
        where,
        include: { organization: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.invitation.count({ where }),
    ]);
    return toPage(
      rows.map((r) => this.toView(r)),
      total,
      query,
    );
  }

  /** Pendientes (sin caducar) de una organización. */
  async pendingFor(organizationId: string): Promise<InvitationDto[]> {
    const rows = await this.prisma.invitation.findMany({
      where: {
        organizationId,
        ...statusWhere(InvitationStatusEnum.PENDING),
      },
      include: { organization: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((r) => this.toView(r));
  }

  // ─── Aceptar ───────────────────────────────────────────────────────────

  /**
   * `POST /invitations/{token}/accept`. Sin sesión crea la cuenta; con sesión
   * (y su refresco) añade la membresía a esa cuenta si es la del correo
   * invitado. Devuelve la sesión con la organización invitada activa o, si es
   * de plataforma, el reto del segundo factor.
   */
  async accept(
    token: string,
    dto: AcceptInvitationDto,
    principal: AuthenticatedUser | null,
    rawRefreshToken: string | null,
    client: ClientInfo,
  ): Promise<AcceptOutcome> {
    const invitation = await this.findByToken(token);
    this.assertAcceptable(invitation);
    const organization = invitation.organization;
    if (organization.status === OrganizationStatusEnum.REVOKED) {
      throw new AppException(
        403,
        ErrorCode.ORG_REVOKED,
        'La organización está revocada',
      );
    }

    const existing = await this.prisma.user.findUnique({
      where: { email: invitation.email },
    });
    let passwordHash: string | null = null;
    let fullName: string | null = null;
    if (existing) {
      if (!principal) {
        throw new AppException(
          401,
          ErrorCode.AUTH_LOGIN_REQUIRED,
          `Inicia sesión con ${invitation.email} para aceptar la invitación`,
        );
      }
      if (principal.id !== existing.id) {
        throw this.emailMismatch();
      }
      const parsed = parseRefreshToken(rawRefreshToken);
      if (
        organization.type !== OrganizationTypeEnum.PLATFORM &&
        (!parsed || parsed.sessionId !== principal.sessionId)
      ) {
        throw new AppException(
          401,
          ErrorCode.AUTH_REFRESH_INVALID,
          'Falta el token de renovación de esta sesión',
        );
      }
    } else {
      if (principal) {
        throw new AppException(
          403,
          ErrorCode.INVITATION_EMAIL_MISMATCH,
          'La invitación es para otro correo: cierra la sesión para crear la cuenta',
        );
      }
      const missing = [
        ...(dto.fullName
          ? []
          : [{ field: 'fullName', message: 'Obligatorio' }]),
        ...(dto.password
          ? []
          : [{ field: 'password', message: 'Obligatorio' }]),
      ];
      if (missing.length > 0) {
        throw new ValidationException(missing);
      }
      assertStrongPassword(dto.password, 'password', {
        email: invitation.email,
      });
      fullName = dto.fullName!.trim();
      passwordHash = await bcrypt.hash(dto.password!, PASSWORD_BCRYPT_ROUNDS);
    }

    const userId = await this.prisma.$transaction(async (tx) => {
      let uid: string;
      if (existing) {
        uid = existing.id;
      } else {
        const created = await tx.user.create({
          data: {
            email: invitation.email,
            fullName: fullName!,
            passwordHash: passwordHash!,
            userRole:
              organization.type === OrganizationTypeEnum.PLATFORM
                ? 'PLATFORM_ADMIN'
                : isRoleValidForType('WINERY', invitation.role)
                  ? legacyUserRoleForNewMember(
                      invitation.role as WineryMemberRoleEnum,
                    )
                  : 'CONSUMER',
            // El enlace llegó a ese buzón
            emailVerifiedAt: new Date(),
            isActive: true,
          },
        });
        uid = created.id;
        await this.wallets.provisionUserWallet(
          uid,
          WalletPurposeEnum.CONSUMER_NFT,
          tx,
        );
        await this.audit.record(tx, {
          action: AuditAction.USER_CREATED,
          resource: { type: 'user', id: uid },
          actor: { userId: uid, fullName: created.fullName },
          organizationId: organization.id,
          after: { email: created.email, via: 'INVITATION' },
        });
      }

      const accepted = await tx.invitation.updateMany({
        where: {
          id: invitation.id,
          status: InvitationStatusEnum.PENDING,
          expiresAt: { gt: new Date() },
        },
        data: {
          status: InvitationStatusEnum.ACCEPTED,
          acceptedAt: new Date(),
          acceptedByUserId: uid,
        },
      });
      if (accepted.count === 0) {
        throw new AppException(
          409,
          ErrorCode.INVITATION_NOT_PENDING,
          'La invitación ya no está pendiente',
        );
      }
      const membershipId = await this.join(tx, invitation, uid);
      await this.audit.record(tx, {
        action: AuditAction.INVITATION_ACCEPTED,
        resource: { type: 'invitation', id: invitation.id },
        actor: {
          userId: uid,
          role: invitation.role,
          organizationId: organization.id,
          viaPlatform: false,
        },
        organizationId: organization.id,
      });
      await this.audit.record(tx, {
        action: AuditAction.MEMBER_JOINED,
        resource: { type: 'membership', id: membershipId },
        actor: {
          userId: uid,
          role: invitation.role,
          organizationId: organization.id,
          viaPlatform: false,
        },
        organizationId: organization.id,
        after: { role: invitation.role, purpose: invitation.purpose },
      });
      for (const hook of this.acceptHooks) {
        await hook({ tx, invitation, organization, userId: uid, membershipId });
      }
      return uid;
    }, AUDIT_TX_OPTIONS);
    this.logger.log(`Invitación ${invitation.id} aceptada por ${userId}`);

    // Plataforma: siempre con el segundo factor (inscribirlo si es nueva)
    if (organization.type === OrganizationTypeEnum.PLATFORM) {
      const user = await this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
      });
      const body = await this.mfa.startChallenge(user, {
        client,
        organizationId: organization.id,
      });
      return { kind: 'mfa', body };
    }
    if (principal) {
      const issued = await this.auth.switchOrganization(
        principal,
        organization.id,
        rawRefreshToken,
      );
      return { kind: 'session', issued };
    }
    const issued = await this.auth.openSessionForUser(userId, {
      client,
      organizationId: organization.id,
    });
    return { kind: 'session', issued };
  }

  // ─── Reenviar y anular ─────────────────────────────────────────────────

  /** `POST /invitations/{id}/resend`: token y caducidad nuevos (el anterior deja de valer). */
  async resend(
    id: string,
    principal: AuthenticatedUser,
    reason: string | null,
  ): Promise<InvitationDto> {
    const invitation = await this.findManageable(id, principal);
    const status = effectiveStatus(invitation);
    if (
      status !== InvitationStatusEnum.PENDING &&
      status !== InvitationStatusEnum.EXPIRED
    ) {
      throw new AppException(
        409,
        ErrorCode.INVITATION_NOT_PENDING,
        `Solo se reenvían invitaciones pendientes o caducadas (esta está ${status})`,
      );
    }
    const token = generateOpaqueToken();
    const ttlHours = await this.ttlHours();
    const updated = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      if (
        status === InvitationStatusEnum.EXPIRED &&
        invitation.purpose === 'MEMBER' &&
        invitation.organization.type === OrganizationTypeEnum.WINERY
      ) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${orgLockKey(invitation.organizationId)})`;
        await this.assertTeamCapacity(tx, invitation.organizationId, now);
      }
      const row = await tx.invitation.update({
        where: { id: invitation.id },
        data: {
          status: InvitationStatusEnum.PENDING,
          tokenHash: hashOpaqueToken(token),
          expiresAt: new Date(now.getTime() + ttlHours * 3600 * 1000),
          sentCount: { increment: 1 },
          lastSentAt: now,
        },
        include: { organization: true },
      });
      await this.sendInvitationMail(tx, row, row.organization, token);
      await this.audit.record(tx, {
        action: AuditAction.INVITATION_RESENT,
        resource: { type: 'invitation', id: row.id },
        organizationId: row.organizationId,
        before: { status, expiresAt: invitation.expiresAt },
        after: { status: row.status, expiresAt: row.expiresAt },
        reason,
      });
      return row;
    }, AUDIT_TX_OPTIONS);
    return this.toView(updated);
  }

  /** `POST /invitations/{id}/revoke`: solo pendientes. */
  async revoke(
    id: string,
    principal: AuthenticatedUser,
    reason: string | null,
  ): Promise<InvitationDto> {
    const invitation = await this.findManageable(id, principal);
    const status = effectiveStatus(invitation);
    if (status !== InvitationStatusEnum.PENDING) {
      throw new AppException(
        409,
        ErrorCode.INVITATION_NOT_PENDING,
        `Solo se anulan invitaciones pendientes (esta está ${status})`,
      );
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const changed = await tx.invitation.updateMany({
        where: { id: invitation.id, status: InvitationStatusEnum.PENDING },
        data: { status: InvitationStatusEnum.REVOKED, revokedAt: new Date() },
      });
      if (changed.count === 0) {
        throw new AppException(
          409,
          ErrorCode.INVITATION_NOT_PENDING,
          'La invitación ya no está pendiente',
        );
      }
      await this.audit.record(tx, {
        action: AuditAction.INVITATION_REVOKED,
        resource: { type: 'invitation', id: invitation.id },
        organizationId: invitation.organizationId,
        before: { status },
        after: { status: InvitationStatusEnum.REVOKED },
        reason,
      });
      return tx.invitation.findUniqueOrThrow({
        where: { id: invitation.id },
        include: { organization: true },
      });
    }, AUDIT_TX_OPTIONS);
    return this.toView(updated);
  }

  // ─── Utilidades ────────────────────────────────────────────────────────

  /** Nombre de quien invita (se guarda tal cual en la invitación). */
  async inviterName(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { fullName: true },
    });
    return user?.fullName ?? 'Drinks on Chain';
  }

  /** Miembros activos + invitaciones pendientes (sin caducar). */
  async teamSize(
    client: Prisma.TransactionClient | PrismaService,
    organizationId: string,
    now: Date = new Date(),
  ): Promise<number> {
    const [members, pending] = await Promise.all([
      client.membership.count({
        where: { organizationId, status: MembershipStatusEnum.ACTIVE },
      }),
      client.invitation.count({
        where: {
          organizationId,
          ...statusWhere(InvitationStatusEnum.PENDING, now),
        },
      }),
    ]);
    return members + pending;
  }

  toView(row: InvitationWithOrganization): InvitationDto {
    return {
      id: row.id,
      email: row.email,
      organizationId: row.organizationId,
      organizationType: row.organization.type,
      organizationName: row.organization.name,
      role: row.role,
      status: effectiveStatus(row),
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      invitedBy: {
        userId: row.invitedByUserId ?? '',
        fullName: row.invitedByName,
        viaPlatform: row.viaPlatform,
      },
    };
  }

  private async ttlHours(): Promise<number> {
    try {
      const value = await this.settings.effective<number>(
        INVITATION_TTL_SETTING,
      );
      return typeof value === 'number' && value > 0 ? value : DEFAULT_TTL_HOURS;
    } catch (error) {
      this.logger.warn(
        `No se pudo leer ${INVITATION_TTL_SETTING}: ${error instanceof Error ? error.message : String(error)}; se usan ${DEFAULT_TTL_HOURS} h`,
      );
      return DEFAULT_TTL_HOURS;
    }
  }

  private async assertTeamCapacity(
    tx: Prisma.TransactionClient,
    organizationId: string,
    now: Date,
  ): Promise<void> {
    const limit = await this.settings.effective<number | null>(
      TEAM_LIMIT_SETTING,
      organizationId,
    );
    if (typeof limit !== 'number') {
      return;
    }
    const size = await this.teamSize(tx, organizationId, now);
    if (size >= limit) {
      throw new AppException(
        422,
        ErrorCode.ORG_MEMBER_LIMIT_REACHED,
        `La bodega alcanzó su límite de ${limit} colaboradores (miembros activos + invitaciones pendientes)`,
        [{ field: 'email', message: `Límite de ${limit} colaboradores` }],
      );
    }
  }

  private async findByToken(
    token: string,
  ): Promise<InvitationWithOrganization> {
    if (!isPlausibleToken(token)) {
      throw notFound();
    }
    const invitation = await this.prisma.invitation.findUnique({
      where: { tokenHash: hashOpaqueToken(token) },
      include: { organization: true },
    });
    if (!invitation) {
      throw notFound();
    }
    return invitation;
  }

  private assertAcceptable(invitation: Invitation): void {
    const status = effectiveStatus(invitation);
    if (status === InvitationStatusEnum.EXPIRED) {
      throw new AppException(
        422,
        ErrorCode.INVITATION_EXPIRED,
        'La invitación caducó: pide que te la reenvíen',
        [{ field: 'token', message: 'Invitación caducada' }],
      );
    }
    if (status !== InvitationStatusEnum.PENDING) {
      throw new AppException(
        409,
        ErrorCode.INVITATION_NOT_PENDING,
        `La invitación ya no está pendiente (${status})`,
      );
    }
  }

  private emailMismatch(): AppException {
    return new AppException(
      403,
      ErrorCode.INVITATION_EMAIL_MISMATCH,
      'La invitación es para otro correo',
    );
  }

  /**
   * ¿Puede gestionar (reenviar, anular) esta invitación? El dueño (o
   * encargado) de su organización, activa y en estado `ACTIVE`, o el personal
   * de plataforma (las de plataforma, solo administración). Si no, 404.
   */
  private async findManageable(
    id: string,
    principal: AuthenticatedUser,
  ): Promise<InvitationWithOrganization> {
    const invitation = await this.prisma.invitation.findUnique({
      where: { id },
      include: { organization: true },
    });
    if (!invitation) {
      throw notFound();
    }
    if (principal.organizationType === OrganizationTypeEnum.PLATFORM) {
      const admins: string[] = ['SUPERADMIN', 'ADMIN'];
      const staff: string[] = [...admins, 'OPERATIONS', 'SUPPORT'];
      const allowed =
        invitation.organization.type === OrganizationTypeEnum.PLATFORM
          ? admins
          : staff;
      if (!principal.role || !allowed.includes(principal.role)) {
        throw new AppException(
          403,
          ErrorCode.AUTH_INSUFFICIENT_PERMISSIONS,
          'Solo administración gestiona las invitaciones de usuarios internos',
        );
      }
      return invitation;
    }
    const isManager =
      principal.organizationId === invitation.organizationId &&
      (principal.role === 'OWNER' || principal.role === 'MANAGER');
    if (!isManager) {
      throw notFound();
    }
    if (principal.organizationStatus !== OrganizationStatusEnum.ACTIVE) {
      throw new AppException(
        403,
        ErrorCode.ORG_NOT_ACTIVE,
        'La organización no está activa',
        [{ field: null, message: principal.organizationStatus ?? 'UNKNOWN' }],
      );
    }
    return invitation;
  }

  /** Membresía de la invitación (nueva, reactivada o con el rol invitado). */
  private async join(
    tx: Prisma.TransactionClient,
    invitation: InvitationWithOrganization,
    userId: string,
  ): Promise<string> {
    const organization = invitation.organization;
    const existing = await tx.membership.findUnique({
      where: {
        userId_organizationId: { userId, organizationId: organization.id },
      },
    });

    if (organization.type === OrganizationTypeEnum.WINERY) {
      if (!existing) {
        const member = await this.memberships.addToWinery(tx, {
          wineryId: organization.id,
          userId,
          role: invitation.role as WineryMemberRoleEnum,
        });
        return member.id;
      }
      if (
        existing.status === MembershipStatusEnum.ACTIVE &&
        invitation.purpose !== 'OWNERSHIP_TRANSFER'
      ) {
        throw new AppException(
          409,
          ErrorCode.ORG_ALREADY_MEMBER,
          'Ya eres miembro de esta organización',
        );
      }
      if (
        existing.blockedBy === MembershipBlockedByEnum.PLATFORM &&
        !invitation.viaPlatform
      ) {
        throw new AppException(
          403,
          ErrorCode.ORG_BLOCKED_BY_PLATFORM,
          'La plataforma bloqueó tu acceso a esta organización',
        );
      }
      await tx.membership.update({
        where: { id: existing.id },
        data: {
          role: invitation.role,
          status: MembershipStatusEnum.ACTIVE,
          blockedBy: null,
          blockedReason: null,
          blockedAt: null,
        },
      });
      await tx.wineryMember.updateMany({
        where: { id: existing.id },
        data: {
          memberRole: invitation.role as WineryMemberRoleEnum,
          isActive: true,
        },
      });
      return existing.id;
    }

    if (existing) {
      throw new AppException(
        409,
        ErrorCode.ORG_ALREADY_MEMBER,
        'Ya eres miembro de esta organización',
      );
    }
    const membership = await tx.membership.create({
      data: {
        userId,
        organizationId: organization.id,
        role: invitation.role,
        status: MembershipStatusEnum.ACTIVE,
      },
    });
    return membership.id;
  }

  private async sendInvitationMail(
    tx: Prisma.TransactionClient,
    invitation: Invitation,
    organization: Organization,
    token: string,
  ): Promise<void> {
    const app = linkAppForOrganization(organization.type);
    await this.mail.enqueue(tx, {
      template: 'invitacion',
      to: invitation.email,
      organizationId:
        organization.id === PLATFORM_ORGANIZATION_ID ? null : organization.id,
      variables: {
        invitante: invitation.viaPlatform
          ? `${invitation.invitedByName} (equipo de Drinks on Chain)`
          : invitation.invitedByName,
        organizacion: organization.name,
        rol: roleLabel(invitation.role),
        enlace: this.links.invitation(app, token),
        caduca: formatMailDate(invitation.expiresAt),
      },
    });
  }

  /** Aviso al dueño de la organización (EQP-10), salvo que no haya. */
  async notifyOwner(
    tx: Prisma.TransactionClient,
    organization: Pick<Organization, 'id' | 'name'>,
    notice: { cambio: string; motivo: string; exceptUserId?: string },
  ): Promise<void> {
    const owners = await tx.membership.findMany({
      where: {
        organizationId: organization.id,
        role: MembershipRoleEnum.OWNER,
        status: MembershipStatusEnum.ACTIVE,
        ...(notice.exceptUserId
          ? { userId: { not: notice.exceptUserId } }
          : {}),
      },
      include: { user: { select: { email: true, fullName: true } } },
    });
    for (const owner of owners) {
      await this.mail.enqueue(tx, {
        template: 'aviso-equipo',
        to: owner.user.email,
        organizationId: organization.id,
        variables: {
          nombre: owner.user.fullName,
          organizacion: organization.name,
          cambio: notice.cambio,
          motivo: notice.motivo,
        },
      });
    }
  }
}
