import { Injectable, Logger } from '@nestjs/common';
import {
  MembershipBlockedByEnum,
  MembershipRoleEnum,
  MembershipStatusEnum,
  OrganizationStatusEnum,
  OrganizationTypeEnum,
  Prisma,
  WineryMember,
  WineryMemberRoleEnum,
} from '@prisma/client';
import { PrismaService } from '@shared/prisma/prisma.service';
import { AppException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';
import {
  RevocationReason,
  RevocationReasonValue,
  SessionsService,
} from '@modules/auth/sessions/sessions.service';
import { MembershipDto } from './dto/membership.dto';
import { ORGANIZATION_TYPE_PRIORITY } from './organization.constants';

export type MembershipView = MembershipDto;

/** Se puede activar: membresía ACTIVE en una organización no REVOKED. */
export function isUsableMembership(
  m: Pick<MembershipView, 'status' | 'organizationStatus'>,
): boolean {
  return (
    m.status === MembershipStatusEnum.ACTIVE &&
    m.organizationStatus !== OrganizationStatusEnum.REVOKED
  );
}

/**
 * Organización activa por defecto (contrato O0 §5): la última usada si sigue
 * siendo utilizable; si no, la primera membresía utilizable (plataforma antes
 * que bodega, y dentro del mismo tipo la más antigua); `null` si no hay.
 */
export function pickActiveOrganizationId(
  memberships: readonly MembershipView[],
  preferred?: string | null,
  options: { allowPlatform?: boolean } = {},
): string | null {
  const allowPlatform = options.allowPlatform ?? true;
  const usable = memberships.filter(
    (m) =>
      isUsableMembership(m) &&
      (allowPlatform || m.organizationType !== OrganizationTypeEnum.PLATFORM),
  );
  if (preferred && usable.some((m) => m.organizationId === preferred)) {
    return preferred;
  }
  return usable[0]?.organizationId ?? null;
}

/**
 * ¿Debe pasar el segundo factor al iniciar sesión? Sí si tiene una membresía
 * de plataforma activa (PLT-05, contrato O1 §1).
 */
export function requiresMfa(memberships: readonly MembershipView[]): boolean {
  return memberships.some(
    (m) =>
      m.organizationType === OrganizationTypeEnum.PLATFORM &&
      m.status === MembershipStatusEnum.ACTIVE,
  );
}

type MembershipWithOrganization = Prisma.MembershipGetPayload<{
  include: { organization: true };
}>;

function toView(m: MembershipWithOrganization): MembershipView {
  return {
    id: m.id,
    organizationId: m.organizationId,
    organizationType: m.organization.type,
    organizationName: m.organization.name,
    organizationStatus: m.organization.status,
    role: m.role,
    status: m.status,
  };
}

/**
 * Membresías (EQP-01, EQP-09, SE-01). Una persona puede tener varias; los
 * roles son por organización y ninguna operación de una bodega toca el rol
 * global (`users.user_role`, obsoleto) ni membresías de otra organización.
 */
@Injectable()
export class MembershipsService {
  private readonly logger = new Logger(MembershipsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
  ) {}

  /** Membresías de la persona en orden de preferencia (plataforma primero). */
  async listForUser(userId: string): Promise<MembershipView[]> {
    const rows = await this.prisma.membership.findMany({
      where: { userId },
      include: { organization: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows
      .map(toView)
      .sort(
        (a, b) =>
          ORGANIZATION_TYPE_PRIORITY[a.organizationType] -
          ORGANIZATION_TYPE_PRIORITY[b.organizationType],
      );
  }

  async findForUser(
    userId: string,
    organizationId: string,
  ): Promise<MembershipView | null> {
    const row = await this.prisma.membership.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
      include: { organization: true },
    });
    return row ? toView(row) : null;
  }

  /**
   * SE-01: incorpora a una persona a **esta** bodega, o reactiva su membresía
   * si estaba bloqueada por el dueño. Solo escribe la membresía de la bodega
   * (y su espejo obsoleto en `winery_members`, mismo id); nunca el rol global
   * ni membresías de otras organizaciones.
   *
   * - Ya es miembro activo → 409 `ORG_ALREADY_MEMBER`.
   * - Bloqueada por la plataforma → 403 `ORG_BLOCKED_BY_PLATFORM`.
   */
  async addToWinery(
    tx: Prisma.TransactionClient,
    params: {
      wineryId: string;
      userId: string;
      role: WineryMemberRoleEnum;
      professionalLicenseNumber?: string | null;
      professionalLicensePdfUrl?: string | null;
    },
  ): Promise<WineryMember> {
    const existing = await tx.membership.findUnique({
      where: {
        userId_organizationId: {
          userId: params.userId,
          organizationId: params.wineryId,
        },
      },
    });
    const legacy = await tx.wineryMember.findUnique({
      where: {
        userId_wineryId: { userId: params.userId, wineryId: params.wineryId },
      },
    });

    if (existing?.status === MembershipStatusEnum.ACTIVE) {
      throw new AppException(
        409,
        ErrorCode.ORG_ALREADY_MEMBER,
        'El usuario ya se encuentra registrado como miembro de esta bodega',
      );
    }
    if (existing?.blockedBy === MembershipBlockedByEnum.PLATFORM) {
      throw new AppException(
        403,
        ErrorCode.ORG_BLOCKED_BY_PLATFORM,
        'La plataforma bloqueó a esta persona en la bodega; solo la plataforma puede reactivarla',
      );
    }

    const role = MembershipRoleEnum[params.role];
    const license = {
      professionalLicenseNumber: params.professionalLicenseNumber ?? null,
      professionalLicensePdfUrl: params.professionalLicensePdfUrl ?? null,
    };

    // Espejo obsoleto en winery_members (autoría de la trazabilidad, mismo id)
    const member = legacy
      ? await tx.wineryMember.update({
          where: { id: legacy.id },
          data: { memberRole: params.role, isActive: true, ...license },
        })
      : await tx.wineryMember.create({
          data: {
            ...(existing ? { id: existing.id } : {}),
            userId: params.userId,
            wineryId: params.wineryId,
            memberRole: params.role,
            isActive: true,
            ...license,
          },
        });

    if (existing) {
      await tx.membership.update({
        where: { id: existing.id },
        data: {
          role,
          status: MembershipStatusEnum.ACTIVE,
          blockedBy: null,
          blockedReason: null,
          blockedAt: null,
        },
      });
    } else {
      await tx.membership.create({
        data: {
          id: member.id,
          userId: params.userId,
          organizationId: params.wineryId,
          role,
          status: MembershipStatusEnum.ACTIVE,
        },
      });
    }
    return member;
  }

  /**
   * Bloquea una membresía (EQP-06 / IAM-13): las sesiones de esa persona con
   * esa organización activa se revocan al instante.
   */
  async block(
    membershipId: string,
    params: { by: MembershipBlockedByEnum; reason?: string | null },
  ): Promise<void> {
    const membership = await this.prisma.$transaction((tx) =>
      this.setBlocked(tx, membershipId, params),
    );
    const revoked = await this.revokeSessionsOf(membership);
    this.logger.log(
      `Membresía ${membershipId} bloqueada por ${params.by}; ${revoked} sesiones revocadas`,
    );
  }

  /** Reactiva una membresía bloqueada. */
  async unblock(membershipId: string): Promise<void> {
    await this.prisma.$transaction((tx) => this.setUnblocked(tx, membershipId));
  }

  /**
   * Marca la membresía como bloqueada en la transacción `tx` (y su espejo en
   * `winery_members`). Quien llama revoca después las sesiones con
   * `revokeSessionsOf` (fuera de la transacción).
   */
  async setBlocked(
    tx: Prisma.TransactionClient,
    membershipId: string,
    params: { by: MembershipBlockedByEnum; reason?: string | null },
  ) {
    const updated = await tx.membership.update({
      where: { id: membershipId },
      data: {
        status: MembershipStatusEnum.BLOCKED,
        blockedBy: params.by,
        blockedReason: params.reason?.slice(0, 500) ?? null,
        blockedAt: new Date(),
      },
    });
    await tx.wineryMember.updateMany({
      where: { id: membershipId },
      data: { isActive: false },
    });
    return updated;
  }

  /** Reactiva la membresía en la transacción `tx`. */
  async setUnblocked(tx: Prisma.TransactionClient, membershipId: string) {
    const updated = await tx.membership.update({
      where: { id: membershipId },
      data: {
        status: MembershipStatusEnum.ACTIVE,
        blockedBy: null,
        blockedReason: null,
        blockedAt: null,
      },
    });
    await tx.wineryMember.updateMany({
      where: { id: membershipId },
      data: { isActive: true },
    });
    return updated;
  }

  /** Revoca las sesiones de la persona con esa organización activa. */
  async revokeSessionsOf(
    membership: { organizationId: string; userId: string },
    reason: RevocationReasonValue = RevocationReason.MEMBERSHIP_BLOCKED,
  ): Promise<number> {
    return this.sessions.revokeForOrganization(
      membership.organizationId,
      reason,
      membership.userId,
    );
  }
}
