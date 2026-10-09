import { Inject, Injectable } from '@nestjs/common';
import type { ChainTransaction, Prisma } from '@prisma/client';
import { PrismaService } from '@shared/prisma/prisma.service';
import {
  ObjectStorage,
  STORAGE_SERVICE,
} from '@shared/storage/storage.interface';
import {
  CHAIN_SETTINGS,
  type ChainSettings,
} from '@modules/chain/chain.config';
import type {
  ChainTxRefDto,
  DossierAnchorDto,
} from '@modules/chain/dto/chain-common.dto';
import { explorerContractUrl } from '@modules/chain/explorer';
import { isLateEntry } from '@modules/lots/domain/late-entry';
import type { LotProductType, LotStage } from '@modules/lots/domain/lot-stage';
import type { LotEventType } from '@modules/lots/lot-events';
import { lotActorIds, toLotView, type LotView } from '@modules/lots/lot-view';
import {
  actorOf,
  resolveTraceActors,
  type TraceActor,
} from '@modules/lots/trace-actors';
import { dbClock } from '@modules/lots/trace-db';
import { resolveSettingsFromDatabase } from '@modules/settings/settings.resolve';
import {
  collectionImagesArePublic,
  publicCollectionImageUrl,
} from './collection-images';
import { parseCommercialDraft } from './domain/commercial';
import { computeLimits, type TokenizationLimits } from './domain/quota';
import { saleState } from './domain/state-machines';
import type {
  CollectionDto,
  CollectionMetricsDto,
  CollectionSummaryDto,
  MintDto,
  MintRangeDto,
  TokenDto,
} from './dto/collections.dto';
import type {
  CollectionImageDto,
  CollectionPriceDto,
  PriceSuggestionDto,
} from './dto/commercial.dto';
import { closureOfCollection } from './closure/closure-view';
import {
  TOKEN_COUNT_KEYS,
  ZERO_TOKEN_COUNTS,
  type TokenCountsDto,
} from './dto/token-counts.dto';
import type {
  PlatformTokenizationRequestDto,
  TokenizationRequestDto,
  TokenizationRequestSummaryDto,
  TokenizationReviewDto,
} from './dto/tokenization-requests.dto';
import { toChainTxRef } from '@modules/chain/tx/chain-tx.mapper';
import { toDossierAnchor } from '@modules/chain/anchor/anchor-view';
import {
  TOKENIZATION_CHAIN_PORT,
  type TokenizationChainPort,
} from './ports/tokenization-chain.port';
import {
  COLLECTION_FULL_INCLUDE,
  COLLECTION_INCLUDE,
  type CollectionFullRow,
  type CollectionRow,
  type Db,
  loadQuotaLot,
  type RequestFullRow,
  type RequestRow,
  stroopsToXlm,
  SYSTEM_ACTOR_NAME,
  userNames,
} from './tokenization-data';
import type {
  CollectionStatus,
  MintStatus,
  PriceCurrency,
  PriceSource,
  TokenBurnReason,
  TokenizationRequestKind,
  TokenizationRequestStatus,
  TokenOwnerKind,
  TokenStatus,
} from './tokenization.constants';

const iso = (value: Date | null | undefined): string | null =>
  value ? value.toISOString() : null;
const ymd = (value: Date | null | undefined): string | null =>
  value ? value.toISOString().slice(0, 10) : null;

/**
 * Lecturas de la tokenización (contrato O3 §5.1, §6.2, §6.3 y §8.5): arma las
 * vistas de solicitudes, colecciones, emisiones, NFT y métricas a partir de
 * la base. No escribe ni habla con la red.
 */
@Injectable()
export class TokenizationReader {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_SERVICE) private readonly storage: ObjectStorage,
    @Inject(CHAIN_SETTINGS) private readonly chain: ChainSettings,
    @Inject(TOKENIZATION_CHAIN_PORT)
    private readonly chainPort: TokenizationChainPort,
  ) {}

  // ── Solicitudes ──────────────────────────────────────────────────────────

  async requestSummaries(
    rows: RequestRow[],
    client: Db = this.prisma,
  ): Promise<TokenizationRequestSummaryDto[]> {
    const [actors, users] = await Promise.all([
      resolveTraceActors(
        client,
        rows.map((r) => r.submittedByMembershipId),
      ),
      userNames(
        client,
        rows.map((r) => r.assigneeUserId),
      ),
    ]);
    return rows.map((row) => this.toRequestSummary(row, actors, users));
  }

  private toRequestSummary(
    row: RequestRow,
    actors: Map<string, TraceActor>,
    users: Map<string, string>,
  ): TokenizationRequestSummaryDto {
    const submittedBy = actorOf(actors, row.submittedByMembershipId);
    return {
      id: row.id,
      wineryId: row.wineryId,
      winery: {
        slug: row.winery.slug ?? '',
        tradeName: row.winery.commercialName,
      },
      lotId: row.lotId,
      lot: {
        reference: row.lot.reference,
        lotCode: row.lot.lotCode,
        name: row.lot.name,
        productType: row.lot.productType as LotProductType | null,
        stage: row.lot.stage as LotStage,
        harvestYear: row.lot.harvestYear,
        estimatedBottles: row.lot.estimatedBottles,
        bottles: row.lot.bottlingBatch ? row.lot._count.bottleUnits : null,
      },
      kind: row.kind as TokenizationRequestKind,
      status: row.status as TokenizationRequestStatus,
      quantity: row.quantity,
      resultingQuota: row.resultingQuota,
      requiresApproval: row.requiresApproval,
      assignee: row.assigneeUserId
        ? {
            userId: row.assigneeUserId,
            fullName: users.get(row.assigneeUserId) ?? '',
          }
        : null,
      submittedAt: row.submittedAt.toISOString(),
      // La envía siempre una persona de la bodega; sin membresía resoluble
      // (dada de baja) queda su id con el nombre vacío
      submittedBy: submittedBy ?? {
        membershipId: row.submittedByMembershipId ?? row.id,
        userId: row.submittedByMembershipId ?? row.id,
        fullName: '',
        role: 'OWNER',
      },
      updatedAt: row.updatedAt.toISOString(),
      collectionId: row.collectionId,
    };
  }

  /** Solicitud como la ve la bodega (§5.1). */
  async requestView(
    row: RequestFullRow,
    client: Db = this.prisma,
  ): Promise<TokenizationRequestDto> {
    const [actors, users] = await Promise.all([
      resolveTraceActors(client, [
        row.submittedByMembershipId,
        row.withdrawnByMembershipId,
      ]),
      userNames(client, [
        row.assigneeUserId,
        row.priceSetByUserId,
        row.decisionByUserId,
      ]),
    ]);
    const summary = this.toRequestSummary(row, actors, users);
    const withdrawnBy = actorOf(actors, row.withdrawnByMembershipId);
    return {
      ...summary,
      commercialDraft: parseCommercialDraft(row.commercialDraft),
      price: priceView(row, users),
      wineryNotes: row.wineryNotes,
      changeRequests: row.changes
        .filter((c) => c.type === 'CHANGE_REQUEST')
        .map((c) => ({
          id: c.id,
          at: c.createdAt.toISOString(),
          by: {
            userId: c.actorUserId ?? row.id,
            fullName: c.actorName ?? '',
          },
          message: c.message ?? '',
          fields: c.fields,
          resolvedAt: iso(c.resolvedAt),
        })),
      decision:
        row.decisionOutcome && row.decisionAt
          ? {
              outcome: row.decisionOutcome as 'APPROVED' | 'REJECTED',
              at: row.decisionAt.toISOString(),
              reason: row.decisionReason,
              by: {
                userId: row.decisionByUserId,
                fullName: row.decisionBySystem
                  ? null
                  : row.decisionByUserId
                    ? (users.get(row.decisionByUserId) ?? null)
                    : null,
                system: row.decisionBySystem,
              },
            }
          : null,
      withdrawn:
        row.withdrawnAt && withdrawnBy
          ? {
              at: row.withdrawnAt.toISOString(),
              by: withdrawnBy,
              reason: row.withdrawReason ?? '',
            }
          : null,
      limitsAtSubmission: parseLimits(row.limitsAtSubmission),
      history: row.changes
        .filter((c) => c.type === 'STATUS' && c.status)
        .map((c) => ({
          status: c.status as TokenizationRequestStatus,
          at: c.createdAt.toISOString(),
          by: c.actorSystem
            ? SYSTEM_ACTOR_NAME
            : (c.actorName ?? SYSTEM_ACTOR_NAME),
          note: c.message,
        })),
    };
  }

  /** Solicitud como la ve el back office: con notas, sugerencia y revisión (§5.4). */
  async platformRequestView(
    row: RequestFullRow,
  ): Promise<PlatformTokenizationRequestDto> {
    const [base, priceSuggestion, review] = await Promise.all([
      this.requestView(row),
      this.priceSuggestion(row.wineryId),
      this.review(row),
    ]);
    return {
      ...base,
      internalNotes: row.changes
        .filter((c) => c.type === 'NOTE')
        .map((c) => ({
          id: c.id,
          text: c.message ?? '',
          by: c.actorName ?? SYSTEM_ACTOR_NAME,
          at: c.createdAt.toISOString(),
        })),
      priceSuggestion,
      review: { ...review, priceSuggestion },
    };
  }

  private async review(
    row: RequestFullRow,
  ): Promise<Omit<TokenizationReviewDto, 'priceSuggestion'>> {
    const [lot, quotaLot, publicEventsCount, lastEventRow, identity, others] =
      await Promise.all([
        this.lotView(row.lotId),
        loadQuotaLot(this.prisma, row.lotId),
        this.prisma.lotEvent.count({
          where: { lotId: row.lotId, visibility: 'PUBLIC' },
        }),
        this.prisma.lotEvent.findFirst({
          where: { lotId: row.lotId },
          orderBy: { seq: 'desc' },
        }),
        this.chainPort.wineryIdentityView(this.prisma, row.wineryId),
        this.prisma.collection.findMany({
          where: {
            wineryId: row.wineryId,
            ...(row.collectionId && { id: { not: row.collectionId } }),
            lotId: { not: row.lotId },
          },
          include: COLLECTION_INCLUDE,
          orderBy: { createdAt: 'desc' },
          take: 20,
        }),
      ]);
    const actors = await resolveTraceActors(this.prisma, [
      lastEventRow?.actorMembershipId,
    ]);
    return {
      lot,
      traceability: {
        publicEventsCount,
        lastEvent: lastEventRow
          ? {
              id: lastEventRow.id,
              seq: lastEventRow.seq,
              type: lastEventRow.type as LotEventType,
              occurredAt: lastEventRow.occurredAt.toISOString(),
              recordedAt: lastEventRow.recordedAt.toISOString(),
              lateEntry: isLateEntry(
                lastEventRow.occurredAt,
                lastEventRow.recordedAt,
              ),
              stage: lastEventRow.stage,
              actor: actorOf(actors, lastEventRow.actorMembershipId),
              summary: lastEventRow.summary,
              data: (lastEventRow.data ?? {}) as Record<string, unknown>,
              resource: {
                type: lastEventRow.resourceType,
                id: lastEventRow.resourceId,
              },
              visibility:
                lastEventRow.visibility === 'PUBLIC' ? 'PUBLIC' : 'INTERNAL',
              corrected: lastEventRow.corrected,
            }
          : null,
        locks: lot.locks,
        estimatedReadyDate: lot.estimatedReadyDate,
        complianceIssuesOpen: lot.complianceIssuesOpen,
        denomination: lot.denomination,
        dossierStatus: lot.dossierStatus,
      },
      // La solicitud revisada no cuenta como "pendiente" contra sí misma
      limits: computeLimits({
        ...(quotaLot as NonNullable<typeof quotaLot>),
        pendingQuantity:
          quotaLot?.openRequest && quotaLot.openRequest.id !== row.id
            ? quotaLot.openRequest.quantity
            : 0,
      }),
      chainIdentity: identity,
      otherCollectionsOfWinery: await this.collectionSummaries(others),
    } as Omit<TokenizationReviewDto, 'priceSuggestion'>;
  }

  /** `Lot` en lectura de plataforma (O2 §2.1). */
  private async lotView(lotId: string): Promise<LotView> {
    const lot = await this.prisma.lot.findUniqueOrThrow({
      where: { id: lotId },
      include: COLLECTION_INCLUDE.lot.include,
    });
    const { today, now } = await dbClock(this.prisma);
    const actors = await resolveTraceActors(this.prisma, lotActorIds(lot));
    return toLotView(lot, today, actors, now);
  }

  /**
   * Sugerencia de precio (§5.5): mientras `precio.politica` esté sin definir
   * (hoy), no hay sugerencia y el back office fija un precio manual o lo deja
   * vacío (A-32). La forma de la política se decide más adelante: con un valor
   * definido que no sepamos interpretar tampoco se sugiere nada.
   */
  async priceSuggestion(
    wineryId: string,
    client: Db = this.prisma,
  ): Promise<PriceSuggestionDto> {
    const policy = await this.pricePolicy(wineryId, client);
    const value = policy.value as {
      amountMinor?: unknown;
      currency?: unknown;
      version?: unknown;
    } | null;
    if (
      value &&
      typeof value === 'object' &&
      typeof value.amountMinor === 'number' &&
      Number.isInteger(value.amountMinor) &&
      value.amountMinor >= 1 &&
      value.currency === 'BOB' &&
      policy.source !== 'DEFAULT'
    ) {
      return {
        available: true,
        amountMinor: value.amountMinor,
        currency: 'BOB',
        source: policy.source,
        policyVersion:
          typeof value.version === 'string' ? value.version : 'sin-version',
      };
    }
    return { available: false, reason: 'POLICY_UNDEFINED' };
  }

  /** Valor efectivo de `precio.politica` para la bodega (`null` = sin definir). */
  async pricePolicy(
    wineryId: string,
    client: Db = this.prisma,
  ): Promise<{ value: unknown; source: 'GLOBAL' | 'WINERY' | 'DEFAULT' }> {
    const resolved = await resolveSettingsFromDatabase(client, wineryId);
    const policy = resolved['precio.politica'];
    return {
      value: policy?.value ?? null,
      source: policy?.source ?? 'DEFAULT',
    };
  }

  // ── Colecciones ──────────────────────────────────────────────────────────

  async tokenCounts(
    collections: { id: string; minted: number }[],
    client: Db = this.prisma,
  ): Promise<Map<string, TokenCountsDto>> {
    const map = new Map<string, TokenCountsDto>(
      collections.map((c) => [
        c.id,
        { ...ZERO_TOKEN_COUNTS, minted: c.minted },
      ]),
    );
    if (collections.length === 0) return map;
    const groups = await client.token.groupBy({
      by: ['collectionId', 'status'],
      where: { collectionId: { in: collections.map((c) => c.id) } },
      _count: { _all: true },
    });
    for (const group of groups) {
      const counts = map.get(group.collectionId);
      const key = TOKEN_COUNT_KEYS[group.status];
      if (counts && key) counts[key] = group._count._all;
    }
    return map;
  }

  async collectionSummaries(
    rows: CollectionRow[],
    client: Db = this.prisma,
  ): Promise<CollectionSummaryDto[]> {
    if (rows.length === 0) return [];
    const [counts, users, clock] = await Promise.all([
      this.tokenCounts(rows, client),
      userNames(
        client,
        rows.map((r) => r.priceSetByUserId),
      ),
      dbClock(client),
    ]);
    return Promise.all(
      rows.map((row) =>
        this.toCollectionSummary(
          row,
          counts.get(row.id) as TokenCountsDto,
          users,
          clock,
        ),
      ),
    );
  }

  private async toCollectionSummary(
    row: CollectionRow,
    counts: TokenCountsDto,
    users: Map<string, string>,
    clock: { today: string; now: Date },
  ): Promise<CollectionSummaryDto> {
    const lot = toLotView(row.lot, clock.today, new Map(), clock.now);
    const cover = row.images.find((i) => i.isCover) ?? null;
    return {
      id: row.id,
      slug: row.slug,
      wineryId: row.wineryId,
      winery: {
        slug: row.winery.slug ?? '',
        tradeName: row.winery.commercialName,
      },
      lotId: row.lotId,
      lot: {
        reference: lot.reference,
        lotCode: lot.lotCode,
        name: lot.name,
        productType: lot.productType as LotProductType,
        harvestYear: lot.harvestYear,
        stage: lot.stage,
        estimatedReadyDate: lot.estimatedReadyDate,
      },
      status: row.status as CollectionStatus,
      mintStatus: row.mintStatus as MintStatus,
      saleState: saleState({
        status: row.status,
        redeemable: row.redeemable,
        minted: counts.minted,
        available: counts.available,
      }),
      quota: row.quota,
      pendingMintQuantity: row.pendingMintQuantity,
      counts,
      price: priceView(row, users),
      name: row.name,
      coverImageUrl: cover
        ? await this.imageUrl(row, cover.id, cover.key)
        : null,
      estimatedRedeemDate: ymd(row.estimatedRedeemDate),
      contract: {
        address: row.contract.address ?? '',
        explorerUrl: explorerContractUrl(
          this.chain.explorerBaseUrl,
          row.contract.address,
        ),
      },
      redeemable: row.redeemable,
      redeemableSince: iso(row.redeemableSince),
      publishedAt: iso(row.publishedAt),
      closedAt: iso(row.closedAt),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * URL de una imagen (§5.5): pública (la ruta de esta API) desde que la
   * colección se publica; antes, firmada de corta vida.
   */
  private async imageUrl(
    collection: { publishedAt: Date | null },
    imageId: string,
    key: string,
  ): Promise<string> {
    if (collectionImagesArePublic(collection)) {
      return publicCollectionImageUrl(this.chain.publicApiBaseUrl, imageId);
    }
    try {
      return (await this.storage.getSignedUrl(key)).url;
    } catch {
      return '';
    }
  }

  /** Colección completa (§6.2). */
  async collectionView(
    row: CollectionFullRow,
    client: Db = this.prisma,
  ): Promise<CollectionDto> {
    const [summary] = await this.collectionSummaries([row], client);
    const [txs, images, anchor, approvers, metrics] = await Promise.all([
      this.mintTransactions(
        row.mints.map((m) => m.id),
        client,
      ),
      Promise.all(
        row.images.map(async (image): Promise<CollectionImageDto> => ({
          id: image.id,
          key: image.key,
          sha256: image.sha256,
          url: await this.imageUrl(row, image.id, image.key),
          alt: image.alt,
          isCover: image.isCover,
        })),
      ),
      this.anchorOf(row.lotId, client),
      userNames(
        client,
        row.requests.map((r) => r.decisionByUserId),
      ),
      this.metricsOf(row, summary.counts, client),
    ]);
    return {
      ...summary,
      commercial: {
        name: row.name,
        description: row.description,
        tastingNotes: row.tastingNotes,
        pairing: row.pairing,
        estimatedRedeemDate: ymd(row.estimatedRedeemDate),
        images,
      },
      pricePolicySnapshot: row.pricePolicySnapshot ?? null,
      priceHistory: parsePriceHistory(row.priceHistory),
      mints: row.mints.map((mint) => toMintView(mint, txs, this.explorer())),
      quotaHistory: row.requests.map((request) => ({
        requestId: request.id,
        kind: request.kind as TokenizationRequestKind,
        quantity: request.quantity,
        resultingQuota: request.resultingQuota,
        approvedAt: (request.decisionAt ?? request.updatedAt).toISOString(),
        approvedBy: request.decisionBySystem
          ? SYSTEM_ACTOR_NAME
          : (request.decisionByUserId &&
              approvers.get(request.decisionByUserId)) ||
            SYSTEM_ACTOR_NAME,
      })),
      statusHistory: row.statusHistory.map((entry) => ({
        status: entry.status as CollectionStatus,
        at: entry.at.toISOString(),
        by: entry.actorSystem
          ? SYSTEM_ACTOR_NAME
          : (entry.actorName ?? SYSTEM_ACTOR_NAME),
        reason: entry.reason,
      })),
      anchor,
      // Cierre del lote (§8.4): `null` hasta que se embotella o se descarta
      closure: await closureOfCollection(client, row.id, this.explorer()),
      metrics,
    };
  }

  async loadCollection(
    id: string,
    wineryId: string | undefined,
    client: Db = this.prisma,
  ): Promise<CollectionFullRow | null> {
    return client.collection.findFirst({
      where: { id, ...(wineryId && { wineryId }) },
      include: COLLECTION_FULL_INCLUDE,
    });
  }

  private explorer(): string | null {
    return this.chain.explorerBaseUrl;
  }

  /** Transacciones `MINT_BATCH` de unas emisiones, por emisión y en orden. */
  private async mintTransactions(
    mintIds: string[],
    client: Db,
  ): Promise<Map<string, ChainTransaction[]>> {
    const map = new Map<string, ChainTransaction[]>();
    if (mintIds.length === 0) return map;
    const rows = await client.chainTransaction.findMany({
      where: { subjectType: 'MINT', subjectId: { in: mintIds } },
      orderBy: [{ createdAt: 'asc' }, { intentKey: 'asc' }],
    });
    for (const row of rows) {
      map.set(row.subjectId, [...(map.get(row.subjectId) ?? []), row]);
    }
    return map;
  }

  async mintView(mintId: string, client: Db = this.prisma): Promise<MintDto> {
    const mint = await client.mint.findUniqueOrThrow({ where: { id: mintId } });
    const txs = await this.mintTransactions([mintId], client);
    return toMintView(mint, txs, this.explorer());
  }

  /** Anclaje del expediente del lote (§7.1), si el paso 3.5 ya lo registró. */
  private async anchorOf(
    lotId: string,
    client: Db,
  ): Promise<DossierAnchorDto | null> {
    const anchor = await client.dossierAnchor.findUnique({
      where: { lotId },
      include: { transaction: true },
    });
    return toDossierAnchor(anchor, this.explorer());
  }

  // ── Métricas (§8.5) ──────────────────────────────────────────────────────

  async metrics(row: CollectionFullRow): Promise<CollectionMetricsDto> {
    const counts = await this.tokenCounts([row]);
    return this.metricsOf(row, counts.get(row.id) as TokenCountsDto);
  }

  private async metricsOf(
    row: CollectionFullRow,
    counts: TokenCountsDto,
    client: Db = this.prisma,
  ): Promise<CollectionMetricsDto> {
    const where = await this.transactionsWhere(row, client);
    const [fees, firstSale] = await Promise.all([
      client.chainTransaction.aggregate({
        where,
        _sum: { feeChargedStroops: true },
        _count: { _all: true },
      }),
      client.token.aggregate({
        where: { collectionId: row.id, soldAt: { not: null } },
        _min: { soldAt: true },
      }),
    ]);
    const confirmed = row.mints
      .map((m) => m.confirmedAt)
      .filter((d): d is Date => d !== null)
      .sort((a, b) => a.getTime() - b.getTime());
    const estimate = row.lot.estimatedBottles;
    return {
      counts,
      quota: row.quota,
      authorizedVsEstimatePercent:
        estimate && estimate > 0
          ? Math.round((row.quota / estimate) * 10_000) / 100
          : null,
      firstMintedAt: iso(confirmed[0]),
      publishedAt: iso(row.publishedAt),
      firstSaleAt: iso(firstSale._min.soldAt),
      chainCosts: {
        feesChargedXlm: stroopsToXlm(fees._sum.feeChargedStroops ?? 0n),
        transactions: fees._count._all,
      },
      byMint: row.mints.map((mint) => ({
        sequence: mint.sequence,
        quantity: mint.quantity,
        confirmedAt: iso(mint.confirmedAt),
      })),
    };
  }

  /** Transacciones de la colección (§6.4): sus emisiones y las quemas de sus NFT. */
  async transactionsWhere(
    row: { id: string; mints: { id: string }[] },
    client: Db = this.prisma,
  ): Promise<Prisma.ChainTransactionWhereInput> {
    const burns = await client.token.findMany({
      where: { collectionId: row.id, burnTxId: { not: null } },
      distinct: ['burnTxId'],
      select: { burnTxId: true },
    });
    const burnTxIds = burns
      .map((b) => b.burnTxId)
      .filter((id): id is string => id !== null);
    return {
      OR: [
        { subjectType: 'MINT', subjectId: { in: row.mints.map((m) => m.id) } },
        ...(burnTxIds.length > 0 ? [{ id: { in: burnTxIds } }] : []),
      ],
    };
  }

  transactionRef(row: ChainTransaction): ChainTxRefDto {
    return toChainTxRef(row, this.explorer());
  }

  // ── NFT (§6.3) ───────────────────────────────────────────────────────────

  async tokenViews(
    collection: CollectionRow,
    tokens: Prisma.TokenGetPayload<object>[],
  ): Promise<TokenDto[]> {
    const txIds = [
      ...new Set(
        tokens
          .flatMap((t) => [t.mintTxId, t.burnTxId])
          .filter((id): id is string => !!id),
      ),
    ];
    const [txRows, mintTxs] = await Promise.all([
      txIds.length > 0
        ? this.prisma.chainTransaction.findMany({
            where: { id: { in: txIds } },
          })
        : Promise.resolve([]),
      this.mintTransactions(
        [...new Set(tokens.map((t) => t.mintId))],
        this.prisma,
      ),
    ]);
    const byId = new Map(txRows.map((t) => [t.id, t]));
    const baseUri = collection.contract.baseUri;
    return tokens.map((token) => {
      const mintTx =
        (token.mintTxId && byId.get(token.mintTxId)) ||
        mintTxs.get(token.mintId)?.[0] ||
        null;
      const burnTx = token.burnTxId ? (byId.get(token.burnTxId) ?? null) : null;
      return {
        id: token.id,
        collectionId: token.collectionId,
        wineryId: token.wineryId,
        lotId: token.lotId,
        contractAddress: collection.contract.address ?? '',
        tokenId: token.tokenId,
        bottleNumber: token.bottleNumber,
        status: token.status as TokenStatus,
        owner: {
          kind: token.ownerKind as TokenOwnerKind,
          address: token.ownerAddress,
        },
        mintId: token.mintId,
        mintTx: mintTx
          ? toChainTxRef(mintTx, this.explorer())
          : // Un NFT existe porque su emisión se confirmó: sin la fila de la
            // transacción (datos sembrados) se muestra esa confirmación
            {
              id: token.mintId,
              kind: 'MINT_BATCH',
              status: 'CONFIRMED',
              network: this.chain.network,
              txHash: null,
              explorerUrl: null,
              ledger: null,
              confirmedAt: token.createdAt.toISOString(),
              attempts: 0,
              lastError: null,
              createdAt: token.createdAt.toISOString(),
              updatedAt: token.updatedAt.toISOString(),
            },
        soldAt: iso(token.soldAt),
        redeemableAt: iso(token.redeemableAt),
        redeemWindowEndsAt: iso(token.redeemWindowEndsAt),
        burnedAt: iso(token.burnedAt),
        burnTx: burnTx ? toChainTxRef(burnTx, this.explorer()) : null,
        burnReason: token.burnReason as TokenBurnReason | null,
        onchain: {
          owner: token.onchainOwner,
          burned: token.onchainBurned,
          checkedAt: iso(token.onchainCheckedAt),
        },
        metadataUrl: `${baseUri}${token.tokenId}`,
      };
    });
  }
}

/** Precio guardado en una solicitud o una colección (`null` si no tiene). */
export function priceView(
  row: {
    priceAmountMinor: number | null;
    priceCurrency: string | null;
    priceSource: string | null;
    priceSetAt: Date | null;
    priceSetByUserId: string | null;
  },
  users: Map<string, string>,
): CollectionPriceDto | null {
  if (row.priceAmountMinor === null || !row.priceSetAt) return null;
  return {
    amountMinor: row.priceAmountMinor,
    currency: (row.priceCurrency ?? 'BOB') as PriceCurrency,
    source: (row.priceSource ?? 'MANUAL') as PriceSource,
    setAt: row.priceSetAt.toISOString(),
    setBy: {
      userId: row.priceSetByUserId ?? '',
      fullName: row.priceSetByUserId
        ? (users.get(row.priceSetByUserId) ?? '')
        : '',
    },
  };
}

function parsePriceHistory(raw: unknown): CollectionPriceDto[] {
  return Array.isArray(raw) ? (raw as CollectionPriceDto[]) : [];
}

function parseLimits(raw: unknown): TokenizationLimits {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Partial<
    Record<keyof TokenizationLimits, unknown>
  >;
  const int = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : 0;
  const nullable = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  return {
    basis: value.basis === 'BOTTLES' ? 'BOTTLES' : 'ESTIMATE',
    estimatedBottles: nullable(value.estimatedBottles),
    bottles: nullable(value.bottles),
    authorizedQuota: int(value.authorizedQuota),
    pendingQuantity: int(value.pendingQuantity),
    maxQuantity: int(value.maxQuantity),
  };
}

function toMintView(
  mint: Prisma.MintGetPayload<object>,
  txs: Map<string, ChainTransaction[]>,
  explorerBaseUrl: string | null,
): MintDto {
  return {
    id: mint.id,
    collectionId: mint.collectionId,
    requestId: mint.requestId,
    sequence: mint.sequence,
    quantity: mint.quantity,
    status: mint.status as MintStatus,
    lotArg: mint.lotArg,
    ranges: Array.isArray(mint.ranges)
      ? (mint.ranges as unknown as MintRangeDto[])
      : [],
    transactions: (txs.get(mint.id) ?? []).map((tx) =>
      toChainTxRef(tx, explorerBaseUrl),
    ),
    createdAt: mint.createdAt.toISOString(),
    confirmedAt: mint.confirmedAt ? mint.confirmedAt.toISOString() : null,
  };
}
