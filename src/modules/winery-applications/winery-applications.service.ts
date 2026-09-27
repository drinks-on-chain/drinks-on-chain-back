import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  MembershipRoleEnum,
  MembershipStatusEnum,
  Prisma,
  WineryApplication,
  WineryApplicationNote,
  WineryApplicationStatusEnum as Status,
} from '@prisma/client';
import { PrismaService } from '@shared/prisma/prisma.service';
import { AuditService, AUDIT_TX_OPTIONS } from '@shared/audit/audit.service';
import { AuditAction } from '@shared/audit/audit.actions';
import { AppException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';
import { CaptchaService } from '@shared/captcha/captcha.service';
import {
  generateOpaqueToken,
  hashOpaqueToken,
  isPlausibleToken,
} from '@shared/security/opaque-token';
import { toPage } from '@shared/dto/pagination-query.dto';
import type { Paginated } from '@shared/interfaces/api-response.interface';
import type { AuthenticatedUser } from '@shared/decorators/current-user.decorator';
import { MailService } from '@modules/mail/mail.service';
import { AppLinks } from '@modules/mail/app-links';
import { PLATFORM_ORGANIZATION_ID } from '@modules/organizations/organization.constants';
import {
  ActorRef,
  WineryManagementService,
} from '@modules/winery-management/winery-management.service';
import { taxIdTaken, taxIdTakenError } from '@modules/winery-management/tax-id';
import {
  AddApplicationNoteDto,
  ApproveApplicationDto,
  ApproveApplicationResponseDto,
  CreateWineryApplicationDto,
  CreateWineryApplicationResponseDto,
  MeetingDoneDto,
  RejectApplicationDto,
  ScheduleMeetingDto,
  VerifyWineryApplicationDto,
  WineryApplicationDto,
  WineryApplicationSummaryDto,
  WineryApplicationsQueryDto,
} from './dto/winery-application.dto';
import { assertTransition, invalidTransition } from './application-transitions';

/** Vida del enlace de verificación del correo de contacto. */
export const APPLICATION_VERIFY_TTL_HOURS = 72;
/** Como mucho tantos envíos por correo de contacto y por IP en una hora (el resto, 202 sin nada). */
export const APPLICATION_LIMIT_PER_EMAIL_HOUR = 3;
export const APPLICATION_LIMIT_PER_IP_HOUR = 10;
/** Quién recibe los avisos de operaciones (docs-back/07 §11). */
export const OPERATIONS_NOTICE_ROLES: readonly MembershipRoleEnum[] = [
  MembershipRoleEnum.ADMIN,
  MembershipRoleEnum.OPERATIONS,
];

const HOUR_MS = 3_600_000;

type ApplicationWithNotes = WineryApplication & {
  notes: WineryApplicationNote[];
};

function notFound(): AppException {
  return new AppException(
    404,
    ErrorCode.NOT_FOUND,
    'Solicitud de alta no encontrada',
  );
}

function tokenInvalid(): AppException {
  return new AppException(
    422,
    ErrorCode.APPLICATION_TOKEN_INVALID,
    'El enlace de verificación no es válido, ya se usó o caducó',
    [{ field: 'token', message: 'Enlace no válido o caducado' }],
  );
}

export function toApplicationSummary(
  a: WineryApplication,
): WineryApplicationSummaryDto {
  return {
    id: a.id,
    status: a.status,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
    legalName: a.legalName,
    tradeName: a.tradeName,
    taxId: a.taxId,
    category: a.category,
    region: a.region,
    contactName: a.contactName,
    contactEmail: a.contactEmail,
    contactPhone: a.contactPhone,
    message: a.message,
    assignee:
      a.assigneeUserId && a.assigneeName
        ? { userId: a.assigneeUserId, fullName: a.assigneeName }
        : null,
    meeting:
      a.meetingScheduledAt && a.meetingChannel
        ? {
            scheduledAt: a.meetingScheduledAt.toISOString(),
            channel: a.meetingChannel,
            notes: a.meetingNotes,
          }
        : null,
    decision: a.decidedAt
      ? {
          by: a.decisionByName ?? 'Sistema',
          at: a.decidedAt.toISOString(),
          reason: a.decisionReason,
        }
      : null,
    wineryId: a.wineryId,
  };
}

export function toApplicationDetail(
  a: ApplicationWithNotes,
): WineryApplicationDto {
  return {
    ...toApplicationSummary(a),
    notes: a.notes.map((n) => ({
      id: n.id,
      text: n.text,
      by: n.authorName,
      at: n.createdAt.toISOString(),
    })),
  };
}

/**
 * Solicitudes de alta de bodegas (ORG-01, ORG-02; contrato O1 §3; docs-back/07
 * §1 y §10).
 *
 * - Público: captcha, campo trampa, límite por IP y por correo (además del
 *   de peticiones por minuto) y verificación del correo de contacto antes de
 *   que operaciones la vea. Un NIT ya usado responde 202 igualmente, sin crear
 *   nada, y avisa a operaciones (no se filtra si existe).
 * - Back office: bandeja, tomar, notas, reunión, aprobar (crea la bodega
 *   `INVITED` e invita al dueño en la misma transacción) y rechazar con motivo
 *   y correo. Transición inválida → 409 `APPLICATION_INVALID_TRANSITION`.
 */
@Injectable()
export class WineryApplicationsService {
  private readonly logger = new Logger(WineryApplicationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly links: AppLinks,
    private readonly captcha: CaptchaService,
    private readonly wineries: WineryManagementService,
  ) {}

  // ─── Público ───────────────────────────────────────────────────────────

  /** `POST /v1/public/winery-applications` → 202 `{ id, status: 'UNVERIFIED' }`. */
  async submit(
    dto: CreateWineryApplicationDto,
    client: { ip: string | null },
  ): Promise<CreateWineryApplicationResponseDto> {
    await this.captcha.verify(dto.captchaToken, client.ip);
    const silent = (): CreateWineryApplicationResponseDto => ({
      id: randomUUID(),
      status: 'UNVERIFIED',
    });
    if (dto.website?.trim()) {
      this.logger.warn(
        'Solicitud de alta con el campo trampa relleno: ignorada',
      );
      return silent();
    }
    const email = dto.contactEmail.toLowerCase();
    const now = new Date();
    const since = new Date(now.getTime() - HOUR_MS);
    const [byEmail, byIp] = await Promise.all([
      this.prisma.wineryApplication.count({
        where: { contactEmail: email, updatedAt: { gte: since } },
      }),
      client.ip
        ? this.prisma.wineryApplication.count({
            where: { submittedIp: client.ip, updatedAt: { gte: since } },
          })
        : Promise.resolve(0),
    ]);
    if (
      byEmail >= APPLICATION_LIMIT_PER_EMAIL_HOUR ||
      byIp >= APPLICATION_LIMIT_PER_IP_HOUR
    ) {
      this.logger.warn(
        `Solicitud de alta ignorada por el límite por correo o IP (${byEmail} del correo, ${byIp} de la IP en la última hora)`,
      );
      return silent();
    }

    return this.prisma.$transaction(async (tx) => {
      // La misma persona reenvía la misma solicitud sin haberla verificado:
      // se actualiza y se manda un enlace nuevo (el anterior deja de valer)
      const previous = await tx.wineryApplication.findFirst({
        where: {
          taxId: dto.taxId,
          contactEmail: email,
          status: Status.UNVERIFIED,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      });
      if (
        await taxIdTaken(tx, dto.taxId, { applicationId: previous?.id }, now)
      ) {
        await this.notifyDuplicate(tx, dto);
        return silent();
      }

      const token = generateOpaqueToken();
      const data = {
        legalName: dto.legalName,
        tradeName: dto.tradeName,
        taxId: dto.taxId,
        category: dto.category,
        region: dto.region,
        contactName: dto.contactName,
        contactEmail: email,
        contactPhone: dto.contactPhone ?? null,
        message: dto.message ?? null,
        submittedIp: client.ip,
        verifyTokenHash: hashOpaqueToken(token),
        verifyExpiresAt: new Date(
          now.getTime() + APPLICATION_VERIFY_TTL_HOURS * HOUR_MS,
        ),
      };
      const application = previous
        ? await tx.wineryApplication.update({
            where: { id: previous.id },
            data,
          })
        : await tx.wineryApplication.create({
            data: { ...data, status: Status.UNVERIFIED },
          });
      await this.mail.enqueue(tx, {
        template: 'solicitud-verificar',
        to: email,
        variables: {
          nombre: application.contactName,
          bodega: application.tradeName,
          enlace: this.links.applicationVerify(token),
          horas: APPLICATION_VERIFY_TTL_HOURS,
        },
      });
      await this.audit.record(tx, {
        action: AuditAction.WINERY_APPLICATION_SUBMITTED,
        resource: { type: 'winery_application', id: application.id },
        organizationId: null,
        after: {
          tradeName: application.tradeName,
          taxId: application.taxId,
          contactEmail: application.contactEmail,
          resubmitted: Boolean(previous),
        },
      });
      return { id: application.id, status: 'UNVERIFIED' as const };
    }, AUDIT_TX_OPTIONS);
  }

  /** `POST /v1/public/winery-applications/verify` → 204; pasa a `RECEIVED`. */
  async verify(dto: VerifyWineryApplicationDto): Promise<void> {
    if (!isPlausibleToken(dto.token)) {
      throw tokenInvalid();
    }
    const tokenHash = hashOpaqueToken(dto.token);
    const application = await this.prisma.wineryApplication.findUnique({
      where: { verifyTokenHash: tokenHash },
    });
    const now = new Date();
    if (
      !application ||
      application.status !== Status.UNVERIFIED ||
      !application.verifyExpiresAt ||
      application.verifyExpiresAt.getTime() <= now.getTime()
    ) {
      throw tokenInvalid();
    }
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.wineryApplication.updateMany({
        where: {
          id: application.id,
          status: Status.UNVERIFIED,
          verifyTokenHash: tokenHash,
        },
        data: {
          status: Status.RECEIVED,
          verifiedAt: now,
          verifyTokenHash: null,
          verifyExpiresAt: null,
        },
      });
      if (changed.count === 0) {
        throw tokenInvalid();
      }
      await this.mail.enqueue(tx, {
        template: 'solicitud-recibida',
        to: application.contactEmail,
        variables: {
          nombre: application.contactName,
          bodega: application.tradeName,
        },
      });
      for (const person of await this.operationsStaff(tx)) {
        await this.mail.enqueue(tx, {
          template: 'solicitud-nueva-operaciones',
          to: person.email,
          variables: {
            nombre: person.fullName,
            bodega: application.tradeName,
            region: application.region,
            contacto: `${application.contactName} <${application.contactEmail}>`,
            enlace: this.links.applicationDetail(application.id),
          },
        });
      }
      await this.audit.record(tx, {
        action: AuditAction.WINERY_APPLICATION_VERIFIED,
        resource: { type: 'winery_application', id: application.id },
        organizationId: null,
        actor: null,
        before: { status: Status.UNVERIFIED },
        after: { status: Status.RECEIVED },
      });
    }, AUDIT_TX_OPTIONS);
  }

  // ─── Back office ───────────────────────────────────────────────────────

  /** Bandeja: por defecto sin las `UNVERIFIED`; más recientes primero. */
  async list(
    query: WineryApplicationsQueryDto,
  ): Promise<Paginated<WineryApplicationSummaryDto>> {
    const contains = (value: string) => ({
      contains: value,
      mode: 'insensitive' as const,
    });
    const where: Prisma.WineryApplicationWhereInput = {
      status: query.status ?? { not: Status.UNVERIFIED },
      ...(query.assigneeId ? { assigneeUserId: query.assigneeId } : {}),
      ...(query.q
        ? {
            OR: [
              { legalName: contains(query.q) },
              { tradeName: contains(query.q) },
              { taxId: { contains: query.q } },
              { contactName: contains(query.q) },
              { contactEmail: contains(query.q) },
              { region: contains(query.q) },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.wineryApplication.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.wineryApplication.count({ where }),
    ]);
    return toPage(rows.map(toApplicationSummary), total, query);
  }

  async detail(
    id: string,
    client: Pick<Prisma.TransactionClient, 'wineryApplication'> = this.prisma,
  ): Promise<WineryApplicationDto> {
    const row = await client.wineryApplication.findUnique({
      where: { id },
      include: { notes: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
    });
    if (!row) {
      throw notFound();
    }
    return toApplicationDetail(row);
  }

  /** `RECEIVED` → `IN_REVIEW`, asignada a quien la toma. */
  async take(
    id: string,
    principal: AuthenticatedUser,
  ): Promise<WineryApplicationDto> {
    const actor = await this.wineries.actorOf(principal);
    return this.prisma.$transaction(async (tx) => {
      const before = await this.move(tx, id, Status.IN_REVIEW, {
        assigneeUserId: actor.userId,
        assigneeName: actor.fullName,
      });
      await this.audit.record(tx, {
        action: AuditAction.WINERY_APPLICATION_TAKEN,
        resource: { type: 'winery_application', id },
        organizationId: null,
        before: { status: before.status, assigneeId: before.assigneeUserId },
        after: { status: Status.IN_REVIEW, assigneeId: actor.userId },
      });
      return this.detail(id, tx);
    }, AUDIT_TX_OPTIONS);
  }

  /** Nota interna (en cualquier estado verificado). */
  async addNote(
    id: string,
    dto: AddApplicationNoteDto,
    principal: AuthenticatedUser,
  ): Promise<WineryApplicationDto> {
    const actor = await this.wineries.actorOf(principal);
    return this.prisma.$transaction(async (tx) => {
      const application = await tx.wineryApplication.findUnique({
        where: { id },
      });
      if (!application) {
        throw notFound();
      }
      if (application.status === Status.UNVERIFIED) {
        throw invalidTransition(
          'La solicitud aún no tiene el correo verificado',
        );
      }
      const note = await this.createNote(tx, id, dto.text, actor);
      await this.audit.record(tx, {
        action: AuditAction.WINERY_APPLICATION_NOTE_ADDED,
        resource: { type: 'winery_application', id },
        organizationId: application.wineryId,
        after: { noteId: note.id },
      });
      return this.detail(id, tx);
    }, AUDIT_TX_OPTIONS);
  }

  /** `IN_REVIEW` → `MEETING_SCHEDULED`. */
  async scheduleMeeting(
    id: string,
    dto: ScheduleMeetingDto,
  ): Promise<WineryApplicationDto> {
    const scheduledAt = new Date(dto.scheduledAt);
    return this.prisma.$transaction(async (tx) => {
      const before = await this.move(tx, id, Status.MEETING_SCHEDULED, {
        meetingScheduledAt: scheduledAt,
        meetingChannel: dto.channel,
        meetingNotes: dto.notes ?? null,
      });
      await this.audit.record(tx, {
        action: AuditAction.WINERY_APPLICATION_MEETING_SCHEDULED,
        resource: { type: 'winery_application', id },
        organizationId: null,
        before: { status: before.status },
        after: {
          status: Status.MEETING_SCHEDULED,
          scheduledAt,
          channel: dto.channel,
        },
      });
      return this.detail(id, tx);
    }, AUDIT_TX_OPTIONS);
  }

  /** `MEETING_SCHEDULED` → `IN_REVIEW`, con las notas de la reunión. */
  async meetingDone(
    id: string,
    dto: MeetingDoneDto,
    principal: AuthenticatedUser,
  ): Promise<WineryApplicationDto> {
    const actor = await this.wineries.actorOf(principal);
    return this.prisma.$transaction(async (tx) => {
      const before = await this.move(tx, id, Status.IN_REVIEW, {
        meetingNotes: dto.notes,
      });
      await this.createNote(tx, id, dto.notes, actor);
      await this.audit.record(tx, {
        action: AuditAction.WINERY_APPLICATION_MEETING_DONE,
        resource: { type: 'winery_application', id },
        organizationId: null,
        before: { status: before.status },
        after: { status: Status.IN_REVIEW },
      });
      return this.detail(id, tx);
    }, AUDIT_TX_OPTIONS);
  }

  /**
   * `IN_REVIEW` → `APPROVED`: crea la bodega `INVITED` e invita a su dueño
   * (por defecto, el contacto) en la misma transacción, y avisa al contacto.
   */
  async approve(
    id: string,
    dto: ApproveApplicationDto,
    principal: AuthenticatedUser,
  ): Promise<ApproveApplicationResponseDto> {
    const actor = await this.wineries.actorOf(principal);
    const reason = dto.reason ?? null;
    const result = await this.prisma.$transaction(async (tx) => {
      const application = await tx.wineryApplication.findUnique({
        where: { id },
      });
      if (!application) {
        throw notFound();
      }
      assertTransition(application.status, Status.APPROVED);
      if (await taxIdTaken(tx, application.taxId, { applicationId: id })) {
        throw taxIdTakenError(application.taxId);
      }
      const winery = await this.wineries.createInvitedWinery(
        tx,
        {
          legalName: application.legalName,
          tradeName: application.tradeName,
          taxId: application.taxId,
          category: application.category,
          region: application.region,
          contactEmail: application.contactEmail,
          contactPhone: application.contactPhone,
        },
        actor,
        reason,
      );
      const ownerName = dto.ownerFullName ?? application.contactName;
      const invitation = await this.wineries.inviteOwner(tx, {
        wineryId: winery.id,
        email: dto.ownerEmail ?? application.contactEmail,
        fullName: ownerName,
        actor,
        reason,
      });
      await this.move(tx, id, Status.APPROVED, {
        decisionByUserId: actor.userId,
        decisionByName: actor.fullName,
        decidedAt: new Date(),
        decisionReason: reason,
        wineryId: winery.id,
      });
      await this.mail.enqueue(tx, {
        template: 'solicitud-aprobada',
        to: application.contactEmail,
        organizationId: winery.id,
        variables: {
          nombre: application.contactName,
          bodega: application.tradeName,
          titular: ownerName,
        },
      });
      await this.audit.record(tx, {
        action: AuditAction.WINERY_APPLICATION_APPROVED,
        resource: { type: 'winery_application', id },
        organizationId: winery.id,
        before: { status: application.status },
        after: { status: Status.APPROVED, wineryId: winery.id },
        reason,
      });
      return {
        application: await this.detail(id, tx),
        wineryId: winery.id,
        invitation,
      };
    }, AUDIT_TX_OPTIONS);
    this.logger.log(
      `Solicitud ${id} aprobada: bodega ${result.wineryId} (INVITED)`,
    );
    return {
      application: result.application,
      winery: await this.wineries.detail(result.wineryId),
      invitation: result.invitation,
    };
  }

  /** `IN_REVIEW` → `REJECTED` con motivo; correo al contacto. */
  async reject(
    id: string,
    dto: RejectApplicationDto,
    principal: AuthenticatedUser,
  ): Promise<WineryApplicationDto> {
    const actor = await this.wineries.actorOf(principal);
    return this.prisma.$transaction(async (tx) => {
      const before = await this.move(tx, id, Status.REJECTED, {
        decisionByUserId: actor.userId,
        decisionByName: actor.fullName,
        decidedAt: new Date(),
        decisionReason: dto.reason,
      });
      await this.mail.enqueue(tx, {
        template: 'solicitud-rechazada',
        to: before.contactEmail,
        variables: {
          nombre: before.contactName,
          bodega: before.tradeName,
          motivo: dto.reason,
        },
      });
      await this.audit.record(tx, {
        action: AuditAction.WINERY_APPLICATION_REJECTED,
        resource: { type: 'winery_application', id },
        organizationId: null,
        before: { status: before.status },
        after: { status: Status.REJECTED },
        reason: dto.reason,
      });
      return this.detail(id, tx);
    }, AUDIT_TX_OPTIONS);
  }

  // ─── Internos ──────────────────────────────────────────────────────────

  /**
   * Cambia de estado con las transiciones del contrato (si no, 409) y sin
   * carreras (`UPDATE … WHERE status = <leído>`). Devuelve la fila anterior.
   */
  private async move(
    tx: Prisma.TransactionClient,
    id: string,
    to: Status,
    data: Prisma.WineryApplicationUncheckedUpdateManyInput = {},
  ): Promise<WineryApplication> {
    const application = await tx.wineryApplication.findUnique({
      where: { id },
    });
    if (!application) {
      throw notFound();
    }
    assertTransition(application.status, to);
    const changed = await tx.wineryApplication.updateMany({
      where: { id, status: application.status },
      data: { ...data, status: to },
    });
    if (changed.count === 0) {
      throw invalidTransition('La solicitud cambió de estado mientras tanto');
    }
    return application;
  }

  private async createNote(
    tx: Prisma.TransactionClient,
    applicationId: string,
    text: string,
    actor: ActorRef,
  ): Promise<WineryApplicationNote> {
    const note = await tx.wineryApplicationNote.create({
      data: {
        applicationId,
        text,
        authorUserId: actor.userId,
        authorName: actor.fullName,
      },
    });
    await tx.wineryApplication.update({
      where: { id: applicationId },
      data: { updatedAt: new Date() },
    });
    return note;
  }

  /** Personal de operaciones y administración activo (avisos por correo). */
  private async operationsStaff(
    tx: Prisma.TransactionClient,
  ): Promise<{ email: string; fullName: string }[]> {
    const rows = await tx.membership.findMany({
      where: {
        organizationId: PLATFORM_ORGANIZATION_ID,
        role: { in: [...OPERATIONS_NOTICE_ROLES] },
        status: MembershipStatusEnum.ACTIVE,
        user: { isActive: true },
      },
      include: { user: { select: { email: true, fullName: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((r) => r.user);
  }

  /** NIT ya registrado: 202 al público, aviso a operaciones y bitácora. */
  private async notifyDuplicate(
    tx: Prisma.TransactionClient,
    dto: CreateWineryApplicationDto,
  ): Promise<void> {
    for (const person of await this.operationsStaff(tx)) {
      await this.mail.enqueue(tx, {
        template: 'solicitud-duplicada-operaciones',
        to: person.email,
        variables: {
          nombre: person.fullName,
          bodega: dto.tradeName,
          nit: dto.taxId,
          contacto: `${dto.contactName} <${dto.contactEmail.toLowerCase()}>`,
        },
      });
    }
    await this.audit.record(tx, {
      action: AuditAction.WINERY_APPLICATION_DUPLICATE_TAX_ID,
      resource: { type: 'winery_application', id: null },
      organizationId: null,
      after: { taxId: dto.taxId, tradeName: dto.tradeName },
    });
    this.logger.warn(
      `Solicitud de alta con un NIT ya registrado (${dto.taxId}): 202 sin crear nada`,
    );
  }
}
