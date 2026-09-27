import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  InvitationStatusEnum,
  MembershipBlockedByEnum,
  MembershipRoleEnum,
  MembershipStatusEnum,
  OrganizationTypeEnum,
  Prisma,
  Winery,
  WineryCategoryEnum,
  WineryMemberRoleEnum,
  WineryStatusEnum,
} from '@prisma/client';
import { PrismaService } from '@shared/prisma/prisma.service';
import { AuditService, AUDIT_TX_OPTIONS } from '@shared/audit/audit.service';
import { AuditAction, AuditActionCode } from '@shared/audit/audit.actions';
import { AppException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';
import { OutboxService } from '@shared/outbox/outbox.service';
import { QUEUE_CHAIN } from '@shared/queue/queue.constants';
import { toPage } from '@shared/dto/pagination-query.dto';
import type { Paginated } from '@shared/interfaces/api-response.interface';
import type { AuthenticatedUser } from '@shared/decorators/current-user.decorator';
import { MailService } from '@modules/mail/mail.service';
import { OrganizationsService } from '@modules/organizations/organizations.service';
import { MembershipsService } from '@modules/organizations/memberships.service';
import {
  RevocationReason,
  SessionsService,
} from '@modules/auth/sessions/sessions.service';
import {
  InvitationAcceptedContext,
  InvitationsService,
} from '@modules/invitations/invitations.service';
import { InvitationDto } from '@modules/invitations/dto/invitation.dto';
import { ensureLotPrefix, freeSlug } from '@modules/wineries/winery-codes';
import {
  WINERY_ACTIVATED,
  WINERY_AGGREGATE,
  WineryActivatedPayload,
} from '@modules/wineries/wineries.events';
import {
  CreatePlatformWineryDto,
  KeepPreviousOwnerAs,
  PublicWineryProfileDto,
  TransferOwnershipDto,
  UpdateCurrentOrganizationDto,
  UpdatePlatformWineryDto,
  WineriesQueryDto,
  WineryDetailDto,
  WinerySummaryDto,
  WineryWithInvitationDto,
} from './dto/winery.dto';
import {
  WINERY_DETAIL_INCLUDE,
  WINERY_SUMMARY_INCLUDE,
  toPublicProfile,
  toWineryDetail,
  toWinerySummary,
} from './winery-view';
import { assertSenasagFree, assertTaxIdFree } from './tax-id';

/** Quien actúa (bitácora, historial y "invitado por"). */
export interface ActorRef {
  userId: string | null;
  fullName: string;
}

/** Datos de una bodega nueva (alta directa o solicitud aprobada). */
export interface NewWineryData {
  legalName: string;
  tradeName: string;
  taxId: string;
  category: WineryCategoryEnum;
  region: string;
  contactEmail: string;
  contactPhone?: string | null;
  address?: string | null;
  senasagRegistration?: string | null;
  logoUrl?: string | null;
  publicStory?: string | null;
  website?: string | null;
}

export type WineryStatusAction = 'SUSPEND' | 'REACTIVATE' | 'REVOKE';

const STATUS_ACTIONS: Record<
  WineryStatusAction,
  {
    to: WineryStatusEnum;
    from: readonly WineryStatusEnum[];
    audit: AuditActionCode;
    label: string;
    effect: string;
  }
> = {
  SUSPEND: {
    to: WineryStatusEnum.SUSPENDED,
    from: [WineryStatusEnum.ACTIVE],
    audit: AuditAction.WINERY_SUSPENDED,
    label: 'suspendida',
    effect:
      'Mientras dure la suspensión nadie de la bodega puede operar el ERP; los datos se conservan y el perfil y la bitácora se pueden consultar.',
  },
  REACTIVATE: {
    to: WineryStatusEnum.ACTIVE,
    from: [WineryStatusEnum.SUSPENDED],
    audit: AuditAction.WINERY_REACTIVATED,
    label: 'reactivada',
    effect: 'La bodega vuelve a operar el ERP con normalidad.',
  },
  REVOKE: {
    to: WineryStatusEnum.REVOKED,
    from: [
      WineryStatusEnum.INVITED,
      WineryStatusEnum.ACTIVE,
      WineryStatusEnum.SUSPENDED,
    ],
    audit: AuditAction.WINERY_REVOKED,
    label: 'revocada',
    effect:
      'La bodega queda dada de baja de forma definitiva: nadie de la bodega puede volver a entrar en ella.',
  },
};

/** Campos del perfil: nombre en el DTO → columna de `wineries`. */
const PROFILE_FIELDS = {
  tradeName: 'commercialName',
  legalName: 'legalName',
  taxId: 'taxIdNit',
  category: 'beverageCategory',
  region: 'geographicRegion',
  address: 'address',
  senasagRegistration: 'senasagSanitaryReg',
  contactEmail: 'contactEmail',
  contactPhone: 'contactPhone',
  logoUrl: 'logoUrl',
  publicStory: 'publicStory',
  website: 'website',
} as const satisfies Record<string, keyof Winery>;

type ProfileField = keyof typeof PROFILE_FIELDS;

function wineryNotFound(): AppException {
  return new AppException(404, ErrorCode.ORG_NOT_FOUND, 'Bodega no encontrada');
}

function invalidTransition(message: string): AppException {
  return new AppException(409, ErrorCode.ORG_INVALID_TRANSITION, message);
}

interface TransferMetadata {
  previousOwnerMembershipId?: string;
  previousOwnerUserId?: string;
  keepPreviousOwnerAs?: KeepPreviousOwnerAs;
}

/**
 * Bodegas en el back office y perfil de la organización activa (ORG-03, 05,
 * 07…11; contrato O1 §4; docs/arquitectura/organizaciones.md).
 *
 * - Alta: bodega `INVITED` con `slug`, organización, historial y la
 *   invitación del dueño (`InvitationsService.create`) en **una** transacción.
 * - Activación (ORG-05): gancho `onAccepted` de las invitaciones de alta; la
 *   bodega pasa a `ACTIVE`, recibe su prefijo de lote y emite
 *   `winery.activated` por el outbox, dentro de la transacción de la
 *   aceptación.
 * - Suspender, reactivar, revocar y transferir, con motivo, aviso al dueño y
 *   las sesiones afectadas revocadas al confirmar.
 */
@Injectable()
export class WineryManagementService implements OnModuleInit {
  private readonly logger = new Logger(WineryManagementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly outbox: OutboxService,
    private readonly organizations: OrganizationsService,
    private readonly memberships: MembershipsService,
    private readonly sessions: SessionsService,
    private readonly invitations: InvitationsService,
  ) {}

  onModuleInit(): void {
    this.invitations.onAccepted((ctx) => this.onInvitationAccepted(ctx));
  }

  // ─── Lectura ───────────────────────────────────────────────────────────

  /** `GET /v1/platform/wineries`: directorio ordenado por nombre comercial. */
  async list(query: WineriesQueryDto): Promise<Paginated<WinerySummaryDto>> {
    const where: Prisma.WineryWhereInput = {
      ...(query.status ? { certificationStatus: query.status } : {}),
      ...(query.category ? { beverageCategory: query.category } : {}),
      ...(query.region
        ? {
            geographicRegion: { contains: query.region, mode: 'insensitive' },
          }
        : {}),
      ...(query.q
        ? {
            OR: [
              { legalName: { contains: query.q, mode: 'insensitive' } },
              { commercialName: { contains: query.q, mode: 'insensitive' } },
              { taxIdNit: { contains: query.q } },
              { slug: { contains: query.q.toLowerCase() } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.winery.findMany({
        where,
        include: WINERY_SUMMARY_INCLUDE,
        orderBy: [{ commercialName: 'asc' }, { id: 'asc' }],
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.winery.count({ where }),
    ]);
    return toPage(rows.map(toWinerySummary), total, query);
  }

  /** Ficha (`GET /v1/platform/wineries/{id}` y `/organizations/current`). */
  async detail(
    id: string,
    client: Pick<Prisma.TransactionClient, 'winery'> = this.prisma,
  ): Promise<WineryDetailDto> {
    const winery = await client.winery.findUnique({
      where: { id },
      include: WINERY_DETAIL_INCLUDE,
    });
    if (!winery) {
      throw wineryNotFound();
    }
    return toWineryDetail(winery);
  }

  /** `GET /v1/public/wineries/{slug}`: solo bodegas `ACTIVE`; si no, 404. */
  async publicProfile(slug: string): Promise<PublicWineryProfileDto> {
    if (!/^[a-z0-9-]{1,120}$/i.test(slug)) {
      throw wineryNotFound();
    }
    const winery = await this.prisma.winery.findUnique({
      where: { slug: slug.toLowerCase() },
    });
    if (!winery || winery.certificationStatus !== WineryStatusEnum.ACTIVE) {
      throw wineryNotFound();
    }
    return toPublicProfile(winery);
  }

  // ─── Alta ──────────────────────────────────────────────────────────────

  /**
   * Crea la bodega `INVITED` (con su organización, `slug` e historial) en la
   * transacción `tx`. La usan el alta directa y la aprobación de solicitudes.
   */
  async createInvitedWinery(
    tx: Prisma.TransactionClient,
    data: NewWineryData,
    actor: ActorRef,
    reason: string | null,
  ): Promise<Winery> {
    const slug = await freeSlug(tx, data.tradeName);
    const winery = await tx.winery.create({
      data: {
        legalName: data.legalName,
        commercialName: data.tradeName,
        beverageCategory: data.category,
        taxIdNit: data.taxId,
        senasagSanitaryReg: data.senasagRegistration ?? null,
        geographicRegion: data.region,
        address: data.address ?? null,
        contactEmail: data.contactEmail.toLowerCase(),
        contactPhone: data.contactPhone ?? null,
        logoUrl: data.logoUrl ?? null,
        publicStory: data.publicStory ?? null,
        website: data.website ?? null,
        slug,
        certificationStatus: WineryStatusEnum.INVITED,
      },
    });
    await this.organizations.createForWinery(tx, winery);
    await tx.wineryStatusChange.create({
      data: {
        wineryId: winery.id,
        status: WineryStatusEnum.INVITED,
        byUserId: actor.userId,
        byName: actor.fullName,
        reason,
      },
    });
    await this.audit.record(tx, {
      action: AuditAction.WINERY_CREATED,
      resource: { type: 'winery', id: winery.id },
      organizationId: winery.id,
      after: {
        status: WineryStatusEnum.INVITED,
        tradeName: winery.commercialName,
        taxId: winery.taxIdNit,
        slug,
      },
      reason,
    });
    return winery;
  }

  /** Invitación del dueño de una bodega recién creada (en la misma transacción). */
  async inviteOwner(
    tx: Prisma.TransactionClient,
    params: {
      wineryId: string;
      email: string;
      fullName: string | null;
      actor: ActorRef;
      reason: string | null;
    },
  ): Promise<InvitationDto> {
    return this.invitations.create(
      {
        organizationId: params.wineryId,
        email: params.email,
        role: MembershipRoleEnum.OWNER,
        invitedBy: {
          userId: params.actor.userId ?? '',
          fullName: params.actor.fullName,
          viaPlatform: true,
        },
        reason: params.reason,
        purpose: 'OWNER_ONBOARDING',
        inviteeName: params.fullName,
      },
      tx,
    );
  }

  /** `POST /v1/platform/wineries` (alta directa, camino B). */
  async createDirect(
    dto: CreatePlatformWineryDto,
    principal: AuthenticatedUser,
  ): Promise<WineryWithInvitationDto> {
    const actor = await this.actorOf(principal);
    const reason = dto.reason ?? null;
    const { wineryId, invitation } = await this.prisma.$transaction(
      async (tx) => {
        await assertTaxIdFree(tx, dto.taxId);
        await assertSenasagFree(tx, dto.senasagRegistration);
        const winery = await this.createInvitedWinery(tx, dto, actor, reason);
        const invitation = await this.inviteOwner(tx, {
          wineryId: winery.id,
          email: dto.ownerEmail,
          fullName: dto.ownerFullName,
          actor,
          reason,
        });
        return { wineryId: winery.id, invitation };
      },
      AUDIT_TX_OPTIONS,
    );
    this.logger.log(`Alta directa de la bodega ${wineryId} (INVITED)`);
    return { winery: await this.detail(wineryId), invitation };
  }

  // ─── Perfil ────────────────────────────────────────────────────────────

  /** `PATCH /v1/platform/wineries/{id}` (con motivo; datos legales incluidos). */
  async updateByPlatform(
    id: string,
    dto: UpdatePlatformWineryDto,
  ): Promise<WineryDetailDto> {
    const { reason, ...fields } = dto;
    return this.updateProfile(id, fields, reason);
  }

  /** `PATCH /v1/organizations/current` (dueño; sin NIT ni razón social). */
  async updateCurrent(
    wineryId: string,
    dto: UpdateCurrentOrganizationDto,
  ): Promise<WineryDetailDto> {
    return this.updateProfile(wineryId, dto, null);
  }

  private async updateProfile(
    id: string,
    fields: Partial<Record<ProfileField, unknown>>,
    reason: string | null,
  ): Promise<WineryDetailDto> {
    return this.prisma.$transaction(async (tx) => {
      const winery = await tx.winery.findUnique({ where: { id } });
      if (!winery) {
        throw wineryNotFound();
      }
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const data: Prisma.WineryUpdateInput = {};
      for (const [field, column] of Object.entries(PROFILE_FIELDS) as [
        ProfileField,
        keyof Winery,
      ][]) {
        const value = fields[field];
        if (value === undefined || value === winery[column]) continue;
        before[field] = winery[column];
        after[field] = value;
        (data as Record<string, unknown>)[column] = value;
      }
      if (Object.keys(after).length === 0) {
        return this.detail(id, tx);
      }
      if (typeof after.taxId === 'string') {
        await assertTaxIdFree(tx, after.taxId, { wineryId: id });
      }
      if (typeof after.senasagRegistration === 'string') {
        await assertSenasagFree(tx, after.senasagRegistration, id);
      }
      const updated = await tx.winery.update({ where: { id }, data });
      if (after.tradeName !== undefined) {
        await this.organizations.syncWinery(tx, updated);
      }
      await this.audit.record(tx, {
        action: AuditAction.WINERY_UPDATED,
        resource: { type: 'winery', id },
        organizationId: id,
        before,
        after,
        reason,
      });
      return this.detail(id, tx);
    }, AUDIT_TX_OPTIONS);
  }

  // ─── Estado ────────────────────────────────────────────────────────────

  /**
   * Suspender (desde `ACTIVE`), reactivar (desde `SUSPENDED`) o revocar
   * (desde `INVITED`, `ACTIVE` o `SUSPENDED`); si no, 409
   * `ORG_INVALID_TRANSITION`. Avisa al dueño; suspender y revocar cierran las
   * sesiones con la bodega activa; revocar anula sus invitaciones pendientes.
   */
  async changeStatus(
    id: string,
    action: WineryStatusAction,
    reason: string,
    principal: AuthenticatedUser,
  ): Promise<WineryDetailDto> {
    const rule = STATUS_ACTIONS[action];
    const actor = await this.actorOf(principal);
    const detail = await this.prisma.$transaction(async (tx) => {
      const winery = await tx.winery.findUnique({ where: { id } });
      if (!winery) {
        throw wineryNotFound();
      }
      const from = winery.certificationStatus;
      if (!rule.from.includes(from)) {
        throw invalidTransition(
          `La bodega está ${from} y no puede pasar a ${rule.to}`,
        );
      }
      const changed = await tx.winery.updateMany({
        where: { id, certificationStatus: from },
        data: { certificationStatus: rule.to },
      });
      if (changed.count === 0) {
        throw invalidTransition('La bodega cambió de estado mientras tanto');
      }
      const updated = await tx.winery.findUniqueOrThrow({ where: { id } });
      await this.organizations.syncWinery(tx, updated);
      await tx.wineryStatusChange.create({
        data: {
          wineryId: id,
          status: rule.to,
          byUserId: actor.userId,
          byName: actor.fullName,
          reason,
        },
      });
      if (rule.to === WineryStatusEnum.REVOKED) {
        await tx.invitation.updateMany({
          where: { organizationId: id, status: InvitationStatusEnum.PENDING },
          data: { status: InvitationStatusEnum.REVOKED, revokedAt: new Date() },
        });
      }
      for (const owner of await this.activeOwners(tx, id)) {
        await this.mail.enqueue(tx, {
          template: 'bodega-estado',
          to: owner.email,
          organizationId: id,
          variables: {
            nombre: owner.fullName,
            bodega: updated.commercialName,
            estado: rule.label,
            efecto: rule.effect,
            motivo: reason,
          },
        });
      }
      await this.audit.record(tx, {
        action: rule.audit,
        resource: { type: 'winery', id },
        organizationId: id,
        before: { status: from },
        after: { status: rule.to },
        reason,
      });
      return this.detail(id, tx);
    }, AUDIT_TX_OPTIONS);

    if (rule.to !== WineryStatusEnum.ACTIVE) {
      const revoked = await this.sessions.revokeForOrganization(
        id,
        rule.to === WineryStatusEnum.REVOKED
          ? RevocationReason.ORGANIZATION_REVOKED
          : RevocationReason.ORGANIZATION_SUSPENDED,
      );
      this.logger.log(
        `Bodega ${id} ${rule.label}; ${revoked} sesiones revocadas`,
      );
    }
    return detail;
  }

  // ─── Titularidad ───────────────────────────────────────────────────────

  /**
   * `POST /v1/platform/wineries/{id}/transfer-ownership` (administración):
   * invita a la nueva persona titular; al aceptar, la anterior pasa a
   * enóloga activa o bloqueada por la plataforma (`keepPreviousOwnerAs`,
   * `BLOCKED` por defecto). Una transferencia pendiente anterior se anula.
   */
  async transferOwnership(
    id: string,
    dto: TransferOwnershipDto,
    principal: AuthenticatedUser,
  ): Promise<WineryWithInvitationDto> {
    const actor = await this.actorOf(principal);
    const keep: KeepPreviousOwnerAs = dto.keepPreviousOwnerAs ?? 'BLOCKED';
    const invitation = await this.prisma.$transaction(async (tx) => {
      const winery = await tx.winery.findUnique({ where: { id } });
      if (!winery) {
        throw wineryNotFound();
      }
      if (
        winery.certificationStatus !== WineryStatusEnum.ACTIVE &&
        winery.certificationStatus !== WineryStatusEnum.SUSPENDED
      ) {
        throw invalidTransition(
          `No se transfiere la titularidad de una bodega ${winery.certificationStatus}`,
        );
      }
      const owner = await tx.membership.findFirst({
        where: {
          organizationId: id,
          role: MembershipRoleEnum.OWNER,
          status: MembershipStatusEnum.ACTIVE,
        },
        include: { user: { select: { id: true, email: true } } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      if (!owner) {
        throw new AppException(
          409,
          ErrorCode.CONFLICT,
          'La bodega no tiene un dueño activo',
        );
      }
      if (owner.user.email === dto.newOwnerEmail) {
        throw new AppException(
          409,
          ErrorCode.ORG_ALREADY_MEMBER,
          'Esa persona ya es la dueña de la bodega',
        );
      }
      await tx.invitation.updateMany({
        where: {
          organizationId: id,
          purpose: 'OWNERSHIP_TRANSFER',
          status: InvitationStatusEnum.PENDING,
        },
        data: { status: InvitationStatusEnum.REVOKED, revokedAt: new Date() },
      });
      const metadata: Prisma.InputJsonObject = {
        previousOwnerMembershipId: owner.id,
        previousOwnerUserId: owner.userId,
        keepPreviousOwnerAs: keep,
      };
      const created = await this.invitations.create(
        {
          organizationId: id,
          email: dto.newOwnerEmail,
          role: MembershipRoleEnum.OWNER,
          invitedBy: {
            userId: actor.userId ?? '',
            fullName: actor.fullName,
            viaPlatform: true,
          },
          reason: dto.reason,
          purpose: 'OWNERSHIP_TRANSFER',
          metadata,
        },
        tx,
      );
      await this.audit.record(tx, {
        action: AuditAction.WINERY_OWNERSHIP_TRANSFER_STARTED,
        resource: { type: 'winery', id },
        organizationId: id,
        before: { ownerUserId: owner.userId },
        after: {
          newOwnerEmail: dto.newOwnerEmail,
          keepPreviousOwnerAs: keep,
          invitationId: created.id,
        },
        reason: dto.reason,
      });
      return created;
    }, AUDIT_TX_OPTIONS);
    return { winery: await this.detail(id), invitation };
  }

  // ─── Aceptación de invitaciones de dueño ───────────────────────────────

  /** Gancho de `InvitationsService.accept` (en su transacción). */
  async onInvitationAccepted(
    ctx: InvitationAcceptedContext,
  ): Promise<void | (() => Promise<void>)> {
    if (ctx.organization.type !== OrganizationTypeEnum.WINERY) {
      return;
    }
    if (ctx.invitation.purpose === 'OWNER_ONBOARDING') {
      await this.activate(ctx);
      return;
    }
    if (ctx.invitation.purpose === 'OWNERSHIP_TRANSFER') {
      return this.completeTransfer(ctx);
    }
  }

  /**
   * Activación (ORG-05): `INVITED` → `ACTIVE`, prefijo de lote único,
   * `activatedAt` y el evento `winery.activated` del outbox. Solo desde
   * `INVITED` (reaceptar una invitación de dueño no reactiva una bodega
   * suspendida).
   */
  private async activate(ctx: InvitationAcceptedContext): Promise<void> {
    const { tx } = ctx;
    const winery = await tx.winery.findUnique({
      where: { id: ctx.organization.id },
    });
    if (!winery || winery.certificationStatus !== WineryStatusEnum.INVITED) {
      return;
    }
    const lotPrefix = await ensureLotPrefix(tx, winery);
    const owner = await tx.user.findUniqueOrThrow({
      where: { id: ctx.userId },
      select: { fullName: true },
    });
    const now = new Date();
    const updated = await tx.winery.update({
      where: { id: winery.id },
      data: {
        certificationStatus: WineryStatusEnum.ACTIVE,
        activatedAt: winery.activatedAt ?? now,
        approvedAt: winery.approvedAt ?? now,
      },
    });
    await this.organizations.syncWinery(tx, updated);
    await tx.wineryStatusChange.create({
      data: {
        wineryId: winery.id,
        status: WineryStatusEnum.ACTIVE,
        byUserId: ctx.userId,
        byName: owner.fullName,
        reason: null,
      },
    });
    await this.outbox.add<WineryActivatedPayload>(tx, {
      type: WINERY_ACTIVATED,
      aggregateType: WINERY_AGGREGATE,
      aggregateId: winery.id,
      queue: QUEUE_CHAIN,
      payload: {
        wineryId: winery.id,
        lotPrefix,
        ownerUserId: ctx.userId,
        activatedAt: (updated.activatedAt ?? now).toISOString(),
      },
    });
    await this.audit.record(tx, {
      action: AuditAction.WINERY_ACTIVATED,
      resource: { type: 'winery', id: winery.id },
      organizationId: winery.id,
      actor: {
        userId: ctx.userId,
        fullName: owner.fullName,
        role: MembershipRoleEnum.OWNER,
        organizationId: winery.id,
        viaPlatform: false,
      },
      before: { status: WineryStatusEnum.INVITED },
      after: {
        status: WineryStatusEnum.ACTIVE,
        lotPrefix,
        event: WINERY_ACTIVATED,
      },
    });
    this.logger.log(`Bodega ${winery.id} activada con el prefijo ${lotPrefix}`);
  }

  /**
   * Transferencia aceptada: la persona nueva ya es `OWNER` (la membresía la
   * escribe la aceptación); la anterior pasa a `ENOLOGIST`, activa o
   * bloqueada por la plataforma. Sus sesiones con la bodega se cierran al
   * confirmar.
   */
  private async completeTransfer(
    ctx: InvitationAcceptedContext,
  ): Promise<void | (() => Promise<void>)> {
    const { tx } = ctx;
    const meta = (ctx.invitation.metadata ?? {}) as TransferMetadata;
    const keep: KeepPreviousOwnerAs =
      meta.keepPreviousOwnerAs === 'ENOLOGIST' ? 'ENOLOGIST' : 'BLOCKED';
    const previous = meta.previousOwnerMembershipId
      ? await tx.membership.findUnique({
          where: { id: meta.previousOwnerMembershipId },
        })
      : null;
    const newOwner = await tx.user.findUniqueOrThrow({
      where: { id: ctx.userId },
      select: { fullName: true },
    });
    const demoted =
      previous &&
      previous.id !== ctx.membershipId &&
      previous.organizationId === ctx.organization.id &&
      previous.role === MembershipRoleEnum.OWNER;
    if (demoted) {
      await tx.membership.update({
        where: { id: previous.id },
        data: { role: MembershipRoleEnum.ENOLOGIST },
      });
      await tx.wineryMember.updateMany({
        where: { id: previous.id },
        data: { memberRole: WineryMemberRoleEnum.ENOLOGIST },
      });
      if (keep === 'BLOCKED') {
        await this.memberships.setBlocked(tx, previous.id, {
          by: MembershipBlockedByEnum.PLATFORM,
          reason: 'Titularidad transferida',
        });
      }
    }
    await this.audit.record(tx, {
      action: AuditAction.WINERY_OWNERSHIP_TRANSFERRED,
      resource: { type: 'winery', id: ctx.organization.id },
      organizationId: ctx.organization.id,
      actor: {
        userId: ctx.userId,
        fullName: newOwner.fullName,
        role: MembershipRoleEnum.OWNER,
        organizationId: ctx.organization.id,
        viaPlatform: false,
      },
      before: { ownerUserId: previous?.userId ?? null },
      after: {
        ownerUserId: ctx.userId,
        previousOwnerAs: demoted ? keep : null,
      },
    });
    if (!demoted) {
      return;
    }
    return async () => {
      await this.memberships.revokeSessionsOf(
        previous,
        RevocationReason.OWNERSHIP_TRANSFERRED,
      );
    };
  }

  // ─── Utilidades ────────────────────────────────────────────────────────

  async actorOf(principal: AuthenticatedUser): Promise<ActorRef> {
    return {
      userId: principal.id,
      fullName: await this.invitations.inviterName(principal.id),
    };
  }

  private async activeOwners(
    tx: Prisma.TransactionClient,
    wineryId: string,
  ): Promise<{ email: string; fullName: string }[]> {
    const rows = await tx.membership.findMany({
      where: {
        organizationId: wineryId,
        role: MembershipRoleEnum.OWNER,
        status: MembershipStatusEnum.ACTIVE,
      },
      include: { user: { select: { email: true, fullName: true } } },
    });
    return rows.map((r) => r.user);
  }
}
