import { Injectable, Logger } from '@nestjs/common';
import {
  Membership,
  MembershipBlockedByEnum,
  MembershipRoleEnum,
  MembershipStatusEnum,
  OrganizationStatusEnum,
  OrganizationTypeEnum,
  User,
} from '@prisma/client';
import { PrismaService } from '@shared/prisma/prisma.service';
import { AuditService, AUDIT_TX_OPTIONS } from '@shared/audit/audit.service';
import { AuditAction } from '@shared/audit/audit.actions';
import { AppException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';
import { getRequestContext } from '@shared/context/request-context';
import { toPage } from '@shared/dto/pagination-query.dto';
import type { Paginated } from '@shared/interfaces/api-response.interface';
import type { AuthenticatedUser } from '@shared/decorators/current-user.decorator';
import { MailService } from '@modules/mail/mail.service';
import { PLATFORM_ORGANIZATION_ID } from '@modules/organizations/organization.constants';
import { MembershipsService } from '@modules/organizations/memberships.service';
import {
  RevocationReason,
  SessionsService,
} from '@modules/auth/sessions/sessions.service';
import { MfaService } from '@modules/auth/mfa/mfa.service';
import { AccountService } from '@modules/auth/account/account.service';
import { InvitationsService } from '@modules/invitations/invitations.service';
import {
  CreatePlatformUserDto,
  InvitationDto,
  InvitationsQueryDto,
  PlatformCreateInvitationDto,
} from '@modules/invitations/dto/invitation.dto';
import {
  AccountDetailDto,
  PlatformUserDto,
  PlatformUsersQueryDto,
  UpdatePlatformUserDto,
  UserAccountStatusDto,
} from './dto/platform-users.dto';

type StaffMembership = Membership & {
  user: Pick<
    User,
    'id' | 'email' | 'fullName' | 'isActive' | 'lastLoginAt' | 'blockedReason'
  >;
};

function membershipNotFound(): AppException {
  return new AppException(
    404,
    ErrorCode.NOT_FOUND,
    'Membresía de plataforma no encontrada',
  );
}

function userNotFound(): AppException {
  return new AppException(
    404,
    ErrorCode.USER_NOT_FOUND,
    'Persona no encontrada',
  );
}

function superadminProtected(): AppException {
  return new AppException(
    403,
    ErrorCode.PLATFORM_SUPERADMIN_PROTECTED,
    'El superusuario no se puede bloquear ni degradar',
  );
}

function cannotModifySelf(message: string): AppException {
  return new AppException(403, ErrorCode.ORG_CANNOT_MODIFY_SELF, message);
}

/**
 * Usuarios internos y acciones del back office sobre personas (PLT-02…05;
 * contrato O1 §5 y §11 bis). Cada acción deja su entrada en la bitácora con
 * el motivo en la misma transacción; las sesiones afectadas se revocan al
 * confirmar.
 */
@Injectable()
export class PlatformUsersService {
  private readonly logger = new Logger(PlatformUsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly memberships: MembershipsService,
    private readonly sessions: SessionsService,
    private readonly mfa: MfaService,
    private readonly account: AccountService,
    private readonly invitations: InvitationsService,
  ) {}

  /** `GET /platform/users`: miembros de la plataforma + invitaciones pendientes. */
  async list(
    query: PlatformUsersQueryDto,
  ): Promise<Paginated<PlatformUserDto>> {
    const members = await this.prisma.membership.findMany({
      where: { organizationId: PLATFORM_ORGANIZATION_ID },
      include: { user: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const enrolled = await this.mfa.enrolledUserIds(
      members.map((m) => m.userId),
    );
    const pending = await this.invitations.pendingFor(PLATFORM_ORGANIZATION_ID);
    const accounts = await this.prisma.user.findMany({
      where: { email: { in: pending.map((i) => i.email) } },
      select: {
        id: true,
        email: true,
        fullName: true,
        isActive: true,
        blockedReason: true,
      },
    });
    const byEmail = new Map(accounts.map((a) => [a.email, a]));

    const items: PlatformUserDto[] = [
      ...members.map((m) => this.toView(m, enrolled.has(m.userId))),
      ...pending.map((i) => this.invitedView(i, byEmail.get(i.email))),
    ].filter(
      (u) =>
        (!query.status || u.status === query.status) &&
        (!query.role || u.role === query.role),
    );
    return toPage(
      items.slice(query.offset, query.offset + query.limit),
      items.length,
      query,
    );
  }

  /** `POST /platform/users`: invita a un usuario interno. */
  async invite(
    dto: CreatePlatformUserDto,
    principal: AuthenticatedUser,
  ): Promise<InvitationDto> {
    return this.invitations.create({
      organizationId: PLATFORM_ORGANIZATION_ID,
      email: dto.email,
      role: dto.role,
      invitedBy: await this.actor(principal),
      reason: dto.reason ?? null,
    });
  }

  /** `PATCH /platform/users/{membershipId}`: cambia el rol (con motivo). */
  async update(
    membershipId: string,
    dto: UpdatePlatformUserDto,
    principal: AuthenticatedUser,
  ): Promise<PlatformUserDto> {
    const membership = await this.findStaff(membershipId);
    if (membership.role === MembershipRoleEnum.SUPERADMIN) {
      throw superadminProtected();
    }
    if (dto.role && dto.role !== membership.role) {
      if (membership.userId === principal.id) {
        throw cannotModifySelf('No puedes cambiar tu propio rol');
      }
      const before = membership.role;
      await this.prisma.$transaction(async (tx) => {
        await tx.membership.update({
          where: { id: membership.id },
          data: { role: dto.role },
        });
        await this.audit.record(tx, {
          action: AuditAction.PLATFORM_USER_ROLE_CHANGED,
          resource: { type: 'membership', id: membership.id },
          organizationId: PLATFORM_ORGANIZATION_ID,
          before: { role: before },
          after: { role: dto.role },
          reason: dto.reason,
        });
      }, AUDIT_TX_OPTIONS);
      // El rol viaja en el acceso: sus sesiones de plataforma se cierran
      await this.memberships.revokeSessionsOf(
        membership,
        RevocationReason.ROLE_CHANGED,
      );
    }
    return this.view(membership.id);
  }

  /** `POST /platform/users/{membershipId}/block|unblock` (solo membresías de plataforma). */
  async setMembershipBlocked(
    membershipId: string,
    blocked: boolean,
    reason: string,
    principal: AuthenticatedUser,
  ): Promise<PlatformUserDto> {
    const membership = await this.findStaff(membershipId);
    if (membership.role === MembershipRoleEnum.SUPERADMIN) {
      throw superadminProtected();
    }
    if (membership.userId === principal.id) {
      throw cannotModifySelf('No puedes bloquearte a ti mismo');
    }
    const isBlocked = membership.status === MembershipStatusEnum.BLOCKED;
    if (isBlocked === blocked) {
      throw new AppException(
        409,
        ErrorCode.CONFLICT,
        blocked ? 'Ya está bloqueado' : 'No está bloqueado',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      if (blocked) {
        await this.memberships.setBlocked(tx, membership.id, {
          by: MembershipBlockedByEnum.PLATFORM,
          reason,
        });
      } else {
        await this.memberships.setUnblocked(tx, membership.id);
      }
      await this.audit.record(tx, {
        action: blocked
          ? AuditAction.PLATFORM_USER_BLOCKED
          : AuditAction.PLATFORM_USER_UNBLOCKED,
        resource: { type: 'membership', id: membership.id },
        organizationId: PLATFORM_ORGANIZATION_ID,
        before: { status: membership.status },
        after: { status: blocked ? 'BLOCKED' : 'ACTIVE' },
        reason,
      });
    }, AUDIT_TX_OPTIONS);
    if (blocked) {
      const revoked = await this.memberships.revokeSessionsOf(membership);
      this.logger.log(
        `Membresía de plataforma ${membership.id} bloqueada; ${revoked} sesiones revocadas`,
      );
    }
    return this.view(membership.id);
  }

  /** `POST /platform/users/{membershipId}/reset-mfa`: obliga a reinscribir el TOTP. */
  async resetMfa(
    membershipId: string,
    reason: string,
    principal: AuthenticatedUser,
  ): Promise<PlatformUserDto> {
    const membership = await this.findStaff(membershipId);
    if (
      membership.role === MembershipRoleEnum.SUPERADMIN &&
      principal.role !== MembershipRoleEnum.SUPERADMIN
    ) {
      throw superadminProtected();
    }
    await this.prisma.$transaction(async (tx) => {
      const wasEnabled = await this.mfa.reset(tx, membership.userId);
      await this.mail.enqueue(tx, {
        template: 'segundo-factor-restablecido',
        to: membership.user.email,
        variables: { nombre: membership.user.fullName },
      });
      await this.audit.record(tx, {
        action: AuditAction.MFA_RESET,
        resource: { type: 'membership', id: membership.id },
        organizationId: PLATFORM_ORGANIZATION_ID,
        before: { mfaEnabled: wasEnabled },
        after: { mfaEnabled: false },
        reason,
      });
    }, AUDIT_TX_OPTIONS);
    await this.sessions.revokeAllForUser(
      membership.userId,
      RevocationReason.MFA_RESET,
    );
    return this.view(membership.id);
  }

  /** `POST /platform/users/{userId}/send-password-reset` → 202. */
  async sendPasswordReset(
    userId: string,
    reason: string | null,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw userNotFound();
    }
    const platformMember = await this.prisma.membership.findUnique({
      where: {
        userId_organizationId: {
          userId,
          organizationId: PLATFORM_ORGANIZATION_ID,
        },
      },
      select: { id: true },
    });
    await this.prisma.$transaction(async (tx) => {
      await this.account.issuePasswordReset(
        tx,
        user,
        platformMember ? 'BACKOFFICE' : 'ERP',
        getRequestContext()?.ip ?? null,
      );
      await this.audit.record(tx, {
        action: AuditAction.USER_PASSWORD_RESET_SENT,
        resource: { type: 'user', id: user.id },
        organizationId: null,
        reason,
      });
    }, AUDIT_TX_OPTIONS);
  }

  /**
   * `POST /platform/accounts/{userId}/block|unblock`: la cuenta completa (no
   * entra a ningún sistema); bloquear revoca todas sus sesiones.
   */
  async setAccountBlocked(
    userId: string,
    blocked: boolean,
    reason: string,
    principal: AuthenticatedUser,
  ): Promise<UserAccountStatusDto> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw userNotFound();
    }
    const superadmin = await this.prisma.membership.findFirst({
      where: {
        userId,
        organizationId: PLATFORM_ORGANIZATION_ID,
        role: MembershipRoleEnum.SUPERADMIN,
      },
      select: { id: true },
    });
    if (superadmin) {
      throw superadminProtected();
    }
    if (user.id === principal.id) {
      throw cannotModifySelf('No puedes bloquear tu propia cuenta');
    }
    if (user.isActive !== blocked) {
      throw new AppException(
        409,
        ErrorCode.CONFLICT,
        blocked ? 'La cuenta ya está bloqueada' : 'La cuenta no está bloqueada',
      );
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.user.update({
        where: { id: user.id },
        data: blocked
          ? {
              isActive: false,
              blockedReason: reason.slice(0, 500),
              blockedAt: new Date(),
            }
          : { isActive: true, blockedReason: null, blockedAt: null },
      });
      await this.audit.record(tx, {
        action: blocked ? AuditAction.USER_BLOCKED : AuditAction.USER_UNBLOCKED,
        resource: { type: 'user', id: user.id },
        organizationId: null,
        before: { isActive: user.isActive },
        after: { isActive: row.isActive },
        reason,
      });
      return row;
    }, AUDIT_TX_OPTIONS);
    if (blocked) {
      const revoked = await this.sessions.revokeAllForUser(
        user.id,
        RevocationReason.USER_BLOCKED,
      );
      this.logger.log(
        `Cuenta ${user.id} bloqueada; ${revoked} sesiones revocadas`,
      );
    }
    return {
      userId: updated.id,
      email: updated.email,
      fullName: updated.fullName,
      status: updated.isActive ? 'ACTIVE' : 'BLOCKED',
      blockedReason: updated.isActive ? null : updated.blockedReason,
    };
  }

  /**
   * `POST /platform/organizations/{organizationId}/invitations`: invita en
   * nombre de una bodega `ACTIVE` o `SUSPENDED` y avisa a su dueño (EQP-10).
   */
  async inviteToOrganization(
    organizationId: string,
    dto: PlatformCreateInvitationDto,
    principal: AuthenticatedUser,
  ): Promise<InvitationDto> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
    });
    if (!organization || organization.type !== OrganizationTypeEnum.WINERY) {
      throw new AppException(
        404,
        ErrorCode.ORG_NOT_FOUND,
        'Organización no encontrada',
      );
    }
    if (
      organization.status !== OrganizationStatusEnum.ACTIVE &&
      organization.status !== OrganizationStatusEnum.SUSPENDED
    ) {
      throw new AppException(
        403,
        ErrorCode.ORG_NOT_ACTIVE,
        'La bodega no está activa',
        [{ field: null, message: organization.status }],
      );
    }
    return this.invitations.create({
      organizationId,
      email: dto.email,
      role: dto.role,
      invitedBy: await this.actor(principal),
      reason: dto.reason ?? null,
      notifyOwner: true,
    });
  }

  /** GET /platform/accounts/{userId} (ampliación O1): estado y membresías. */
  async accountDetail(userId: string): Promise<AccountDetailDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        memberships: {
          include: { organization: true },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        },
      },
    });
    if (!user) {
      throw userNotFound();
    }
    return {
      userId: user.id,
      fullName: user.fullName,
      email: user.email,
      status: user.isActive ? 'ACTIVE' : 'BLOCKED',
      blockedReason: user.isActive ? null : user.blockedReason,
      blockedAt: user.isActive ? null : (user.blockedAt?.toISOString() ?? null),
      memberships: user.memberships.map((m) => ({
        membershipId: m.id,
        organizationId: m.organizationId,
        organizationType: m.organization.type,
        organizationName: m.organization.name,
        organizationStatus: m.organization.status,
        role: m.role,
        status: m.status,
        blockedBy: m.blockedBy,
        blockedReason: m.blockedReason,
      })),
    };
  }

  /**
   * GET /platform/organizations/{organizationId}/invitations (ampliación
   * O1): invitaciones de una bodega o punto (las de plataforma, en /users).
   */
  async organizationInvitations(
    organizationId: string,
    query: InvitationsQueryDto,
  ): Promise<Paginated<InvitationDto>> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { type: true },
    });
    if (!organization || organization.type === OrganizationTypeEnum.PLATFORM) {
      throw new AppException(
        404,
        ErrorCode.ORG_NOT_FOUND,
        'Organización no encontrada',
      );
    }
    return this.invitations.list(organizationId, query);
  }

  // ─── Internos ──────────────────────────────────────────────────────────

  private async actor(principal: AuthenticatedUser) {
    return {
      userId: principal.id,
      fullName: await this.invitations.inviterName(principal.id),
      viaPlatform: true,
    };
  }

  private async findStaff(membershipId: string): Promise<StaffMembership> {
    const membership = await this.prisma.membership.findUnique({
      where: { id: membershipId },
      include: { user: true },
    });
    if (!membership || membership.organizationId !== PLATFORM_ORGANIZATION_ID) {
      throw membershipNotFound();
    }
    return membership;
  }

  private async view(membershipId: string): Promise<PlatformUserDto> {
    const membership = await this.findStaff(membershipId);
    const enrolled = await this.mfa.isEnrolled(membership.userId);
    return this.toView(membership, enrolled);
  }

  private toView(m: StaffMembership, mfaEnabled: boolean): PlatformUserDto {
    const accountBlocked = !m.user.isActive;
    const blocked = m.status === MembershipStatusEnum.BLOCKED || accountBlocked;
    return {
      membershipId: m.id,
      userId: m.userId,
      fullName: m.user.fullName,
      email: m.user.email,
      role: m.role as PlatformUserDto['role'],
      status: blocked ? 'BLOCKED' : 'ACTIVE',
      blockedBy: blocked ? 'PLATFORM' : null,
      blockedReason: blocked
        ? (m.blockedReason ?? m.user.blockedReason ?? null)
        : null,
      joinedAt: m.createdAt.toISOString(),
      lastLoginAt: m.user.lastLoginAt?.toISOString() ?? null,
      mfaEnabled,
      invitationId: null,
      accountStatus: accountBlocked ? 'BLOCKED' : 'ACTIVE',
      accountBlockedReason: accountBlocked ? m.user.blockedReason : null,
    };
  }

  private invitedView(
    invitation: InvitationDto,
    account:
      | {
          id: string;
          fullName: string;
          isActive: boolean;
          blockedReason: string | null;
        }
      | undefined,
  ): PlatformUserDto {
    return {
      membershipId: null,
      userId: account?.id ?? null,
      fullName: account?.fullName ?? invitation.email,
      email: invitation.email,
      role: invitation.role as PlatformUserDto['role'],
      status: 'INVITED',
      blockedBy: null,
      blockedReason: null,
      joinedAt: null,
      lastLoginAt: null,
      mfaEnabled: false,
      invitationId: invitation.id,
      accountStatus: account ? (account.isActive ? 'ACTIVE' : 'BLOCKED') : null,
      accountBlockedReason:
        account && !account.isActive ? account.blockedReason : null,
    };
  }
}
