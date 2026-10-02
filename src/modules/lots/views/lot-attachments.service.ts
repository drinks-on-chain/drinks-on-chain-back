import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type Redis from 'ioredis';
import { PrismaService } from '@shared/prisma/prisma.service';
import { AUDIT_TX_OPTIONS, AuditService } from '@shared/audit/audit.service';
import { AuditAction } from '@shared/audit/audit.actions';
import { AppException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';
import type { AuthenticatedUser } from '@shared/decorators/current-user.decorator';
import { toPage } from '@shared/dto/pagination-query.dto';
import type { Paginated } from '@shared/interfaces/api-response.interface';
import { REDIS_CLIENT } from '@shared/redis/redis.module';
import { redisReady } from '@shared/redis/redis-ready';
import { detectFileType, fileTypeForKey } from '@shared/storage/file-type';
import {
  DEFAULT_SIGNED_URL_TTL_SECONDS,
  isSafeStorageKey,
  ObjectStorage,
  STORAGE_SERVICE,
} from '@shared/storage/storage.interface';
import { TERMINAL_STAGES } from '../domain/lot-stage';
import {
  lotNotFound,
  ruleError,
  stateError,
  violation,
} from '../domain/trace-errors';
import { appendLotEvent } from '../lot-events';
import { lockLot } from '../lot-records';
import { actorOf, resolveTraceActors, TraceActor } from '../trace-actors';
import { actorMembership, dbClock, DbClient } from '../trace-db';

export type AttachmentKind =
  | 'LAB_REPORT'
  | 'PHYTO_REPORT'
  | 'LABEL'
  | 'DO_CERTIFICATE'
  | 'PHOTO'
  | 'OTHER';
export type AttachmentVisibility = 'PRIVATE' | 'PUBLIC';

export interface LotAttachmentView {
  id: string;
  kind: AttachmentKind;
  title: string;
  key: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  visibility: AttachmentVisibility;
  url: string;
  urlExpiresAt: string;
  createdAt: string;
  createdBy: TraceActor | null;
}

export interface FileFacts {
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}

/** Roles que deciden qué se publica y ven todos los archivos del lote (§14). */
const ATTACHMENT_MANAGERS = new Set(['OWNER', 'ENOLOGIST']);
/** Roles que solo ven los archivos que adjuntaron ("los suyos", §14). */
const OWN_ATTACHMENTS_ONLY = new Set(['AGRONOMIST', 'OPERATOR']);

/** Evento de la línea de tiempo de un adjunto del lote. */
const ATTACHMENT_RESOURCE = 'lot_attachment';
const VISIBILITY_CHANGED = 'VISIBILITY_CHANGED';
const FILE_FACTS_TTL_SECONDS = 30 * 24 * 3600;

const VISIBILITY_LABEL: Record<AttachmentVisibility, string> = {
  PUBLIC: 'público',
  PRIVATE: 'privado',
};

/**
 * Visibilidad vigente de los adjuntos de un lote. El adjunto no se edita
 * (solo inserción, §11.5): cada cambio es un evento `FILE_ATTACHED` con
 * `data.action = VISIBILITY_CHANGED` y el último manda sobre la visibilidad
 * con la que nació.
 */
export async function attachmentVisibilities(
  client: DbClient,
  lotId: string,
): Promise<Map<string, AttachmentVisibility>> {
  const events = await client.lotEvent.findMany({
    where: { lotId, type: 'FILE_ATTACHED', resourceType: ATTACHMENT_RESOURCE },
    orderBy: { seq: 'asc' },
    select: { resourceId: true, data: true },
  });
  const map = new Map<string, AttachmentVisibility>();
  for (const event of events) {
    const data = (event.data ?? {}) as Record<string, unknown>;
    if (data.action !== VISIBILITY_CHANGED) continue;
    map.set(
      event.resourceId,
      data.visibility === 'PUBLIC' ? 'PUBLIC' : 'PRIVATE',
    );
  }
  return map;
}

/** Adjuntos del lote que el pasaporte puede mostrar (visibilidad vigente `PUBLIC`). */
export async function publicLotAttachments(client: DbClient, lotId: string) {
  const [rows, changes] = await Promise.all([
    client.lotAttachment.findMany({
      where: { lotId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
    attachmentVisibilities(client, lotId),
  ]);
  return rows.filter(
    (row) => (changes.get(row.id) ?? row.visibility) === 'PUBLIC',
  );
}

/** Archivos privados del lote (contrato O2 §11.5, ERP-24, S-20). */
@Injectable()
export class LotAttachmentsService {
  private readonly logger = new Logger(LotAttachmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(STORAGE_SERVICE) private readonly storage: ObjectStorage,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async create(
    wineryId: string,
    lotId: string,
    user: AuthenticatedUser,
    dto: {
      key: string;
      kind: AttachmentKind;
      title: string;
      visibility?: AttachmentVisibility;
    },
  ): Promise<LotAttachmentView> {
    // Antes de leer el archivo: el lote existe y es de la bodega (404, no 422)
    const exists = await this.prisma.lot.findFirst({
      where: { id: lotId, wineryId },
      select: { id: true },
    });
    if (!exists) throw lotNotFound();

    const visibility: AttachmentVisibility =
      dto.visibility ?? (dto.kind === 'LABEL' ? 'PUBLIC' : 'PRIVATE');
    if (
      dto.visibility === 'PUBLIC' &&
      dto.kind !== 'LABEL' &&
      !ATTACHMENT_MANAGERS.has(user.role ?? '')
    ) {
      throw new AppException(
        403,
        ErrorCode.AUTH_INSUFFICIENT_PERMISSIONS,
        'Solo el dueño o el enólogo deciden qué archivos del lote son públicos',
      );
    }
    const facts = await this.fileFacts(wineryId, dto.key);
    if (!facts) {
      throw ruleError(
        ErrorCode.TRC_FILE_NOT_FOUND,
        'El archivo no existe o no es de esta bodega: súbelo antes con POST /v1/uploads',
        [
          violation(ErrorCode.TRC_FILE_NOT_FOUND, 'Archivo no encontrado', {
            field: 'key',
            meta: { field: 'key' },
          }),
        ],
      );
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const lot = await lockLot(tx, lotId, wineryId);
      const dossier = await tx.lotDossier.findUnique({
        where: { lotId },
        select: { status: true, closedAt: true },
      });
      if (dossier?.status === 'CLOSED') {
        throw stateError(
          ErrorCode.TRC_DOSSIER_CLOSED,
          'El expediente del lote está cerrado: ya no admite archivos',
          [
            violation(ErrorCode.TRC_DOSSIER_CLOSED, 'Expediente cerrado', {
              meta: { closedAt: dossier.closedAt?.toISOString() ?? null },
            }),
          ],
        );
      }
      if (TERMINAL_STAGES.includes(lot.stage)) {
        throw stateError(
          ErrorCode.TRC_LOT_TERMINAL,
          `El lote está en etapa ${lot.stage}: no admite más registros`,
          [
            violation(
              ErrorCode.TRC_LOT_TERMINAL,
              `Etapa terminal: ${lot.stage}`,
              {
                meta: { stage: lot.stage },
              },
            ),
          ],
        );
      }
      const clock = await dbClock(tx);
      const membership = await actorMembership(tx, user.id, wineryId);
      const row = await tx.lotAttachment.create({
        data: {
          lotId,
          kind: dto.kind,
          title: dto.title,
          key: dto.key,
          mimeType: facts.mimeType,
          sizeBytes: facts.sizeBytes,
          sha256: facts.sha256,
          visibility,
          createdAt: clock.now,
          createdByMembershipId: membership?.id ?? null,
        },
      });
      await appendLotEvent(tx, lotId, {
        type: 'FILE_ATTACHED',
        occurredAt: clock.now,
        stage: lot.stage,
        actorMembershipId: membership?.id ?? null,
        summary: `Archivo adjuntado: ${dto.title} (${VISIBILITY_LABEL[visibility]})`,
        data: {
          action: 'ATTACHED',
          kind: dto.kind,
          title: dto.title,
          visibility,
          sha256: facts.sha256,
        },
        resource: { type: ATTACHMENT_RESOURCE, id: row.id },
      });
      await tx.lot.update({
        where: { id: lotId },
        data: { updatedAt: clock.now },
      });
      await this.audit.record(tx, {
        action: AuditAction.ATTACHMENT_ADDED,
        resource: { type: ATTACHMENT_RESOURCE, id: row.id },
        organizationId: wineryId,
        after: {
          lotId,
          kind: dto.kind,
          title: dto.title,
          key: dto.key,
          visibility,
          sha256: facts.sha256,
          sizeBytes: facts.sizeBytes,
        },
      });
      return row;
    }, AUDIT_TX_OPTIONS);

    const actors = await resolveTraceActors(this.prisma, [
      created.createdByMembershipId,
    ]);
    return this.toView(
      { ...created, visibility },
      facts,
      actorOf(actors, created.createdByMembershipId),
    );
  }

  /**
   * Archivos del lote, los más recientes primero: los adjuntos y los informes
   * de dictamen (§3.4) y de laboratorio (§8) guardados por su `key`.
   * AGRONOMIST y OPERATOR solo ven los suyos (§14).
   */
  async list(
    wineryId: string | undefined,
    lotId: string,
    user: AuthenticatedUser,
    query: { limit: number; offset: number },
  ): Promise<Paginated<LotAttachmentView>> {
    const lot = await this.prisma.lot.findFirst({
      where: { id: lotId, ...(wineryId && { wineryId }) },
      select: { id: true, wineryId: true },
    });
    if (!lot) throw lotNotFound();

    const [attachments, changes, decisions, analyses] = await Promise.all([
      this.prisma.lotAttachment.findMany({ where: { lotId } }),
      attachmentVisibilities(this.prisma, lotId),
      this.prisma.phytoDecision.findMany({
        where: {
          harvestBatch: { lotId },
          inspectionReportKey: { not: null },
          voidedAt: null,
        },
        select: {
          id: true,
          inspectionReportKey: true,
          recordedAt: true,
          decidedByMembershipId: true,
          harvestBatch: { select: { harvestBatchCode: true } },
        },
      }),
      this.prisma.batchLabAnalysis.findMany({
        where: { lotId, laboratoryReportKey: { not: null } },
        select: {
          id: true,
          laboratoryReportKey: true,
          certifiedLaboratoryName: true,
          createdAt: true,
          createdByMembershipId: true,
        },
      }),
    ]);

    interface Entry {
      id: string;
      kind: AttachmentKind;
      title: string;
      key: string;
      visibility: AttachmentVisibility;
      createdAt: Date;
      createdByMembershipId: string | null;
      facts: FileFacts | null;
    }
    const entries: Entry[] = [
      ...attachments.map((a) => ({
        id: a.id,
        kind: a.kind as AttachmentKind,
        title: a.title,
        key: a.key,
        visibility: changes.get(a.id) ?? (a.visibility as AttachmentVisibility),
        createdAt: a.createdAt,
        createdByMembershipId: a.createdByMembershipId,
        facts:
          a.mimeType && a.sizeBytes !== null && a.sha256
            ? { mimeType: a.mimeType, sizeBytes: a.sizeBytes, sha256: a.sha256 }
            : null,
      })),
      ...decisions.map((d) => ({
        id: d.id,
        kind: 'PHYTO_REPORT' as const,
        title: `Informe de inspección · ${d.harvestBatch.harvestBatchCode}`,
        key: d.inspectionReportKey as string,
        visibility: 'PRIVATE' as const,
        createdAt: d.recordedAt,
        createdByMembershipId: d.decidedByMembershipId,
        facts: null,
      })),
      ...analyses.map((l) => ({
        id: l.id,
        kind: 'LAB_REPORT' as const,
        title: `Informe de laboratorio · ${l.certifiedLaboratoryName}`,
        key: l.laboratoryReportKey as string,
        visibility: 'PRIVATE' as const,
        createdAt: l.createdAt,
        createdByMembershipId: l.createdByMembershipId,
        facts: null,
      })),
    ];

    let visible = entries;
    if (
      user.organizationType === 'WINERY' &&
      OWN_ATTACHMENTS_ONLY.has(user.role ?? '')
    ) {
      const own = await actorMembership(this.prisma, user.id, lot.wineryId);
      visible = entries.filter(
        (e) => own !== null && e.createdByMembershipId === own.id,
      );
    }
    visible.sort(
      (a, b) =>
        b.createdAt.getTime() - a.createdAt.getTime() ||
        a.id.localeCompare(b.id),
    );

    const page = visible.slice(query.offset, query.offset + query.limit);
    const actors = await resolveTraceActors(
      this.prisma,
      page.map((e) => e.createdByMembershipId),
    );
    const items: LotAttachmentView[] = [];
    let missing = 0;
    for (const entry of page) {
      const facts =
        entry.facts ?? (await this.fileFacts(lot.wineryId, entry.key));
      if (!facts) {
        // El archivo ya no está en el almacenamiento: no se puede firmar ni describir
        missing++;
        continue;
      }
      items.push(
        await this.toView(
          entry,
          facts,
          actorOf(actors, entry.createdByMembershipId),
        ),
      );
    }
    return toPage(items, visible.length - missing, query);
  }

  /**
   * Cambia la visibilidad sin editar el adjunto: registra el cambio en la
   * línea de tiempo y en la bitácora. Repetir la visibilidad vigente no
   * registra nada.
   */
  async changeVisibility(
    wineryId: string,
    lotId: string,
    attachmentId: string,
    user: AuthenticatedUser,
    next: AttachmentVisibility,
  ): Promise<LotAttachmentView> {
    const row = await this.prisma.$transaction(async (tx) => {
      const lot = await lockLot(tx, lotId, wineryId);
      const attachment = await tx.lotAttachment.findFirst({
        where: { id: attachmentId, lotId },
      });
      if (!attachment) {
        throw new AppException(
          404,
          ErrorCode.NOT_FOUND,
          'Archivo del lote no encontrado',
        );
      }
      const changes = await attachmentVisibilities(tx, lotId);
      const current =
        changes.get(attachment.id) ??
        (attachment.visibility as AttachmentVisibility);
      if (current !== next) {
        const clock = await dbClock(tx);
        const membership = await actorMembership(tx, user.id, wineryId);
        await appendLotEvent(tx, lotId, {
          type: 'FILE_ATTACHED',
          occurredAt: clock.now,
          stage: lot.stage,
          actorMembershipId: membership?.id ?? null,
          summary: `Archivo "${attachment.title}": ahora es ${VISIBILITY_LABEL[next]}`,
          data: {
            action: VISIBILITY_CHANGED,
            kind: attachment.kind,
            title: attachment.title,
            visibility: next,
            previousVisibility: current,
          },
          resource: { type: ATTACHMENT_RESOURCE, id: attachment.id },
        });
        await tx.lot.update({
          where: { id: lotId },
          data: { updatedAt: clock.now },
        });
        await this.audit.record(tx, {
          action: AuditAction.ATTACHMENT_VISIBILITY_CHANGED,
          resource: { type: ATTACHMENT_RESOURCE, id: attachment.id },
          organizationId: wineryId,
          before: { visibility: current },
          after: { visibility: next, lotId },
        });
      }
      return attachment;
    }, AUDIT_TX_OPTIONS);

    const facts =
      row.mimeType && row.sizeBytes !== null && row.sha256
        ? {
            mimeType: row.mimeType,
            sizeBytes: row.sizeBytes,
            sha256: row.sha256,
          }
        : await this.fileFacts(wineryId, row.key);
    if (!facts) {
      throw new AppException(
        404,
        ErrorCode.NOT_FOUND,
        'Archivo del lote no encontrado',
      );
    }
    const actors = await resolveTraceActors(this.prisma, [
      row.createdByMembershipId,
    ]);
    return this.toView(
      {
        id: row.id,
        kind: row.kind as AttachmentKind,
        title: row.title,
        key: row.key,
        visibility: next,
        createdAt: row.createdAt,
      },
      facts,
      actorOf(actors, row.createdByMembershipId),
    );
  }

  private async toView(
    entry: {
      id: string;
      kind: string;
      title: string;
      key: string;
      visibility: string;
      createdAt: Date;
    },
    facts: FileFacts,
    createdBy: TraceActor | null,
  ): Promise<LotAttachmentView> {
    const signed = await this.storage.getSignedUrl(
      entry.key,
      DEFAULT_SIGNED_URL_TTL_SECONDS,
    );
    return {
      id: entry.id,
      kind: entry.kind as AttachmentKind,
      title: entry.title,
      key: entry.key,
      mimeType: facts.mimeType,
      sizeBytes: facts.sizeBytes,
      sha256: facts.sha256,
      visibility: entry.visibility === 'PUBLIC' ? 'PUBLIC' : 'PRIVATE',
      url: signed.url,
      urlExpiresAt: signed.expiresAt.toISOString(),
      createdAt: entry.createdAt.toISOString(),
      createdBy,
    };
  }

  /**
   * Tipo real, tamaño y huella SHA-256 de un archivo de la bodega, o `null`
   * si la `key` no es suya o no existe. Los archivos no cambian (la `key`
   * lleva un UUID), así que el resultado se recuerda en Redis.
   */
  private async fileFacts(
    wineryId: string,
    key: string,
  ): Promise<FileFacts | null> {
    if (!isSafeStorageKey(key) || !key.startsWith(`org/${wineryId}/`)) {
      return null;
    }
    const cacheKey = `trace:file-facts:${key}`;
    try {
      if (await redisReady(this.redis)) {
        const cached = await this.redis.get(cacheKey);
        if (cached) return JSON.parse(cached) as FileFacts;
      }
    } catch {
      // Sin caché: se lee del almacenamiento
    }
    const body = await this.storage.get(key);
    if (!body) return null;
    const facts: FileFacts = {
      mimeType:
        detectFileType(body)?.mimeType ??
        fileTypeForKey(key)?.mimeType ??
        'application/octet-stream',
      sizeBytes: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
    };
    try {
      if (await redisReady(this.redis)) {
        await this.redis.set(
          cacheKey,
          JSON.stringify(facts),
          'EX',
          FILE_FACTS_TTL_SECONDS,
        );
      }
    } catch (error) {
      this.logger.debug(
        `Caché de archivos no disponible: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return facts;
  }
}
