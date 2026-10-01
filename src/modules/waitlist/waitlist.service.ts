import { Injectable, Logger } from '@nestjs/common';
import {
  Prisma,
  WaitlistEntry,
  WaitlistStatusEnum as Status,
  WaitlistTypeEnum as Type,
} from '@prisma/client';
import { PrismaService } from '@shared/prisma/prisma.service';
import { AuditService, AUDIT_TX_OPTIONS } from '@shared/audit/audit.service';
import { AuditAction } from '@shared/audit/audit.actions';
import { AppException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';
import { CaptchaService } from '@shared/captcha/captcha.service';
import { toPage } from '@shared/dto/pagination-query.dto';
import type { Paginated } from '@shared/interfaces/api-response.interface';
import type { AuthenticatedUser } from '@shared/decorators/current-user.decorator';
import { parseAuditDate } from '@modules/audit/dto/audit-query.dto';
import {
  JoinWaitlistDto,
  UpdateWaitlistEntryDto,
  WaitlistEntryDto,
  WaitlistFiltersDto,
  WaitlistJoinResponseDto,
  WaitlistListQueryDto,
  WaitlistLocale,
  WaitlistSourceDto,
  WaitlistStatsDto,
} from './dto/waitlist.dto';
import { waitlistConfig } from './waitlist.config';
import { WaitlistRateLimiter } from './waitlist-rate-limiter';

/** Tipo de recurso en la bitácora (contrato O1b §2). */
export const WAITLIST_RESOURCE_TYPE = 'waitlist_entry';
/** Caché de los totales públicos (`GET /v1/public/waitlist/stats`). */
export const WAITLIST_STATS_TTL_MS = 60_000;
/** Filas por consulta al exportar (cursor por id, sin `OFFSET`). */
export const WAITLIST_EXPORT_BATCH_SIZE = 1000;
/** Lo que se guarda del agente de usuario. */
export const WAITLIST_USER_AGENT_MAX = 300;

export interface WaitlistClient {
  /** IP real (la resuelve el proxy firmado; `request.ip`). */
  ip: string | null;
  userAgent: string | null;
}

function notFound(): AppException {
  return new AppException(
    404,
    ErrorCode.NOT_FOUND,
    'Inscripción de la lista de espera no encontrada',
  );
}

export function toWaitlistEntry(row: WaitlistEntry): WaitlistEntryDto {
  return {
    id: row.id,
    type: row.type,
    position: row.position,
    status: row.status,
    fullName: row.fullName,
    email: row.email,
    phone: row.phone,
    city: row.city,
    interest: row.interest,
    wineryName: row.wineryName,
    region: row.region,
    produces: row.produces,
    message: row.message,
    locale: row.locale as WaitlistLocale,
    source: row.source,
    consentAt: row.consentAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    contactedAt: row.contactedAt?.toISOString() ?? null,
    contactedBy: row.contactedByName,
    notes: row.notes,
  };
}

/**
 * Lista de espera de consumidores y bodegas (contrato O1b).
 *
 * - Público: campo trampa, límites por IP real y por correo (429 con
 *   `Retry-After`), captcha solo con `WAITLIST_CAPTCHA_REQUIRED=true`. Un
 *   correo ya inscrito en ese tipo recibe la misma respuesta con su posición
 *   (no se revela nada ni se pisan sus datos). La posición sale de un
 *   contador por tipo cuya fila se bloquea en la transacción: consecutiva y
 *   sin carreras.
 * - Back office: lista con filtros y búsqueda, orígenes, estado y notas, y
 *   exportación CSV. Todo queda en la bitácora.
 */
@Injectable()
export class WaitlistService {
  private readonly logger = new Logger(WaitlistService.name);
  private statsCache: { value: WaitlistStatsDto; expiresAt: number } | null =
    null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly captcha: CaptchaService,
    private readonly limiter: WaitlistRateLimiter,
  ) {}

  // ─── Público ───────────────────────────────────────────────────────────

  /** `POST /v1/public/waitlist` → 201 `{ type, position }`. */
  async join(
    dto: JoinWaitlistDto,
    client: WaitlistClient,
  ): Promise<WaitlistJoinResponseDto> {
    await this.limiter.checkIp(client.ip);
    if (waitlistConfig().captchaRequired) {
      await this.captcha.verify(dto.captchaToken, client.ip);
    }
    const type = dto.type;
    if (dto.website?.trim()) {
      this.logger.warn(
        'Inscripción en la lista de espera con el campo trampa relleno: ignorada',
      );
      // Posición verosímil, sin guardar nada
      const counter = await this.prisma.waitlistCounter.findUnique({
        where: { type },
      });
      return { type, position: (counter?.lastPosition ?? 0) + 1 };
    }
    const email = dto.email;
    await this.limiter.checkEmail(email);

    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      // Bloquea la fila del contador del tipo hasta el fin de la transacción:
      // las inscripciones del mismo tipo van de una en una (ni dos con la
      // misma posición ni dos con el mismo correo)
      const [counter] = await tx.$queryRaw<{ last_position: number }[]>`
        INSERT INTO "waitlist_counters" ("type", "last_position")
        VALUES (${type}::"waitlist_type_enum", 0)
        ON CONFLICT ("type") DO UPDATE
          SET "last_position" = "waitlist_counters"."last_position"
        RETURNING "last_position"`;

      const existing = await tx.waitlistEntry.findUnique({
        where: { type_email: { type, email } },
      });
      if (existing) {
        // Los datos nuevos no pisan los anteriores; solo completan los vacíos
        const fill: Prisma.WaitlistEntryUpdateInput = {
          ...(!existing.phone && dto.phone ? { phone: dto.phone } : {}),
          ...(!existing.city && dto.city ? { city: dto.city } : {}),
          ...(!existing.region && dto.region ? { region: dto.region } : {}),
        };
        if (Object.keys(fill).length > 0) {
          await tx.waitlistEntry.update({
            where: { id: existing.id },
            data: fill,
          });
        }
        return { position: existing.position, created: false };
      }

      const position = Number(counter.last_position) + 1;
      await tx.waitlistCounter.update({
        where: { type },
        data: { lastPosition: position },
      });
      const entry = await tx.waitlistEntry.create({
        data: {
          type,
          position,
          fullName: dto.fullName,
          email,
          phone: dto.phone ?? null,
          city: dto.city ?? null,
          interest: dto.interest ?? null,
          wineryName: dto.wineryName ?? null,
          region: dto.region ?? null,
          produces: dto.produces ?? null,
          message: dto.message ?? null,
          isAdult: typeof dto.isAdult === 'boolean' ? dto.isAdult : null,
          locale: dto.locale ?? 'es',
          source: dto.source ?? null,
          consentAt: now,
          ip: client.ip?.slice(0, 64) ?? null,
          userAgent:
            client.userAgent?.slice(0, WAITLIST_USER_AGENT_MAX) ?? null,
        },
      });
      // Sin datos personales: solo el tipo y el origen
      await this.audit.record(tx, {
        action: AuditAction.WAITLIST_JOINED,
        resource: { type: WAITLIST_RESOURCE_TYPE, id: entry.id },
        organizationId: null,
        after: { type: entry.type, source: entry.source },
        source: { app: 'PUBLIC' },
      });
      return { position, created: true };
    }, AUDIT_TX_OPTIONS);

    if (result.created) {
      this.statsCache = null;
    }
    return { type, position: result.position };
  }

  /** `GET /v1/public/waitlist/stats`: totales por tipo, con caché de 60 s. */
  async stats(now: number = Date.now()): Promise<WaitlistStatsDto> {
    if (this.statsCache && this.statsCache.expiresAt > now) {
      return this.statsCache.value;
    }
    const value = await this.totals();
    this.statsCache = { value, expiresAt: now + WAITLIST_STATS_TTL_MS };
    return value;
  }

  private async totals(): Promise<WaitlistStatsDto> {
    const groups = await this.prisma.waitlistEntry.groupBy({
      by: ['type'],
      _count: { _all: true },
    });
    const count = (type: Type) =>
      groups.find((g) => g.type === type)?._count._all ?? 0;
    return { consumers: count(Type.CONSUMER), wineries: count(Type.WINERY) };
  }

  // ─── Back office ───────────────────────────────────────────────────────

  /** `where` de Prisma para los filtros (fechas: `AAAA-MM-DD` o ISO). */
  where(filters: WaitlistFiltersDto): Prisma.WaitlistEntryWhereInput {
    const from = parseAuditDate(filters.from, 'from');
    const to = parseAuditDate(filters.to, 'to');
    const contains = (value: string) => ({
      contains: value,
      mode: 'insensitive' as const,
    });
    return {
      ...(filters.type ? { type: filters.type } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.source ? { source: filters.source } : {}),
      ...(from || to
        ? {
            createdAt: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
      ...(filters.q
        ? {
            OR: [
              { fullName: contains(filters.q) },
              { email: contains(filters.q) },
              { wineryName: contains(filters.q) },
              { phone: { contains: filters.q } },
            ],
          }
        : {}),
    };
  }

  /** `GET /v1/platform/waitlist`: más reciente primero. */
  async list(
    query: WaitlistListQueryDto,
  ): Promise<Paginated<WaitlistEntryDto>> {
    const where = this.where(query);
    const [rows, total] = await Promise.all([
      this.prisma.waitlistEntry.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.waitlistEntry.count({ where }),
    ]);
    return toPage(rows.map(toWaitlistEntry), total, query);
  }

  /** `GET /v1/platform/waitlist/sources`: orígenes con su número de inscritos. */
  async sources(type?: Type): Promise<WaitlistSourceDto[]> {
    const groups = await this.prisma.waitlistEntry.groupBy({
      by: ['source'],
      where: type ? { type } : {},
      _count: { _all: true },
    });
    return groups
      .map((g) => ({ source: g.source, count: g._count._all }))
      .sort(
        (a, b) =>
          b.count - a.count ||
          (a.source ?? '').localeCompare(b.source ?? '', 'es'),
      );
  }

  /** `PATCH /v1/platform/waitlist/{id}`: estado y notas. */
  async update(
    id: string,
    dto: UpdateWaitlistEntryDto,
    principal: AuthenticatedUser,
  ): Promise<WaitlistEntryDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: principal.id },
      select: { fullName: true },
    });
    const actorName = user?.fullName ?? 'Personal de plataforma';

    return this.prisma.$transaction(async (tx) => {
      const before = await tx.waitlistEntry.findUnique({ where: { id } });
      if (!before) {
        throw notFound();
      }
      const statusChanged =
        dto.status !== undefined && dto.status !== before.status;
      const notes = dto.notes ?? null;
      const notesChanged = dto.notes !== undefined && notes !== before.notes;
      if (!statusChanged && !notesChanged) {
        return toWaitlistEntry(before);
      }

      const data: Prisma.WaitlistEntryUpdateInput = {};
      if (notesChanged) {
        data.notes = notes;
      }
      if (statusChanged) {
        data.status = dto.status;
        if (dto.status === Status.CONTACTED) {
          data.contactedAt = new Date();
          data.contactedByUserId = principal.id;
          data.contactedByName = actorName;
        } else if (dto.status === Status.NEW) {
          data.contactedAt = null;
          data.contactedByUserId = null;
          data.contactedByName = null;
        }
      }
      const after = await tx.waitlistEntry.update({ where: { id }, data });
      // Sin el texto de las notas (pueden llevar datos personales)
      await this.audit.record(tx, {
        action: AuditAction.WAITLIST_STATUS_CHANGED,
        resource: { type: WAITLIST_RESOURCE_TYPE, id },
        organizationId: null,
        before: { status: before.status },
        after: { status: after.status, notesChanged },
      });
      return toWaitlistEntry(after);
    }, AUDIT_TX_OPTIONS);
  }

  count(where: Prisma.WaitlistEntryWhereInput): Promise<number> {
    return this.prisma.waitlistEntry.count({ where });
  }

  /**
   * Recorre las inscripciones en orden de llegada por lotes (cursor por id),
   * sin cargar la exportación entera en memoria.
   */
  async *batches(
    where: Prisma.WaitlistEntryWhereInput,
    batchSize = WAITLIST_EXPORT_BATCH_SIZE,
  ): AsyncGenerator<WaitlistEntryDto[]> {
    let cursor: string | null = null;
    for (;;) {
      const rows: WaitlistEntry[] = await this.prisma.waitlistEntry.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: batchSize,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (rows.length === 0) return;
      yield rows.map(toWaitlistEntry);
      if (rows.length < batchSize) return;
      cursor = rows[rows.length - 1].id;
    }
  }

  /** Bitácora de una exportación: cuántas filas y con qué filtros. */
  async recordExport(rows: number, filters: WaitlistFiltersDto): Promise<void> {
    await this.audit.recordStandalone({
      action: AuditAction.WAITLIST_EXPORTED,
      resource: { type: WAITLIST_RESOURCE_TYPE, id: null },
      organizationId: null,
      after: {
        rows,
        filters: {
          type: filters.type ?? null,
          status: filters.status ?? null,
          source: filters.source ?? null,
          from: filters.from ?? null,
          to: filters.to ?? null,
          // El texto buscado puede ser un correo o un teléfono: no se guarda
          searched: Boolean(filters.q),
        },
      },
    });
  }
}
