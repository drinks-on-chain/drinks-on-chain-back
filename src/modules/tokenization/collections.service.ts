import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditAction } from '@shared/audit/audit.actions';
import { AUDIT_TX_OPTIONS, AuditService } from '@shared/audit/audit.service';
import {
  PaginationQueryDto,
  toPage,
  toPrismaPage,
} from '@shared/dto/pagination-query.dto';
import { ErrorCode } from '@shared/exceptions/error-codes';
import { ValidationException } from '@shared/exceptions/validation.exception';
import type { Paginated } from '@shared/interfaces/api-response.interface';
import { OutboxService } from '@shared/outbox/outbox.service';
import { PrismaService } from '@shared/prisma/prisma.service';
import type { ChainTxRefDto } from '@modules/chain/dto/chain-common.dto';
import { toDbDate } from '@modules/lots/domain/dates';
import type { LotStage } from '@modules/lots/domain/lot-stage';
import {
  ruleError,
  stateError,
  TraceRuleException,
} from '@modules/lots/domain/trace-errors';
import { appendLotEvent, formatQuantity } from '@modules/lots/lot-events';
import { dbClock, lockLotRow } from '@modules/lots/trace-db';
import { MailService } from '@modules/mail/mail.service';
import { CollectionImagesService } from './collection-images.service';
import {
  collectionSlug,
  commercialMissing,
  duplicatedImageKeys,
  formatPrice,
  priceViolations,
} from './domain/commercial';
import {
  nextCollectionStatus,
  type CollectionAction,
} from './domain/state-machines';
import type {
  CollectionDto,
  CollectionMetricsDto,
  CollectionOptionalReasonDto,
  CollectionReasonDto,
  CollectionsQueryDto,
  CollectionSummaryDto,
  PlatformCollectionsQueryDto,
  TokenDto,
  TokensQueryDto,
  UpdateCollectionDto,
} from './dto/collections.dto';
import type { CollectionPriceDto } from './dto/commercial.dto';
import {
  TOKENIZATION_CHAIN_PORT,
  type TokenizationChainPort,
} from './ports/tokenization-chain.port';
import {
  COLLECTION_FULL_INCLUDE,
  COLLECTION_INCLUDE,
  wineryOwners,
  type CollectionFullRow,
} from './tokenization-data';
import { TokenizationReader } from './tokenization-reader.service';
import type { CollectionStatus } from './tokenization.constants';
import {
  COLLECTION_AGGREGATE,
  COLLECTION_CLOSED,
  COLLECTION_PAUSED,
  COLLECTION_PUBLISHED,
  COLLECTION_RESUMED,
  type CollectionEventPayload,
} from './tokenization.events';

type Tx = Prisma.TransactionClient;
type Clock = { now: Date; today: string };

interface StaffActor {
  userId: string;
  fullName: string;
}

/** Estados de un NFT que ya tuvo comprador (Olas 4 y 5). */
const SOLD_TOKEN_STATUSES = [
  'SOLD',
  'REDEEMABLE',
  'PASS_ACTIVE',
  'REDEEMED',
  'EXPIRED',
];

/** Cierres del lote que dejan cerrar la colección (§8.4). */
const RESOLVED_CLOSURE_STATUSES = ['NO_SHORTFALL', 'RESOLVED'];

function collectionNotFound(): TraceRuleException {
  return new TraceRuleException(
    404,
    ErrorCode.TOK_COLLECTION_NOT_FOUND,
    'Colección no encontrada',
  );
}

const ACTION_META: Record<
  CollectionAction,
  { audit: string; event: string; label: string; effect: string }
> = {
  PUBLISH: {
    audit: AuditAction.COLLECTION_PUBLISHED,
    event: COLLECTION_PUBLISHED,
    label: 'publicada',
    effect: 'Ya está a la venta en el Marketplace.',
  },
  PAUSE: {
    audit: AuditAction.COLLECTION_PAUSED,
    event: COLLECTION_PAUSED,
    label: 'pausada',
    effect:
      'Deja de venderse mientras dure la pausa; los NFT ya vendidos no cambian.',
  },
  RESUME: {
    audit: AuditAction.COLLECTION_RESUMED,
    event: COLLECTION_RESUMED,
    label: 'reanudada',
    effect: 'Vuelve a estar a la venta en el Marketplace.',
  },
  CLOSE: {
    audit: AuditAction.COLLECTION_CLOSED,
    event: COLLECTION_CLOSED,
    label: 'cerrada',
    effect: 'Ya no se vende más; los NFT vendidos siguen siendo válidos.',
  },
};

/**
 * Colecciones (contrato O3 §6.2, §6.4 y §8.5; TOK-06…08, TOK-11): lecturas del
 * ERP y del back office, datos comerciales y precio con historial, y las
 * transiciones comerciales `publish`, `pause`, `resume` y `close`. Ninguna
 * toca la red: la pausa comercial es solo de la base (§3.5).
 */
@Injectable()
export class CollectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly mail: MailService,
    private readonly reader: TokenizationReader,
    private readonly images: CollectionImagesService,
    @Inject(TOKENIZATION_CHAIN_PORT)
    private readonly chainPort: TokenizationChainPort,
  ) {}

  // ── Lecturas ─────────────────────────────────────────────────────────────

  /** `GET /v1/collections` (ERP). */
  async list(
    wineryId: string | undefined,
    query: CollectionsQueryDto,
  ): Promise<Paginated<CollectionSummaryDto>> {
    return this.page(
      {
        ...(wineryId && { wineryId }),
        ...(query.lotId && { lotId: query.lotId }),
        ...(query.status && { status: query.status }),
      },
      query,
    );
  }

  /** `GET /v1/platform/collections`. */
  async platformList(
    query: PlatformCollectionsQueryDto,
  ): Promise<Paginated<CollectionSummaryDto>> {
    const and: Prisma.CollectionWhereInput[] = [];
    if (query.status) and.push({ status: query.status });
    if (query.wineryId) and.push({ wineryId: query.wineryId });
    if (query.mintStatus) and.push({ mintStatus: query.mintStatus });
    if (query.saleState) {
      // Derivado (§6.2): agotada = publicada sin ningún NFT disponible
      const soldOut: Prisma.CollectionWhereInput = {
        minted: { gt: 0 },
        tokens: { none: { status: 'MINTED' } },
      };
      and.push({ status: 'PUBLISHED' });
      if (query.saleState === 'SOLD_OUT') and.push(soldOut);
      else {
        and.push({ NOT: soldOut });
        and.push({ redeemable: query.saleState === 'ON_SALE' });
      }
    }
    if (query.q) {
      const contains = { contains: query.q, mode: 'insensitive' as const };
      and.push({
        OR: [
          { name: contains },
          { slug: contains },
          { winery: { commercialName: contains } },
          { lot: { reference: contains } },
          { lot: { lotCode: contains } },
        ],
      });
    }
    return this.page(and.length > 0 ? { AND: and } : {}, query);
  }

  private async page(
    where: Prisma.CollectionWhereInput,
    query: PaginationQueryDto,
  ): Promise<Paginated<CollectionSummaryDto>> {
    const [rows, total] = await Promise.all([
      this.prisma.collection.findMany({
        where,
        include: COLLECTION_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        ...toPrismaPage(query),
      }),
      this.prisma.collection.count({ where }),
    ]);
    return toPage(await this.reader.collectionSummaries(rows), total, query);
  }

  /** `GET /v1/collections/{id}` y `GET /v1/platform/collections/{id}`. */
  async get(wineryId: string | undefined, id: string): Promise<CollectionDto> {
    return this.reader.collectionView(await this.load(id, wineryId));
  }

  private async load(
    id: string,
    wineryId?: string,
  ): Promise<CollectionFullRow> {
    const row = await this.reader.loadCollection(id, wineryId);
    if (!row) throw collectionNotFound();
    return row;
  }

  /** `GET …/collections/{id}/tokens`: por número de botella. */
  async tokens(
    wineryId: string | undefined,
    id: string,
    query: TokensQueryDto,
  ): Promise<Paginated<TokenDto>> {
    const collection = await this.load(id, wineryId);
    if (
      query.fromNumber !== undefined &&
      query.toNumber !== undefined &&
      query.fromNumber > query.toNumber
    ) {
      throw ValidationException.forField(
        'toNumber',
        'toNumber no puede ser menor que fromNumber',
      );
    }
    const where: Prisma.TokenWhereInput = {
      collectionId: id,
      ...(query.status && { status: query.status }),
      ...((query.fromNumber !== undefined || query.toNumber !== undefined) && {
        bottleNumber: {
          ...(query.fromNumber !== undefined && { gte: query.fromNumber }),
          ...(query.toNumber !== undefined && { lte: query.toNumber }),
        },
      }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.token.findMany({
        where,
        orderBy: { bottleNumber: 'asc' },
        ...toPrismaPage(query),
      }),
      this.prisma.token.count({ where }),
    ]);
    return toPage(await this.reader.tokenViews(collection, rows), total, query);
  }

  /** `GET /v1/platform/collections/{id}/transactions`: emisiones y quemas, las más recientes primero. */
  async transactions(
    id: string,
    query: PaginationQueryDto,
  ): Promise<Paginated<ChainTxRefDto>> {
    const collection = await this.load(id);
    const where = await this.reader.transactionsWhere(collection);
    const [rows, total] = await Promise.all([
      this.prisma.chainTransaction.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        ...toPrismaPage(query),
      }),
      this.prisma.chainTransaction.count({ where }),
    ]);
    return toPage(
      rows.map((row) => this.reader.transactionRef(row)),
      total,
      query,
    );
  }

  /** `GET /v1/platform/collections/{id}/metrics` (§8.5). */
  async metrics(id: string): Promise<CollectionMetricsDto> {
    return this.reader.metrics(await this.load(id));
  }

  // ── Datos comerciales y precio ───────────────────────────────────────────

  /**
   * `PATCH /v1/platform/collections/{id}`: datos comerciales, precio o fecha
   * de canje, con motivo. El precio queda en `priceHistory`; el `slug` sigue
   * al nombre solo hasta que la colección se publica.
   */
  async update(
    id: string,
    userId: string,
    dto: UpdateCollectionDto,
  ): Promise<CollectionDto> {
    const current = await this.load(id);
    const commercial = dto.commercial;
    if (commercial && duplicatedImageKeys(commercial).length > 0) {
      throw ValidationException.forField(
        'commercial.imageKeys',
        'Cada imagen puede aparecer una sola vez',
      );
    }
    const known = new Map(
      current.images.map((i) => [i.key, { sha256: i.sha256, mimeType: '' }]),
    );
    const digests = await this.images.inspect(
      current.wineryId,
      commercial?.imageKeys ?? [],
      'commercial.imageKeys',
      known,
    );
    const reason = dto.reason.trim();

    await this.onCollection(id, async (tx, row, clock) => {
      if (row.status === 'CLOSED') {
        throw stateError(
          ErrorCode.TOK_COLLECTION_INVALID_TRANSITION,
          'La colección está cerrada: ya no se edita',
          [
            {
              field: null,
              code: ErrorCode.TOK_COLLECTION_INVALID_TRANSITION,
              message: 'Una colección cerrada no admite cambios',
              actual: row.status,
              meta: { from: row.status, to: row.status },
            },
          ],
        );
      }
      const actor = await this.staffActor(tx, userId);
      const data: Prisma.CollectionUpdateInput = {};
      const changed: string[] = [];

      if (commercial?.name !== undefined && commercial.name !== row.name) {
        data.name = commercial.name;
        changed.push('name');
        if (row.publishedAt === null) {
          const slug = collectionSlug(commercial.name);
          if (slug !== row.slug) {
            const taken = await tx.collection.findUnique({
              where: { wineryId_slug: { wineryId: row.wineryId, slug } },
              select: { id: true },
            });
            if (taken) {
              throw stateError(
                ErrorCode.TOK_SLUG_TAKEN,
                'La bodega ya tiene una colección con ese nombre: cámbialo para que su dirección sea única',
                [
                  {
                    field: 'commercial.name',
                    code: ErrorCode.TOK_SLUG_TAKEN,
                    message:
                      'El nombre genera un slug que ya usa otra colección de la bodega',
                    meta: { slug },
                  },
                ],
              );
            }
            data.slug = slug;
            changed.push('slug');
          }
        }
      }
      if (
        commercial?.description !== undefined &&
        commercial.description !== row.description
      ) {
        data.description = commercial.description;
        changed.push('description');
      }
      if (commercial?.tastingNotes !== undefined) {
        data.tastingNotes = commercial.tastingNotes?.trim() || null;
        changed.push('tastingNotes');
      }
      if (commercial?.pairing !== undefined) {
        data.pairing = commercial.pairing?.trim() || null;
        changed.push('pairing');
      }
      const redeemDate =
        dto.estimatedRedeemDate !== undefined
          ? dto.estimatedRedeemDate
          : commercial?.estimatedRedeemDate;
      if (redeemDate !== undefined) {
        data.estimatedRedeemDate = redeemDate ? toDbDate(redeemDate) : null;
        changed.push('estimatedRedeemDate');
      }

      if (commercial?.imageKeys !== undefined) {
        let cover = false;
        const images = commercial.imageKeys.map((image, position) => {
          const isCover = image.isCover === true && !cover;
          if (isCover) cover = true;
          return { ...image, isCover, position };
        });
        if (!cover) {
          throw ruleError(
            ErrorCode.TOK_COMMERCIAL_DATA_INCOMPLETE,
            'La colección necesita una imagen de portada',
            commercialMissing({
              name: row.name,
              description: row.description,
              hasCover: false,
            }),
          );
        }
        const keys = images.map((i) => i.key);
        await tx.collectionImage.deleteMany({
          where: { collectionId: id, key: { notIn: keys } },
        });
        // Primero se quita la portada: solo puede haber una (índice único)
        await tx.collectionImage.updateMany({
          where: { collectionId: id, isCover: true },
          data: { isCover: false },
        });
        for (const image of images) {
          await tx.collectionImage.upsert({
            where: { collectionId_key: { collectionId: id, key: image.key } },
            create: {
              collectionId: id,
              key: image.key,
              sha256: digests.get(image.key)?.sha256 ?? '',
              alt: image.alt,
              isCover: image.isCover,
              position: image.position,
            },
            update: {
              alt: image.alt,
              isCover: image.isCover,
              position: image.position,
            },
          });
        }
        changed.push('images');
      }

      let priceChange: {
        before: number | null;
        after: number | null;
      } | null = null;
      if (
        dto.price !== undefined &&
        (dto.price?.amountMinor ?? null) !== row.priceAmountMinor
      ) {
        const violations = priceViolations(dto.price);
        if (violations.length > 0) {
          throw ruleError(
            ErrorCode.TOK_PRICE_INVALID,
            violations[0].message,
            violations,
          );
        }
        const sold = await tx.token.count({
          where: {
            collectionId: id,
            OR: [
              { status: { in: SOLD_TOKEN_STATUSES } },
              { soldAt: { not: null } },
            ],
          },
        });
        if (sold > 0) {
          throw stateError(
            ErrorCode.TOK_PRICE_LOCKED,
            'La colección ya tiene ventas: su precio no se puede cambiar',
            [
              {
                field: 'price',
                code: ErrorCode.TOK_PRICE_LOCKED,
                message: `Ya se vendieron ${formatQuantity(sold)} NFT de esta colección`,
                meta: { sold },
              },
            ],
          );
        }
        priceChange = {
          before: row.priceAmountMinor,
          after: dto.price?.amountMinor ?? null,
        };
        if (dto.price === null) {
          data.priceAmountMinor = null;
          data.priceCurrency = null;
          data.priceSource = null;
          data.priceSetAt = null;
          data.priceSetByUserId = null;
        } else {
          const suggestion = await this.reader.priceSuggestion(
            row.wineryId,
            tx,
          );
          const entry: CollectionPriceDto = {
            amountMinor: dto.price.amountMinor,
            currency: dto.price.currency,
            source:
              suggestion.available &&
              suggestion.amountMinor === dto.price.amountMinor
                ? 'POLICY_SUGGESTED'
                : 'MANUAL',
            setAt: clock.now.toISOString(),
            setBy: { userId: actor.userId, fullName: actor.fullName },
          };
          data.priceAmountMinor = entry.amountMinor;
          data.priceCurrency = entry.currency;
          data.priceSource = entry.source;
          data.priceSetAt = clock.now;
          data.priceSetByUserId = actor.userId;
          data.priceHistory = [
            ...(Array.isArray(row.priceHistory) ? row.priceHistory : []),
            entry as unknown as Prisma.InputJsonObject,
          ] as Prisma.InputJsonArray;
        }
        changed.push('price');
      }

      if (changed.length === 0) return;
      // Fuerza `updatedAt` aunque solo cambien las imágenes
      await tx.collection.update({
        where: { id },
        data: { ...data, updatedAt: clock.now },
      });
      const nonPrice = changed.filter((field) => field !== 'price');
      if (nonPrice.length > 0) {
        await this.audit.record(tx, {
          action: AuditAction.COLLECTION_UPDATED,
          resource: { type: 'collection', id },
          organizationId: row.wineryId,
          before: { name: row.name, slug: row.slug },
          after: {
            fields: nonPrice,
            ...(data.name !== undefined && { name: data.name }),
            ...(data.slug !== undefined && { slug: data.slug }),
          },
          reason,
        });
      }
      if (priceChange) {
        await this.audit.record(tx, {
          action: AuditAction.COLLECTION_PRICE_SET,
          resource: { type: 'collection', id },
          organizationId: row.wineryId,
          before: {
            priceAmountMinor: priceChange.before,
            price:
              priceChange.before !== null
                ? formatPrice(priceChange.before)
                : null,
          },
          after: {
            priceAmountMinor: priceChange.after,
            price:
              priceChange.after !== null
                ? formatPrice(priceChange.after)
                : null,
          },
          reason,
        });
      }
    });
    return this.get(undefined, id);
  }

  // ── Transiciones comerciales ─────────────────────────────────────────────

  /** `POST …/publish`: `READY → PUBLISHED` (preventa hasta el anclaje). */
  publish(
    id: string,
    userId: string,
    dto: CollectionOptionalReasonDto,
  ): Promise<CollectionDto> {
    return this.transition(id, userId, 'PUBLISH', dto.reason?.trim() || null);
  }

  /** `POST …/pause`: `PUBLISHED → PAUSED` (pausa comercial, no toca la red). */
  pause(
    id: string,
    userId: string,
    dto: CollectionReasonDto,
  ): Promise<CollectionDto> {
    return this.transition(id, userId, 'PAUSE', dto.reason.trim());
  }

  /** `POST …/resume`: `PAUSED → PUBLISHED`, con las condiciones de publicar. */
  resume(
    id: string,
    userId: string,
    dto: CollectionOptionalReasonDto,
  ): Promise<CollectionDto> {
    return this.transition(id, userId, 'RESUME', dto.reason?.trim() || null);
  }

  /** `POST …/close`: `→ CLOSED` con el cierre del lote resuelto (§8.4). */
  close(
    id: string,
    userId: string,
    dto: CollectionReasonDto,
  ): Promise<CollectionDto> {
    return this.transition(id, userId, 'CLOSE', dto.reason.trim());
  }

  private async transition(
    id: string,
    userId: string,
    action: CollectionAction,
    reason: string | null,
  ): Promise<CollectionDto> {
    await this.onCollection(id, async (tx, row, clock) => {
      const from = row.status as CollectionStatus;
      // Publicar antes de que la emisión inicial se confirme no es una
      // transición rara: es la emisión sin confirmar (§6.4)
      if (action === 'PUBLISH' && from === 'MINTING') {
        throw mintNotConfirmed(row.mintStatus);
      }
      const to = nextCollectionStatus(from, action);
      if (action === 'PUBLISH' || action === 'RESUME') {
        await this.assertPublishable(tx, row);
      }
      if (action === 'CLOSE') await this.assertClosable(tx, row);
      const actor = await this.staffActor(tx, userId);
      const firstPublication = to === 'PUBLISHED' && row.publishedAt === null;
      await tx.collection.update({
        where: { id },
        data: {
          status: to,
          ...(firstPublication && { publishedAt: clock.now }),
          ...(to === 'CLOSED' && { closedAt: clock.now }),
        },
      });
      await tx.collectionStatusHistory.create({
        data: {
          collectionId: id,
          status: to,
          reason,
          actorUserId: actor.userId,
          actorName: actor.fullName,
          at: clock.now,
        },
      });
      if (action === 'PUBLISH') {
        await appendLotEvent(tx, row.lotId, {
          type: 'COLLECTION_PUBLISHED',
          occurredAt: clock.now,
          stage: row.lot.stage as LotStage,
          actorMembershipId: null,
          summary: `${formatQuantity(row.minted)} botellas en preventa`,
          data: {
            collectionId: id,
            slug: row.slug,
            quota: row.quota,
            minted: row.minted,
          },
          resource: { type: 'collection', id },
        });
      }
      const meta = ACTION_META[action];
      await this.audit.record(tx, {
        action: meta.audit,
        resource: { type: 'collection', id },
        organizationId: row.wineryId,
        before: { status: from },
        after: { status: to },
        reason,
      });
      await this.outbox.add<CollectionEventPayload>(tx, {
        type: meta.event,
        aggregateType: COLLECTION_AGGREGATE,
        aggregateId: id,
        payload: {
          collectionId: id,
          wineryId: row.wineryId,
          lotId: row.lotId,
          slug: row.slug,
          status: to,
          system: false,
        },
      });
      for (const owner of await wineryOwners(tx, row.wineryId)) {
        await this.mail.enqueue(tx, {
          template: 'coleccion-estado',
          to: owner.email,
          organizationId: row.wineryId,
          variables: {
            nombre: owner.fullName,
            coleccion: row.name,
            estado: meta.label,
            efecto: meta.effect,
            motivo: reason ?? 'Sin motivo indicado',
          },
        });
      }
    });
    return this.get(undefined, id);
  }

  /**
   * Condiciones de publicar y de reanudar (§6.2): emisiones confirmadas,
   * datos comerciales completos, bodega `ACTIVE` y contrato sin pausar.
   */
  private async assertPublishable(
    tx: Tx,
    row: CollectionFullRow,
  ): Promise<void> {
    if (
      row.mintStatus !== 'CONFIRMED' ||
      row.pendingMintQuantity > 0 ||
      row.minted < 1
    ) {
      throw mintNotConfirmed(row.mintStatus);
    }
    const missing = commercialMissing({
      name: row.name,
      description: row.description,
      hasCover: row.images.some((i) => i.isCover),
    });
    if (missing.length > 0) {
      throw ruleError(
        ErrorCode.TOK_COMMERCIAL_DATA_INCOMPLETE,
        'Faltan datos comerciales para publicar la colección',
        missing,
      );
    }
    const winery = await tx.winery.findUniqueOrThrow({
      where: { id: row.wineryId },
      select: { certificationStatus: true },
    });
    if (winery.certificationStatus !== 'ACTIVE') {
      throw stateError(
        ErrorCode.TOK_WINERY_NOT_ACTIVE,
        'La bodega no está activa: su colección no se puede publicar',
        [
          {
            field: null,
            code: ErrorCode.TOK_WINERY_NOT_ACTIVE,
            message: `La bodega está ${winery.certificationStatus}`,
            expected: 'ACTIVE',
            actual: winery.certificationStatus,
            meta: { status: winery.certificationStatus },
          },
        ],
      );
    }
    const identity = await this.chainPort.wineryIdentity(tx, row.wineryId);
    if (
      row.contract.paused ||
      identity.status === 'PAUSED' ||
      identity.contract?.paused
    ) {
      throw stateError(
        ErrorCode.CHN_CONTRACT_PAUSED,
        'El contrato de la bodega está pausado en la red: la colección no se puede publicar',
        [
          {
            field: null,
            code: ErrorCode.CHN_CONTRACT_PAUSED,
            message: 'Reanuda el contrato de la bodega antes de publicar',
            meta: { status: identity.status },
          },
        ],
      );
    }
  }

  /** Cerrar exige el cierre del lote resuelto (§8.4); si no, 409 `TOK_CLOSURE_PENDING`. */
  private async assertClosable(tx: Tx, row: CollectionFullRow): Promise<void> {
    const closure = await tx.lotClosure.findUnique({
      where: { collectionId: row.id },
      select: { status: true },
    });
    if (closure && RESOLVED_CLOSURE_STATUSES.includes(closure.status)) return;
    throw stateError(
      ErrorCode.TOK_CLOSURE_PENDING,
      closure
        ? 'El cierre del lote aún no está resuelto: decide el faltante antes de cerrar la colección'
        : 'El lote aún no tiene cierre (se calcula al embotellarlo o descartarlo): la colección no se puede cerrar',
      [
        {
          field: null,
          code: ErrorCode.TOK_CLOSURE_PENDING,
          message: closure
            ? `Cierre del lote: ${closure.status}`
            : 'El lote no se ha embotellado ni descartado',
          expected: RESOLVED_CLOSURE_STATUSES,
          actual: closure?.status ?? null,
          meta: {
            closureStatus: closure?.status ?? null,
            stage: row.lot.stage,
          },
        },
      ],
    );
  }

  // ── Utilidades ───────────────────────────────────────────────────────────

  /** Ejecuta `work` con el lote de la colección bloqueado y la colección releída. */
  private async onCollection(
    id: string,
    work: (tx: Tx, row: CollectionFullRow, clock: Clock) => Promise<void>,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const found = await tx.collection.findUnique({
        where: { id },
        select: { lotId: true },
      });
      if (!found) throw collectionNotFound();
      await lockLotRow(tx, found.lotId);
      const row = await tx.collection.findUniqueOrThrow({
        where: { id },
        include: COLLECTION_FULL_INCLUDE,
      });
      await work(tx, row, await dbClock(tx));
    }, AUDIT_TX_OPTIONS);
  }

  private async staffActor(tx: Tx, userId: string): Promise<StaffActor> {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { fullName: true },
    });
    return { userId, fullName: user?.fullName ?? '' };
  }
}

function mintNotConfirmed(mintStatus: string): TraceRuleException {
  return stateError(
    ErrorCode.TOK_MINT_NOT_CONFIRMED,
    'La emisión de los NFT aún no está confirmada en la red: la colección no se puede publicar',
    [
      {
        field: null,
        code: ErrorCode.TOK_MINT_NOT_CONFIRMED,
        message: `Emisión: ${mintStatus}`,
        expected: 'CONFIRMED',
        actual: mintStatus,
        meta: { mintStatus },
      },
    ],
  );
}
