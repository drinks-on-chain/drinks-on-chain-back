import { Injectable, Logger } from '@nestjs/common';
import {
  Membership,
  MembershipBlockedByEnum,
  MembershipRoleEnum,
  MembershipStatusEnum,
  Organization,
  OrganizationTypeEnum,
  Prisma,
  User,
  WineryMemberRoleEnum,
} from '@prisma/client';
import { PrismaService } from '@shared/prisma/prisma.service';
import { AuditService, AUDIT_TX_OPTIONS } from '@shared/audit/audit.service';
import { AuditAction } from '@shared/audit/audit.actions';
import { AppException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';
import { toPage } from '@shared/dto/pagination-query.dto';
import type { Paginated } from '@shared/interfaces/api-response.interface';
import type { AuthenticatedUser } from '@shared/decorators/current-user.decorator';
import { roleLabel } from '@modules/mail/templates/account';
import type { WineryRole } from '@modules/organizations/organization.constants';
import { MembershipsService } from '@modules/organizations/memberships.service';
import { RevocationReason } from '@modules/auth/sessions/sessions.service';
import { InvitationsService } from '@modules/invitations/invitations.service';
import { MemberDto, MembersQueryDto } from './dto/member.dto';

type MemberRow = Membership & {
  user: Pick<
    User,
    'id' | 'fullName' | 'email' | 'lastLoginAt' | 'isActive' | 'blockedReason'
  >;
};

/**
 * Cómo se ve el equipo: `FULL` (dueño), `BASIC` (el resto de roles: solo
 * nombres y roles de los miembros activos) o `PLATFORM` (back office, con el
 * estado de la cuenta completa).
 */
export type TeamView = 'FULL' | 'BASIC' | 'PLATFORM';

/** Quién actúa sobre el equipo. */
export interface TeamActor {
  principal: AuthenticatedUser;
  /** El back office sobre una bodega ajena (motivo obligatorio y aviso al dueño). */
  viaPlatform: boolean;
}

const USER_SELECT = {
  id: true,
  fullName: true,
  email: true,
  lastLoginAt: true,
  isActive: true,
  blockedReason: true,
} as const;

function memberNotFound(): AppException {
  return new AppException(404, ErrorCode.NOT_FOUND, 'Miembro no encontrado');
}

function toMember(row: MemberRow, view: TeamView): MemberDto {
  const member: MemberDto = {
    membershipId: row.id,
    userId: row.userId,
    fullName: row.user.fullName,
    email: row.user.email,
    role: row.role,
    status: row.status,
    blockedBy: row.blockedBy,
    blockedReason: row.blockedReason,
    joinedAt: row.createdAt.toISOString(),
    lastLoginAt:
      view === 'BASIC' ? null : (row.user.lastLoginAt?.toISOString() ?? null),
  };
  if (view === 'PLATFORM') {
    member.accountStatus = row.user.isActive ? 'ACTIVE' : 'BLOCKED';
    member.accountBlockedReason = row.user.isActive
      ? null
      : row.user.blockedReason;
  }
  return member;
}

/**
 * Equipo de una bodega (EQP-04…08, EQP-10; contrato O1 §5; docs-back/07 §3).
 * El dueño gestiona el de su bodega activa; el back office el de cualquiera
 * (con motivo y aviso por correo al dueño salvo que sea el afectado).
 *
 * - Nadie se cambia ni se bloquea a sí mismo → 403 `ORG_CANNOT_MODIFY_SELF`.
 * - El rol `OWNER` no se asigna ni se quita aquí (transferencia) → 403
 *   `ORG_OWNER_ROLE_RESERVED`.
 * - El dueño no desbloquea lo que bloqueó la plataforma → 403
 *   `ORG_BLOCKED_BY_PLATFORM`.
 * - Bloquear o cambiar el rol cierra al instante las sesiones de la persona
 *   con esa bodega activa (el rol viaja en el acceso).
 * - Desbloquear respeta el límite de colaboradores.
 */
@Injectable()
export class TeamService {
  private readonly logger = new Logger(TeamService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly memberships: MembershipsService,
    private readonly invitations: InvitationsService,
  ) {}

  /** Bodega de una ruta del back office: solo bodegas (si no, 404). */
  async wineryOrganization(organizationId: string): Promise<Organization> {
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
    return organization;
  }

  async list(
    organizationId: string,
    query: MembersQueryDto,
    view: TeamView,
  ): Promise<Paginated<MemberDto>> {
    const basic = view === 'BASIC';
    if (basic && query.status === MembershipStatusEnum.BLOCKED) {
      return toPage([], 0, query);
    }
    const where: Prisma.MembershipWhereInput = {
      organizationId,
      ...(basic
        ? { status: MembershipStatusEnum.ACTIVE }
        : query.status
          ? { status: query.status }
          : {}),
      ...(query.role ? { role: query.role } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.membership.findMany({
        where,
        include: { user: { select: USER_SELECT } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.membership.count({ where }),
    ]);
    return toPage(
      rows.map((r) => toMember(r, view)),
      total,
      query,
    );
  }

  async changeRole(
    organizationId: string,
    membershipId: string,
    role: WineryRole,
    actor: TeamActor,
    reason: string | null,
  ): Promise<MemberDto> {
    const view: TeamView = actor.viaPlatform ? 'PLATFORM' : 'FULL';
    const target = await this.findTarget(organizationId, membershipId, actor);
    if (
      role === MembershipRoleEnum.OWNER ||
      target.role === MembershipRoleEnum.OWNER
    ) {
      throw new AppException(
        403,
        ErrorCode.ORG_OWNER_ROLE_RESERVED,
        'El rol de dueño solo cambia con la transferencia de titularidad',
      );
    }
    if (target.role === role) {
      return toMember(target, view);
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.membership.update({
        where: { id: target.id },
        data: { role },
        include: { user: { select: USER_SELECT } },
      });
      await tx.wineryMember.updateMany({
        where: { id: target.id },
        data: { memberRole: role as WineryMemberRoleEnum },
      });
      if (actor.viaPlatform) {
        await this.notifyOwner(tx, organizationId, target, {
          cambio: `Se cambió el rol de ${target.user.fullName} de ${roleLabel(target.role)} a ${roleLabel(role)}.`,
          motivo: reason ?? '',
        });
      }
      await this.audit.record(tx, {
        action: AuditAction.MEMBER_ROLE_CHANGED,
        resource: { type: 'membership', id: target.id },
        organizationId,
        before: { role: target.role },
        after: { role },
        reason,
      });
      return row;
    }, AUDIT_TX_OPTIONS);
    await this.memberships.revokeSessionsOf(
      target,
      RevocationReason.ROLE_CHANGED,
    );
    return toMember(updated, view);
  }

  async setBlocked(
    organizationId: string,
    membershipId: string,
    blocked: boolean,
    actor: TeamActor,
    reason: string | null,
  ): Promise<MemberDto> {
    const view: TeamView = actor.viaPlatform ? 'PLATFORM' : 'FULL';
    const target = await this.findTarget(organizationId, membershipId, actor);
    const isBlocked = target.status === MembershipStatusEnum.BLOCKED;
    if (isBlocked === blocked) {
      throw new AppException(
        409,
        ErrorCode.CONFLICT,
        blocked
          ? 'El miembro ya está bloqueado'
          : 'El miembro no está bloqueado',
      );
    }
    if (
      !blocked &&
      !actor.viaPlatform &&
      target.blockedBy === MembershipBlockedByEnum.PLATFORM
    ) {
      throw new AppException(
        403,
        ErrorCode.ORG_BLOCKED_BY_PLATFORM,
        'Este bloqueo lo hizo el equipo de Drinks on Chain: solo la plataforma puede levantarlo',
      );
    }
    const by = actor.viaPlatform
      ? MembershipBlockedByEnum.PLATFORM
      : MembershipBlockedByEnum.OWNER;
    const updated = await this.prisma.$transaction(async (tx) => {
      if (blocked) {
        await this.memberships.setBlocked(tx, target.id, { by, reason });
      } else {
        await this.invitations.assertCapacityForMember(tx, organizationId);
        await this.memberships.setUnblocked(tx, target.id);
      }
      if (actor.viaPlatform) {
        await this.notifyOwner(tx, organizationId, target, {
          cambio: blocked
            ? `Se bloqueó a ${target.user.fullName} (${roleLabel(target.role)}): ya no puede entrar a la bodega.`
            : `Se desbloqueó a ${target.user.fullName} (${roleLabel(target.role)}): vuelve a tener acceso a la bodega.`,
          motivo: reason ?? '',
        });
      }
      await this.audit.record(tx, {
        action: blocked
          ? AuditAction.MEMBER_BLOCKED
          : AuditAction.MEMBER_UNBLOCKED,
        resource: { type: 'membership', id: target.id },
        organizationId,
        before: { status: target.status, blockedBy: target.blockedBy },
        after: blocked
          ? { status: MembershipStatusEnum.BLOCKED, blockedBy: by }
          : { status: MembershipStatusEnum.ACTIVE },
        reason,
      });
      return tx.membership.findUniqueOrThrow({
        where: { id: target.id },
        include: { user: { select: USER_SELECT } },
      });
    }, AUDIT_TX_OPTIONS);
    if (blocked) {
      const revoked = await this.memberships.revokeSessionsOf(target);
      this.logger.log(
        `Miembro ${target.id} bloqueado por ${by}; ${revoked} sesiones revocadas`,
      );
    }
    return toMember(updated, view);
  }

  /** Membresía de esa organización (si no, 404) que no sea la de quien actúa. */
  private async findTarget(
    organizationId: string,
    membershipId: string,
    actor: TeamActor,
  ): Promise<MemberRow> {
    const target = await this.prisma.membership.findUnique({
      where: { id: membershipId },
      include: { user: { select: USER_SELECT } },
    });
    if (!target || target.organizationId !== organizationId) {
      throw memberNotFound();
    }
    if (target.userId === actor.principal.id) {
      throw new AppException(
        403,
        ErrorCode.ORG_CANNOT_MODIFY_SELF,
        'No puedes cambiar ni bloquear tu propia membresía',
      );
    }
    return target;
  }

  /** Aviso al dueño (EQP-10), salvo que sea el afectado. */
  private async notifyOwner(
    tx: Prisma.TransactionClient,
    organizationId: string,
    target: MemberRow,
    notice: { cambio: string; motivo: string },
  ): Promise<void> {
    const organization = await tx.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { id: true, name: true },
    });
    await this.invitations.notifyOwner(tx, organization, {
      ...notice,
      exceptUserId: target.userId,
    });
  }
}
