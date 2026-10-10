import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditAction } from '@shared/audit/audit.actions';
import { AUDIT_TX_OPTIONS, AuditService } from '@shared/audit/audit.service';
import { toPage, toPrismaPage } from '@shared/dto/pagination-query.dto';
import { AppException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';
import { ValidationException } from '@shared/exceptions/validation.exception';
import type {
  ErrorDetail,
  Paginated,
} from '@shared/interfaces/api-response.interface';
import { OutboxService } from '@shared/outbox/outbox.service';
import { PrismaService } from '@shared/prisma/prisma.service';
import { QUEUE_CHAIN } from '@shared/queue/queue.constants';
import {
  lotNotFound,
  ruleError,
  stateError,
  TraceRuleException,
} from '@modules/lots/domain/trace-errors';
import { toDbDate } from '@modules/lots/domain/dates';
import type { LotStage } from '@modules/lots/domain/lot-stage';
import { appendLotEvent, formatQuantity } from '@modules/lots/lot-events';
import { toLotView } from '@modules/lots/lot-view';
import { actorMembership, dbClock, lockLotRow } from '@modules/lots/trace-db';
import { AppLinks } from '@modules/mail/app-links';
import { PLATFORM_ORGANIZATION_ID } from '@modules/organizations/organization.constants';
import { MailService } from '@modules/mail/mail.service';
import { resolveSettingsFromDatabase } from '@modules/settings/settings.resolve';
import {
  CollectionImagesService,
  type ImageDigest,
} from './collection-images.service';
import {
  changedCommercialFields,
  collectionSlug,
  commercialMissing,
  duplicatedImageKeys,
  EMPTY_COMMERCIAL_DRAFT,
  mergeCommercial,
  parseCommercialDraft,
  priceViolations,
  type CommercialDraft,
  type CommercialInput,
} from './domain/commercial';
import {
  computeLimits,
  lotBlockers,
  mintChunks,
  quantityViolations,
  requestKind,
  submissionBlockers,
} from './domain/quota';
import { isOpenRequest, nextRequestStatus } from './domain/state-machines';
import type { CollectionPriceInputDto } from './dto/commercial.dto';
import type {
  AddTokenizationNoteDto,
  ApproveTokenizationRequestDto,
  CreateTokenizationRequestDto,
  LotTokenizationStatusDto,
  PlatformTokenizationRequestDto,
  PlatformTokenizationRequestsQueryDto,
  RequestTokenizationChangesDto,
  ResubmitTokenizationRequestDto,
  ReviewTokenizationRequestDto,
  TokenizationApprovalDto,
  TokenizationReasonDto,
  TokenizationRequestDto,
  TokenizationRequestSummaryDto,
  TokenizationRequestsQueryDto,
  UpdateTokenizationRequestDto,
} from './dto/tokenization-requests.dto';
import {
  mintIntentKey,
  TOKENIZATION_CHAIN_PORT,
  type MintIntentChunk,
  type TokenizationChainPort,
  type WineryChainReadiness,
} from './ports/tokenization-chain.port';
import {
  COLLECTION_INCLUDE,
  loadQuotaLot,
  REQUEST_FULL_INCLUDE,
  REQUEST_INCLUDE,
  wineryOwners,
  type QuotaLotRow,
  type RequestFullRow,
} from './tokenization-data';
import {
  recordStatusChange,
  rejectRequestInTx,
  type StaffActor,
} from './request-writes';
import { TokenizationReader } from './tokenization-reader.service';
import {
  OPEN_TOKENIZATION_REQUEST_STATUSES,
  type TokenizationRequestStatus,
} from './tokenization.constants';
import {
  TOKENIZATION_REQUEST_AGGREGATE,
  TOKENIZATION_REQUEST_APPROVED,
  TOKENIZATION_REQUEST_CHANGES_REQUESTED,
  TOKENIZATION_REQUEST_SUBMITTED,
  type TokenizationRequestApprovedPayload,
  type TokenizationRequestEventPayload,
} from './tokenization.events';

type Tx = Prisma.TransactionClient;
type Clock = { now: Date; today: string };

/** Persona de la bodega que actúa. */
interface WineryActor {
  userId: string;
  membershipId: string | null;
  fullName: string;
}

const APPROVAL_SETTING = 'tokenizacion.requiereAprobacion';

function requestNotFound(): TraceRuleException {
  return new TraceRuleException(
    404,
    ErrorCode.TOK_REQUEST_NOT_FOUND,
    'Solicitud de tokenización no encontrada',
  );
}

/** Lanza la primera violación con todas en `details`: etapa → 409; el resto → 422. */
function throwBlockers(blockers: ErrorDetail[]): void {
  if (blockers.length === 0) return;
  const first = blockers[0];
  const status =
    first.code === ErrorCode.TOK_LOT_NOT_TOKENIZABLE ||
    first.code === ErrorCode.TOK_REQUEST_ALREADY_OPEN
      ? 409
      : 422;
  throw new TraceRuleException(
    status,
    first.code ?? ErrorCode.UNPROCESSABLE_ENTITY,
    first.message,
    blockers,
  );
}

function assertImagesOnce(commercial: CommercialInput | undefined): void {
  if (!commercial) return;
  const repeated = duplicatedImageKeys(commercial);
  if (repeated.length > 0) {
    throw ValidationException.forField(
      'commercial.imageKeys',
      'Cada imagen puede aparecer una sola vez',
    );
  }
}

/** Lo decidido al comprobar una aprobación, antes de escribir nada. */
interface ApprovalPlan {
  request: RequestFullRow;
  lot: QuotaLotRow;
  identity: WineryChainReadiness & {
    accountAddress: string;
    contract: NonNullable<WineryChainReadiness['contract']>;
  };
  increase: boolean;
  draft: CommercialDraft;
  slug: string | null;
  digests: Map<string, ImageDigest>;
  /** `undefined`: el precio de la solicitud no cambia. */
  price: CollectionPriceInputDto | null | undefined;
  publishOnMint: boolean;
}

/**
 * Solicitudes de tokenización (contrato O3 §5; TOK-01…05, TOK-08; A-03). La
 * bodega autoriza la cantidad; operaciones revisa, completa los datos
 * comerciales y el precio, y aprueba, pide cambios o rechaza. Aprobar crea la
 * colección (o amplía su cuota), la emisión y el evento
 * `tokenization.request_approved` en una sola transacción; nada sale a la red
 * desde aquí.
 *
 * Toda escritura bloquea primero la fila del lote: las acciones sobre un
 * mismo lote van en serie (una sola solicitud abierta, una sola aprobación).
 */
@Injectable()
export class TokenizationRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly mail: MailService,
    private readonly links: AppLinks,
    private readonly reader: TokenizationReader,
    private readonly images: CollectionImagesService,
    @Inject(TOKENIZATION_CHAIN_PORT)
    private readonly chainPort: TokenizationChainPort,
  ) {}

  // ── Lecturas ─────────────────────────────────────────────────────────────

  /** `GET /v1/lots/{id}/tokenization` (§5.3). */
  async lotStatus(
    wineryId: string | undefined,
    lotId: string,
  ): Promise<LotTokenizationStatusDto> {
    const lot = await loadQuotaLot(this.prisma, lotId, wineryId);
    if (!lot) throw lotNotFound();
    const [settings, identity, requestRows, collectionRow] = await Promise.all([
      resolveSettingsFromDatabase(this.prisma, lot.wineryId),
      this.chainPort.wineryIdentity(this.prisma, lot.wineryId),
      this.prisma.tokenizationRequest.findMany({
        where: { lotId },
        include: REQUEST_INCLUDE,
        orderBy: [{ submittedAt: 'desc' }, { id: 'asc' }],
      }),
      lot.collection
        ? this.prisma.collection.findUnique({
            where: { id: lot.collection.id },
            include: COLLECTION_INCLUDE,
          })
        : Promise.resolve(null),
    ]);
    const requests = await this.reader.requestSummaries(requestRows);
    const blockers = submissionBlockers(lot, lot.openRequest?.id ?? null);
    const [collection] = collectionRow
      ? await this.reader.collectionSummaries([collectionRow])
      : [null];
    return {
      lotId,
      tokenizable: blockers.length === 0,
      blockers,
      limits: computeLimits(lot),
      approvalRequired: settings[APPROVAL_SETTING]?.value !== false,
      chainIdentity: { status: identity.status },
      openRequest: requests.find((r) => isOpenRequest(r.status)) ?? null,
      collection,
      requests,
    };
  }

  /** `GET /v1/tokenization-requests` (ERP). */
  async list(
    wineryId: string | undefined,
    query: TokenizationRequestsQueryDto,
  ): Promise<Paginated<TokenizationRequestSummaryDto>> {
    const where: Prisma.TokenizationRequestWhereInput = {
      ...(wineryId && { wineryId }),
      ...(query.status && { status: query.status }),
      ...(query.lotId && { lotId: query.lotId }),
      ...(query.kind && { kind: query.kind }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.tokenizationRequest.findMany({
        where,
        include: REQUEST_INCLUDE,
        orderBy: [{ submittedAt: 'desc' }, { id: 'asc' }],
        ...toPrismaPage(query),
      }),
      this.prisma.tokenizationRequest.count({ where }),
    ]);
    return toPage(await this.reader.requestSummaries(rows), total, query);
  }

  /** `GET /v1/tokenization-requests/{id}` (ERP): sin notas internas ni sugerencia. */
  async get(
    wineryId: string | undefined,
    id: string,
  ): Promise<TokenizationRequestDto> {
    const row = await this.prisma.tokenizationRequest.findFirst({
      where: { id, ...(wineryId && { wineryId }) },
      include: REQUEST_FULL_INCLUDE,
    });
    if (!row) throw requestNotFound();
    const view = await this.reader.requestView(row);
    // La bodega ve el precio en solo lectura una vez aprobada (§5.1)
    return { ...view, price: row.status === 'APPROVED' ? view.price : null };
  }

  /** `GET /v1/platform/tokenization-requests` (bandeja). */
  async platformList(
    query: PlatformTokenizationRequestsQueryDto,
  ): Promise<Paginated<TokenizationRequestSummaryDto>> {
    const where: Prisma.TokenizationRequestWhereInput = {
      status: query.status ?? { in: [...OPEN_TOKENIZATION_REQUEST_STATUSES] },
      ...(query.kind && { kind: query.kind }),
      ...(query.wineryId && { wineryId: query.wineryId }),
      ...(query.assigneeId && { assigneeUserId: query.assigneeId }),
    };
    if (query.q) {
      const contains = { contains: query.q, mode: 'insensitive' as const };
      where.OR = [
        { winery: { commercialName: contains } },
        { winery: { legalName: contains } },
        { lot: { name: contains } },
        { lot: { reference: contains } },
        { lot: { lotCode: contains } },
        { collection: { name: contains } },
      ];
    }
    const [rows, total] = await Promise.all([
      this.prisma.tokenizationRequest.findMany({
        where,
        include: REQUEST_INCLUDE,
        orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
        ...toPrismaPage(query),
      }),
      this.prisma.tokenizationRequest.count({ where }),
    ]);
    return toPage(await this.reader.requestSummaries(rows), total, query);
  }

  /** `GET /v1/platform/tokenization-requests/{id}`: con notas, sugerencia y revisión. */
  async platformGet(id: string): Promise<PlatformTokenizationRequestDto> {
    const row = await this.prisma.tokenizationRequest.findUnique({
      where: { id },
      include: REQUEST_FULL_INCLUDE,
    });
    if (!row) throw requestNotFound();
    return this.reader.platformRequestView(row);
  }

  // ── ERP: la bodega ───────────────────────────────────────────────────────

  /** `POST /v1/lots/{id}/tokenization-requests` (§5.2, §5.3; solo `OWNER`). */
  async create(
    wineryId: string,
    userId: string,
    lotId: string,
    dto: CreateTokenizationRequestDto,
  ): Promise<TokenizationRequestDto> {
    assertImagesOnce(dto.commercial);
    const digests = await this.images.inspect(
      wineryId,
      dto.commercial?.imageKeys ?? [],
    );
    const id = await this.write(async (tx) => {
      if (!(await lockLotRow(tx, lotId))) throw lotNotFound();
      const lot = await loadQuotaLot(tx, lotId, wineryId);
      if (!lot) throw lotNotFound();
      const clock = await dbClock(tx);
      const actor = await this.wineryActor(tx, userId, wineryId);
      throwBlockers(lotBlockers(lot));
      if (lot.openRequest) {
        throwBlockers(submissionBlockers(lot, lot.openRequest.id));
      }
      throwBlockers(quantityViolations(lot, dto.quantity));

      const draft = mergeCommercial(EMPTY_COMMERCIAL_DRAFT, dto.commercial);
      const requiresApproval = await this.requiresApproval(tx, wineryId);
      const kind = requestKind(lot.collection !== null);
      const request = await tx.tokenizationRequest.create({
        data: {
          wineryId,
          lotId,
          kind,
          status: 'SUBMITTED',
          quantity: dto.quantity,
          resultingQuota: lot.authorizedQuota + dto.quantity,
          requiresApproval,
          commercialDraft: draft as unknown as Prisma.InputJsonObject,
          wineryNotes: dto.notes?.trim() || null,
          limitsAtSubmission: computeLimits(
            lot,
          ) as unknown as Prisma.InputJsonObject,
          collectionId: lot.collection?.id ?? null,
          submittedAt: clock.now,
          submittedByMembershipId: actor.membershipId,
        },
      });
      await this.statusChange(tx, request.id, 'SUBMITTED', {
        membershipId: actor.membershipId,
        userId: actor.userId,
        name: actor.fullName,
        note: dto.notes?.trim() || null,
        at: clock.now,
      });
      await appendLotEvent(tx, lotId, {
        type: 'TOKENIZATION_AUTHORIZED',
        occurredAt: clock.now,
        stage: lot.stage as LotStage,
        actorMembershipId: actor.membershipId,
        summary:
          kind === 'INITIAL'
            ? `Tokenización autorizada por la bodega: ${formatQuantity(dto.quantity)} botellas`
            : `Ampliación de cuota autorizada por la bodega: ${formatQuantity(dto.quantity)} botellas más (${formatQuantity(lot.authorizedQuota + dto.quantity)} en total)`,
        data: {
          phase: 'REQUESTED',
          requestId: request.id,
          kind,
          quantity: dto.quantity,
          resultingQuota: lot.authorizedQuota + dto.quantity,
        },
        resource: { type: 'tokenization_request', id: request.id },
      });
      await this.audit.record(tx, {
        action: AuditAction.TOKENIZATION_REQUESTED,
        resource: { type: 'tokenization_request', id: request.id },
        organizationId: wineryId,
        after: {
          lotId,
          lotReference: lot.reference,
          kind,
          quantity: dto.quantity,
          resultingQuota: lot.authorizedQuota + dto.quantity,
          requiresApproval,
        },
      });
      await this.submitted(tx, request.id, lot, dto.quantity, kind, {
        requiresApproval,
        resubmitted: false,
        digests,
        clock,
      });
      return request.id;
    });
    return this.get(wineryId, id);
  }

  /** `PATCH /v1/tokenization-requests/{id}` (bodega): en `SUBMITTED` o `CHANGES_REQUESTED`. */
  async update(
    wineryId: string,
    userId: string,
    id: string,
    dto: UpdateTokenizationRequestDto,
  ): Promise<TokenizationRequestDto> {
    assertImagesOnce(dto.commercial);
    await this.images.inspect(wineryId, dto.commercial?.imageKeys ?? []);
    await this.onRequest(id, wineryId, async (tx, request, lot) => {
      nextRequestStatus(request.status as TokenizationRequestStatus, 'EDIT');
      const actor = await this.wineryActor(tx, userId, wineryId);
      const quantity = dto.quantity ?? request.quantity;
      throwBlockers(lotBlockers(lot));
      throwBlockers(quantityViolations(lot, quantity));
      const before = parseCommercialDraft(request.commercialDraft);
      const draft = mergeCommercial(before, dto.commercial);
      const fields = [
        ...(quantity !== request.quantity ? ['quantity'] : []),
        ...changedCommercialFields(before, draft).map((f) => `commercial.${f}`),
        ...(dto.notes !== undefined &&
        (dto.notes.trim() || null) !== request.wineryNotes
          ? ['notes']
          : []),
      ];
      await tx.tokenizationRequest.update({
        where: { id },
        data: {
          quantity,
          resultingQuota: lot.authorizedQuota + quantity,
          commercialDraft: draft as unknown as Prisma.InputJsonObject,
          ...(dto.notes !== undefined && {
            wineryNotes: dto.notes.trim() || null,
          }),
        },
      });
      await tx.tokenizationRequestChange.create({
        data: {
          requestId: id,
          type: 'EDIT',
          fields,
          actorUserId: actor.userId,
          actorMembershipId: actor.membershipId,
          actorName: actor.fullName,
        },
      });
      await this.audit.record(tx, {
        action: AuditAction.TOKENIZATION_REQUEST_UPDATED,
        resource: { type: 'tokenization_request', id },
        organizationId: wineryId,
        before: { quantity: request.quantity },
        after: { quantity, fields },
      });
    });
    return this.get(wineryId, id);
  }

  /** `POST …/resubmit`: `CHANGES_REQUESTED → SUBMITTED` (§5.3). */
  async resubmit(
    wineryId: string,
    userId: string,
    id: string,
    dto: ResubmitTokenizationRequestDto,
  ): Promise<TokenizationRequestDto> {
    await this.onRequest(id, wineryId, async (tx, request, lot, clock) => {
      const to = nextRequestStatus(
        request.status as TokenizationRequestStatus,
        'RESUBMIT',
      );
      const actor = await this.wineryActor(tx, userId, wineryId);
      throwBlockers(lotBlockers(lot));
      throwBlockers(quantityViolations(lot, request.quantity));
      const requiresApproval = await this.requiresApproval(tx, wineryId);
      await tx.tokenizationRequestChange.updateMany({
        where: { requestId: id, type: 'CHANGE_REQUEST', resolvedAt: null },
        data: { resolvedAt: clock.now },
      });
      await tx.tokenizationRequest.update({
        where: { id },
        data: {
          status: to,
          requiresApproval,
          resultingQuota: lot.authorizedQuota + request.quantity,
          limitsAtSubmission: computeLimits({
            ...lot,
            pendingQuantity: 0,
          }) as unknown as Prisma.InputJsonObject,
        },
      });
      await this.statusChange(tx, id, to, {
        membershipId: actor.membershipId,
        userId: actor.userId,
        name: actor.fullName,
        note: dto.message?.trim() || null,
        at: clock.now,
      });
      await this.audit.record(tx, {
        action: AuditAction.TOKENIZATION_RESUBMITTED,
        resource: { type: 'tokenization_request', id },
        organizationId: wineryId,
        before: { status: request.status },
        after: { status: to, message: dto.message?.trim() || null },
      });
      await this.submitted(tx, id, lot, request.quantity, request.kind, {
        requiresApproval,
        resubmitted: true,
        digests: new Map(),
        clock,
      });
    });
    return this.get(wineryId, id);
  }

  /** `POST …/withdraw`: `→ WITHDRAWN` desde cualquier estado abierto. */
  async withdraw(
    wineryId: string,
    userId: string,
    id: string,
    dto: TokenizationReasonDto,
  ): Promise<TokenizationRequestDto> {
    await this.onRequest(id, wineryId, async (tx, request, _lot, clock) => {
      const to = nextRequestStatus(
        request.status as TokenizationRequestStatus,
        'WITHDRAW',
      );
      const actor = await this.wineryActor(tx, userId, wineryId);
      const reason = dto.reason.trim();
      await tx.tokenizationRequest.update({
        where: { id },
        data: {
          status: to,
          withdrawnAt: clock.now,
          withdrawnByMembershipId: actor.membershipId,
          withdrawReason: reason,
        },
      });
      await this.statusChange(tx, id, to, {
        membershipId: actor.membershipId,
        userId: actor.userId,
        name: actor.fullName,
        note: reason,
        at: clock.now,
      });
      await this.audit.record(tx, {
        action: AuditAction.TOKENIZATION_WITHDRAWN,
        resource: { type: 'tokenization_request', id },
        organizationId: wineryId,
        before: { status: request.status },
        after: { status: to },
        reason,
      });
    });
    return this.get(wineryId, id);
  }

  // ── Back office: la bandeja ──────────────────────────────────────────────

  /** `POST …/take`: `SUBMITTED → IN_REVIEW`, asignada a quien la toma. */
  async take(
    id: string,
    userId: string,
  ): Promise<PlatformTokenizationRequestDto> {
    await this.onRequest(id, undefined, async (tx, request, _lot, clock) => {
      const to = nextRequestStatus(
        request.status as TokenizationRequestStatus,
        'TAKE',
      );
      const actor = await this.staffActor(tx, userId);
      await tx.tokenizationRequest.update({
        where: { id },
        data: { status: to, assigneeUserId: actor.userId },
      });
      await this.statusChange(tx, id, to, {
        userId: actor.userId,
        name: actor.fullName,
        at: clock.now,
      });
      await this.audit.record(tx, {
        action: AuditAction.TOKENIZATION_TAKEN,
        resource: { type: 'tokenization_request', id },
        organizationId: request.wineryId,
        before: {
          status: request.status,
          assigneeUserId: request.assigneeUserId,
        },
        after: { status: to, assigneeUserId: actor.userId },
      });
    });
    return this.platformGet(id);
  }

  /** `POST …/notes`: nota interna (no la ve la bodega). */
  async addNote(
    id: string,
    userId: string,
    dto: AddTokenizationNoteDto,
  ): Promise<PlatformTokenizationRequestDto> {
    await this.onRequest(id, undefined, async (tx, request) => {
      const actor = await this.staffActor(tx, userId);
      const note = await tx.tokenizationRequestChange.create({
        data: {
          requestId: id,
          type: 'NOTE',
          message: dto.text.trim(),
          actorUserId: actor.userId,
          actorName: actor.fullName,
        },
      });
      await this.audit.record(tx, {
        action: AuditAction.TOKENIZATION_NOTE_ADDED,
        resource: { type: 'tokenization_request', id },
        organizationId: request.wineryId,
        after: { noteId: note.id },
      });
    });
    return this.platformGet(id);
  }

  /** `PATCH /v1/platform/tokenization-requests/{id}`: datos comerciales y precio, en `IN_REVIEW`. */
  async review(
    id: string,
    userId: string,
    dto: ReviewTokenizationRequestDto,
  ): Promise<PlatformTokenizationRequestDto> {
    assertImagesOnce(dto.commercial);
    const wineryId = await this.wineryOf(id);
    await this.images.inspect(wineryId, dto.commercial?.imageKeys ?? []);
    await this.onRequest(id, undefined, async (tx, request, lot, clock) => {
      nextRequestStatus(request.status as TokenizationRequestStatus, 'REVIEW');
      const actor = await this.staffActor(tx, userId);
      const before = parseCommercialDraft(request.commercialDraft);
      const draft = mergeCommercial(before, dto.commercial);
      throwBlockers(priceViolations(dto.price));
      if (
        !lot.collection &&
        draft.name &&
        draft.name !== before.name &&
        (await this.slugTaken(tx, request.wineryId, collectionSlug(draft.name)))
      ) {
        throw slugTaken(collectionSlug(draft.name));
      }
      const fields = [
        ...changedCommercialFields(before, draft).map((f) => `commercial.${f}`),
        ...(dto.price !== undefined ? ['price'] : []),
      ];
      await tx.tokenizationRequest.update({
        where: { id },
        data: {
          commercialDraft: draft as unknown as Prisma.InputJsonObject,
          ...(dto.price !== undefined &&
            (await this.priceData(
              tx,
              request.wineryId,
              dto.price,
              actor,
              clock,
            ))),
        },
      });
      await tx.tokenizationRequestChange.create({
        data: {
          requestId: id,
          type: 'EDIT',
          fields,
          message: dto.reason?.trim() || null,
          actorUserId: actor.userId,
          actorName: actor.fullName,
        },
      });
      await this.audit.record(tx, {
        action: AuditAction.TOKENIZATION_REQUEST_UPDATED,
        resource: { type: 'tokenization_request', id },
        organizationId: request.wineryId,
        before: { priceAmountMinor: request.priceAmountMinor },
        after: {
          fields,
          ...(dto.price !== undefined && {
            priceAmountMinor: dto.price?.amountMinor ?? null,
          }),
        },
        reason: dto.reason?.trim() || null,
      });
    });
    return this.platformGet(id);
  }

  /** `POST …/request-changes`: `IN_REVIEW → CHANGES_REQUESTED`; correo al dueño. */
  async requestChanges(
    id: string,
    userId: string,
    dto: RequestTokenizationChangesDto,
  ): Promise<PlatformTokenizationRequestDto> {
    await this.onRequest(id, undefined, async (tx, request, lot, clock) => {
      const to = nextRequestStatus(
        request.status as TokenizationRequestStatus,
        'REQUEST_CHANGES',
      );
      const actor = await this.staffActor(tx, userId);
      const message = dto.message.trim();
      await tx.tokenizationRequest.update({
        where: { id },
        data: { status: to },
      });
      await tx.tokenizationRequestChange.create({
        data: {
          requestId: id,
          type: 'CHANGE_REQUEST',
          message,
          fields: dto.fields ?? [],
          actorUserId: actor.userId,
          actorName: actor.fullName,
          createdAt: clock.now,
        },
      });
      await this.statusChange(tx, id, to, {
        userId: actor.userId,
        name: actor.fullName,
        note: message,
        at: clock.now,
      });
      await this.audit.record(tx, {
        action: AuditAction.TOKENIZATION_CHANGES_REQUESTED,
        resource: { type: 'tokenization_request', id },
        organizationId: request.wineryId,
        before: { status: request.status },
        after: { status: to, message, fields: dto.fields ?? [] },
      });
      await this.outbox.add<TokenizationRequestEventPayload>(tx, {
        type: TOKENIZATION_REQUEST_CHANGES_REQUESTED,
        aggregateType: TOKENIZATION_REQUEST_AGGREGATE,
        aggregateId: id,
        payload: this.eventPayload(request, request.quantity),
      });
      for (const owner of await wineryOwners(tx, request.wineryId)) {
        await this.mail.enqueue(tx, {
          template: 'tokenizacion-cambios',
          to: owner.email,
          organizationId: request.wineryId,
          variables: {
            nombre: owner.fullName,
            lote: lot.name,
            mensaje: message,
            enlace: this.links.erpHome(),
          },
        });
      }
    });
    return this.platformGet(id);
  }

  /** `POST …/reject`: `→ REJECTED` con motivo; correo al dueño. */
  async reject(
    id: string,
    userId: string,
    dto: TokenizationReasonDto,
  ): Promise<PlatformTokenizationRequestDto> {
    await this.onRequest(id, undefined, async (tx, request, lot, clock) => {
      const actor = await this.staffActor(tx, userId);
      await rejectRequestInTx(
        tx,
        { audit: this.audit, mail: this.mail, outbox: this.outbox },
        { ...request, lotName: lot.name },
        { reason: dto.reason.trim(), actor, at: clock.now },
      );
    });
    return this.platformGet(id);
  }

  /**
   * `POST …/approve` (§5.4, §6.1): `IN_REVIEW → APPROVED`. En una sola
   * transacción: revalida la cuota con los datos de ahora, crea la colección
   * `MINTING` (o amplía la cuota), el `Mint` `PENDING` con sus trozos de hasta
   * 32 000 y el evento `tokenization.request_approved`. Dos aprobaciones en
   * paralelo: la segunda encuentra la solicitud ya `APPROVED` → 409.
   */
  async approve(
    id: string,
    userId: string,
    dto: ApproveTokenizationRequestDto,
  ): Promise<TokenizationApprovalDto> {
    assertImagesOnce(dto.commercial);
    // Las huellas de las imágenes se calculan fuera de la transacción
    const current = await this.prisma.tokenizationRequest.findUnique({
      where: { id },
      select: { wineryId: true, commercialDraft: true, collectionId: true },
    });
    if (!current) throw requestNotFound();
    const expected = mergeCommercial(
      parseCommercialDraft(current.commercialDraft),
      dto.commercial,
    );
    const digests = current.collectionId
      ? new Map<string, ImageDigest>()
      : await this.images.inspect(current.wineryId, expected.imageKeys);

    let mintId = '';
    let collectionId = '';
    await this.onRequest(id, undefined, async (tx, request, _lot, clock) => {
      nextRequestStatus(request.status as TokenizationRequestStatus, 'APPROVE');
      const actor = await this.staffActor(tx, userId);
      const plan = await this.planApproval(tx, request, {
        commercial: dto.commercial,
        price: dto.price,
        publishOnMint: dto.publishOnMint ?? false,
        digests,
      });
      const result = await this.applyApproval(tx, plan, {
        actor,
        reason: dto.reason?.trim() || null,
        clock,
      });
      mintId = result.mintId;
      collectionId = result.collectionId;
    });
    const [request, collectionRow, mint] = await Promise.all([
      this.platformGet(id),
      this.reader.loadCollection(collectionId, undefined),
      this.reader.mintView(mintId),
    ]);
    return {
      request,
      collection: await this.reader.collectionView(
        collectionRow as NonNullable<typeof collectionRow>,
      ),
      mint,
    };
  }

  // ── Aprobación ───────────────────────────────────────────────────────────

  /**
   * Comprueba todo lo que exige aprobar (§5.4) sin escribir nada: bodega
   * `ACTIVE`, identidad en la red lista y contrato sin pausar, lote
   * tokenizable, cuota dentro del límite con los datos de ahora (§5.2.5),
   * datos comerciales completos y `slug` libre (solo la primera vez) y precio
   * válido.
   */
  private async planApproval(
    tx: Tx,
    request: RequestFullRow,
    options: {
      commercial?: CommercialInput;
      price?: CollectionPriceInputDto | null;
      publishOnMint: boolean;
      digests: Map<string, ImageDigest>;
    },
  ): Promise<ApprovalPlan> {
    const winery = await tx.winery.findUniqueOrThrow({
      where: { id: request.wineryId },
      select: { certificationStatus: true },
    });
    if (winery.certificationStatus !== 'ACTIVE') {
      throw stateError(
        ErrorCode.TOK_WINERY_NOT_ACTIVE,
        'La bodega no está activa: no se pueden aprobar sus solicitudes',
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
    const identity = await this.chainPort.wineryIdentity(tx, request.wineryId);
    if (identity.status === 'PAUSED' || identity.contract?.paused) {
      throw stateError(
        ErrorCode.CHN_CONTRACT_PAUSED,
        'El contrato de la bodega está pausado en la red: no se puede emitir',
        [
          {
            field: null,
            code: ErrorCode.CHN_CONTRACT_PAUSED,
            message: 'Reanuda el contrato de la bodega antes de aprobar',
            meta: { status: identity.status },
          },
        ],
      );
    }
    if (!identity.ready || !identity.contract || !identity.accountAddress) {
      throw stateError(
        ErrorCode.TOK_WINERY_CHAIN_NOT_READY,
        'La bodega aún no tiene su identidad en la red (cuenta y contrato): no se puede emitir',
        [
          {
            field: null,
            code: ErrorCode.TOK_WINERY_CHAIN_NOT_READY,
            message: `Identidad en la red: ${identity.status}`,
            expected: 'ACTIVE',
            actual: identity.status,
            meta: { status: identity.status },
          },
        ],
      );
    }
    const lot = await loadQuotaLot(tx, request.lotId);
    if (!lot) throw lotNotFound();
    throwBlockers(lotBlockers(lot));
    throwBlockers(quantityViolations(lot, request.quantity));
    throwBlockers(priceViolations(options.price));

    const increase = lot.collection !== null;
    const draft = mergeCommercial(
      parseCommercialDraft(request.commercialDraft),
      options.commercial,
    );
    let slug: string | null = null;
    let digests = options.digests;
    if (!increase) {
      const missing = commercialMissing({
        name: draft.name,
        description: draft.description,
        hasCover: draft.imageKeys.some((i) => i.isCover),
      });
      if (missing.length > 0) {
        throw ruleError(
          ErrorCode.TOK_COMMERCIAL_DATA_INCOMPLETE,
          'Faltan datos comerciales para aprobar la solicitud',
          missing,
        );
      }
      slug = collectionSlug(draft.name as string);
      if (await this.slugTaken(tx, request.wineryId, slug)) {
        throw slugTaken(slug);
      }
      // Imágenes que cambiaron entre el cálculo previo y la transacción
      digests = await this.images.inspect(
        request.wineryId,
        draft.imageKeys,
        'commercial.imageKeys',
        options.digests,
      );
    }
    return {
      request,
      lot,
      identity: identity as ApprovalPlan['identity'],
      increase,
      draft,
      slug,
      digests,
      price: options.price,
      publishOnMint: options.publishOnMint,
    };
  }

  /** Escribe la aprobación ya comprobada. `actor: null` = el sistema (S-11). */
  private async applyApproval(
    tx: Tx,
    plan: ApprovalPlan,
    by: { actor: StaffActor | null; reason: string | null; clock: Clock },
  ): Promise<{ collectionId: string; mintId: string }> {
    const { request, lot, identity, draft } = plan;
    const { actor, clock } = by;
    const previousQuota = lot.authorizedQuota;
    const resultingQuota = previousQuota + request.quantity;

    // Precio vigente de la solicitud: el del cuerpo si viene; si no, el guardado
    const priceData =
      plan.price !== undefined && actor
        ? await this.priceData(tx, request.wineryId, plan.price, actor, clock)
        : {
            priceAmountMinor: request.priceAmountMinor,
            priceCurrency: request.priceCurrency,
            priceSource: request.priceSource,
            priceSetAt: request.priceSetAt,
            priceSetByUserId: request.priceSetByUserId,
          };

    let collectionId: string;
    if (!plan.increase) {
      const fullLot = await tx.lot.findUniqueOrThrow({
        where: { id: lot.id },
        include: COLLECTION_INCLUDE.lot.include,
      });
      const estimatedRedeemDate =
        draft.estimatedRedeemDate ??
        toLotView(fullLot, clock.today, new Map(), clock.now)
          .estimatedReadyDate;
      const policy = await this.reader.pricePolicy(request.wineryId, tx);
      const setByName = priceData.priceSetByUserId
        ? ((
            await tx.user.findUnique({
              where: { id: priceData.priceSetByUserId },
              select: { fullName: true },
            })
          )?.fullName ?? '')
        : '';
      const collection = await tx.collection.create({
        data: {
          slug: plan.slug as string,
          wineryId: request.wineryId,
          lotId: lot.id,
          contractId: identity.contract.id,
          status: 'MINTING',
          mintStatus: 'PENDING',
          quota: resultingQuota,
          minted: 0,
          pendingMintQuantity: request.quantity,
          name: draft.name as string,
          description: draft.description as string,
          tastingNotes: draft.tastingNotes,
          pairing: draft.pairing,
          estimatedRedeemDate: estimatedRedeemDate
            ? toDbDate(estimatedRedeemDate)
            : null,
          ...priceData,
          pricePolicySnapshot:
            policy.value === null
              ? Prisma.JsonNull
              : ({
                  value: policy.value,
                  source: policy.source,
                  takenAt: clock.now.toISOString(),
                } as Prisma.InputJsonObject),
          priceHistory:
            priceData.priceAmountMinor !== null && priceData.priceSetAt
              ? [
                  {
                    amountMinor: priceData.priceAmountMinor,
                    currency: priceData.priceCurrency ?? 'BOB',
                    source: priceData.priceSource ?? 'MANUAL',
                    setAt: priceData.priceSetAt.toISOString(),
                    setBy: {
                      userId: priceData.priceSetByUserId ?? '',
                      fullName: setByName,
                    },
                  },
                ]
              : [],
          createdAt: clock.now,
        },
      });
      collectionId = collection.id;
      await tx.collectionImage.createMany({
        data: draft.imageKeys.map((image, position) => ({
          collectionId,
          key: image.key,
          sha256: (plan.digests.get(image.key) as ImageDigest).sha256,
          alt: image.alt,
          isCover: image.isCover,
          position,
        })),
      });
      await tx.collectionStatusHistory.create({
        data: {
          collectionId,
          status: 'MINTING',
          reason: by.reason,
          actorUserId: actor?.userId ?? null,
          actorName: actor?.fullName ?? null,
          actorSystem: actor === null,
          at: clock.now,
        },
      });
    } else {
      collectionId = (lot.collection as NonNullable<typeof lot.collection>).id;
      await tx.collection.update({
        where: { id: collectionId },
        data: {
          quota: resultingQuota,
          pendingMintQuantity: { increment: request.quantity },
          mintStatus: 'PENDING',
        },
      });
    }

    const lastMint = await tx.mint.findFirst({
      where: { collectionId },
      orderBy: { sequence: 'desc' },
      select: { sequence: true },
    });
    const mint = await tx.mint.create({
      data: {
        collectionId,
        requestId: request.id,
        sequence: (lastMint?.sequence ?? 0) + 1,
        quantity: request.quantity,
        status: 'PENDING',
        lotArg: lot.reference,
        createdAt: clock.now,
      },
    });
    const chunks: MintIntentChunk[] = mintChunks(
      request.quantity,
      previousQuota,
    ).map((chunk) => ({
      ...chunk,
      intentKey: mintIntentKey(mint.id, chunk.index),
    }));

    await tx.tokenizationRequest.update({
      where: { id: request.id },
      data: {
        status: 'APPROVED',
        resultingQuota,
        commercialDraft: draft as unknown as Prisma.InputJsonObject,
        ...priceData,
        publishOnMint: plan.publishOnMint,
        decisionOutcome: 'APPROVED',
        decisionAt: clock.now,
        decisionReason: by.reason,
        decisionByUserId: actor?.userId ?? null,
        decisionBySystem: actor === null,
        collectionId,
      },
    });
    await this.statusChange(tx, request.id, 'APPROVED', {
      userId: actor?.userId ?? null,
      name: actor?.fullName ?? null,
      system: actor === null,
      note: by.reason,
      at: clock.now,
    });
    await appendLotEvent(tx, lot.id, {
      type: 'TOKENIZATION_AUTHORIZED',
      occurredAt: clock.now,
      stage: lot.stage as LotStage,
      actorMembershipId: null,
      summary: plan.increase
        ? `Ampliación de cuota aprobada: ${formatQuantity(request.quantity)} botellas más (${formatQuantity(resultingQuota)} en total); emisión en curso`
        : `Tokenización aprobada: cuota de ${formatQuantity(resultingQuota)} botellas; emisión en curso`,
      data: {
        phase: 'APPROVED',
        requestId: request.id,
        collectionId,
        mintId: mint.id,
        kind: request.kind,
        quantity: request.quantity,
        resultingQuota,
        system: actor === null,
      },
      resource: { type: 'collection', id: collectionId },
    });
    const auditActor = actor === null ? { actor: null } : {};
    await this.audit.record(tx, {
      action: AuditAction.TOKENIZATION_APPROVED,
      resource: { type: 'tokenization_request', id: request.id },
      organizationId: request.wineryId,
      before: { status: request.status, quota: previousQuota },
      after: {
        status: 'APPROVED',
        collectionId,
        quota: resultingQuota,
        priceAmountMinor: priceData.priceAmountMinor,
        publishOnMint: plan.publishOnMint,
      },
      reason: by.reason,
      ...auditActor,
    });
    await this.audit.record(tx, {
      action: AuditAction.NFT_MINT_REQUESTED,
      resource: { type: 'mint', id: mint.id },
      organizationId: request.wineryId,
      after: {
        collectionId,
        sequence: mint.sequence,
        quantity: mint.quantity,
        lotArg: mint.lotArg,
        chunks: chunks.length,
        contractAddress: identity.contract.address,
      },
      ...auditActor,
    });
    await this.outbox.add<TokenizationRequestApprovedPayload>(tx, {
      type: TOKENIZATION_REQUEST_APPROVED,
      aggregateType: TOKENIZATION_REQUEST_AGGREGATE,
      aggregateId: request.id,
      queue: QUEUE_CHAIN,
      payload: {
        requestId: request.id,
        wineryId: request.wineryId,
        lotId: lot.id,
        collectionId,
        mintId: mint.id,
        kind: plan.increase ? 'QUOTA_INCREASE' : 'INITIAL',
        quantity: request.quantity,
        resultingQuota,
        mintSequence: mint.sequence,
        network: identity.network,
        contractId: identity.contract.id,
        contractAddress: identity.contract.address,
        toAddress: identity.accountAddress,
        lotArg: mint.lotArg,
        publishOnMint: plan.publishOnMint,
        approvedBySystem: actor === null,
        approvedByUserId: actor?.userId ?? null,
        chunks,
      },
    });
    await this.chainPort.registerMintIntents(tx, {
      mintId: mint.id,
      requestId: request.id,
      collectionId,
      wineryId: request.wineryId,
      lotId: lot.id,
      network: identity.network,
      contractId: identity.contract.id,
      contractAddress: identity.contract.address,
      toAddress: identity.accountAddress,
      lotArg: mint.lotArg,
      quantity: request.quantity,
      chunks,
      requestedBy: {
        userId: actor?.userId ?? null,
        fullName: actor?.fullName ?? null,
      },
    });
    for (const owner of await wineryOwners(tx, request.wineryId)) {
      await this.mail.enqueue(tx, {
        template: 'tokenizacion-aprobada',
        to: owner.email,
        organizationId: request.wineryId,
        variables: {
          nombre: owner.fullName,
          lote: lot.name,
          cantidad: formatQuantity(request.quantity),
          cuota: formatQuantity(resultingQuota),
          enlace: this.links.erpHome(),
        },
      });
    }
    return { collectionId, mintId: mint.id };
  }

  /**
   * Tras enviar o reenviar (§5.6): con `requiresApproval = false` la solicitud
   * se aprueba sola si cumple todo lo que exige aprobar (S-11); si no, queda
   * `SUBMITTED` para operaciones. Avisa al dueño y a operaciones.
   */
  private async submitted(
    tx: Tx,
    requestId: string,
    lot: QuotaLotRow,
    quantity: number,
    kind: string,
    options: {
      requiresApproval: boolean;
      resubmitted: boolean;
      digests: Map<string, ImageDigest>;
      clock: Clock;
    },
  ): Promise<void> {
    await this.outbox.add<TokenizationRequestEventPayload>(tx, {
      type: TOKENIZATION_REQUEST_SUBMITTED,
      aggregateType: TOKENIZATION_REQUEST_AGGREGATE,
      aggregateId: requestId,
      payload: {
        requestId,
        wineryId: lot.wineryId,
        lotId: lot.id,
        kind,
        quantity,
        resubmitted: options.resubmitted,
      },
    });
    if (!options.requiresApproval) {
      const request = await tx.tokenizationRequest.findUniqueOrThrow({
        where: { id: requestId },
        include: REQUEST_FULL_INCLUDE,
      });
      let plan: ApprovalPlan | null = null;
      try {
        plan = await this.planApproval(tx, request, {
          publishOnMint: false,
          digests: options.digests,
        });
      } catch (error) {
        // No cumple lo que exige aprobar: queda para operaciones
        if (!(error instanceof AppException)) throw error;
      }
      if (plan) {
        await this.applyApproval(tx, plan, {
          actor: null,
          reason: null,
          clock: options.clock,
        });
        return;
      }
    }
    const winery = await tx.winery.findUniqueOrThrow({
      where: { id: lot.wineryId },
      select: { commercialName: true },
    });
    const cantidad = formatQuantity(quantity);
    for (const owner of await wineryOwners(tx, lot.wineryId)) {
      await this.mail.enqueue(tx, {
        template: 'tokenizacion-recibida',
        to: owner.email,
        organizationId: lot.wineryId,
        variables: {
          nombre: owner.fullName,
          bodega: winery.commercialName,
          lote: lot.name,
          cantidad,
          enlace: this.links.erpHome(),
        },
      });
    }
    for (const staff of await operationsStaff(tx)) {
      await this.mail.enqueue(tx, {
        template: 'tokenizacion-nueva-operaciones',
        to: staff.email,
        organizationId: lot.wineryId,
        variables: {
          nombre: staff.fullName,
          bodega: winery.commercialName,
          lote: lot.name,
          cantidad,
          tipo: options.resubmitted ? 'reenviada' : 'nueva',
          enlace: this.links.base('BACKOFFICE'),
        },
      });
    }
  }

  // ── Utilidades ───────────────────────────────────────────────────────────

  /** Transacción de escritura; un `slug` o una solicitud abierta duplicados → su 409. */
  private async write<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(work, AUDIT_TX_OPTIONS);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const target = JSON.stringify(error.meta?.target ?? '');
        if (target.includes('slug')) throw slugTaken(null);
        if (target.includes('lot_id')) {
          throw stateError(
            ErrorCode.TOK_REQUEST_ALREADY_OPEN,
            'El lote ya tiene una solicitud de tokenización abierta o una colección',
          );
        }
      }
      throw error;
    }
  }

  /**
   * Ejecuta `work` con la solicitud y su lote bloqueados: lee la solicitud
   * (404 si no existe o es de otra bodega), bloquea la fila del lote y la
   * vuelve a leer dentro de la transacción.
   */
  private async onRequest(
    id: string,
    wineryId: string | undefined,
    work: (
      tx: Tx,
      request: RequestFullRow,
      lot: QuotaLotRow,
      clock: Clock,
    ) => Promise<void>,
  ): Promise<void> {
    await this.write(async (tx) => {
      const found = await tx.tokenizationRequest.findFirst({
        where: { id, ...(wineryId && { wineryId }) },
        select: { lotId: true },
      });
      if (!found) throw requestNotFound();
      await lockLotRow(tx, found.lotId);
      const request = await tx.tokenizationRequest.findUniqueOrThrow({
        where: { id },
        include: REQUEST_FULL_INCLUDE,
      });
      const lot = await loadQuotaLot(tx, request.lotId);
      if (!lot) throw lotNotFound();
      // La propia solicitud no cuenta como pendiente contra sí misma
      const own = lot.openRequest?.id === id;
      await work(
        tx,
        request,
        own ? { ...lot, pendingQuantity: 0 } : lot,
        await dbClock(tx),
      );
    });
  }

  private async wineryOf(requestId: string): Promise<string> {
    const row = await this.prisma.tokenizationRequest.findUnique({
      where: { id: requestId },
      select: { wineryId: true },
    });
    if (!row) throw requestNotFound();
    return row.wineryId;
  }

  private async requiresApproval(tx: Tx, wineryId: string): Promise<boolean> {
    const settings = await resolveSettingsFromDatabase(tx, wineryId);
    return settings[APPROVAL_SETTING]?.value !== false;
  }

  /** El `slug` es único **por bodega**: dos bodegas pueden repetir nombre. */
  private async slugTaken(
    tx: Tx,
    wineryId: string,
    slug: string,
  ): Promise<boolean> {
    return (
      (await tx.collection.findUnique({
        where: { wineryId_slug: { wineryId, slug } },
        select: { id: true },
      })) !== null
    );
  }

  private async wineryActor(
    tx: Tx,
    userId: string,
    wineryId: string,
  ): Promise<WineryActor> {
    const [membership, user] = await Promise.all([
      actorMembership(tx, userId, wineryId),
      tx.user.findUnique({ where: { id: userId }, select: { fullName: true } }),
    ]);
    return {
      userId,
      membershipId: membership?.id ?? null,
      fullName: user?.fullName ?? '',
    };
  }

  private async staffActor(tx: Tx, userId: string): Promise<StaffActor> {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { fullName: true },
    });
    return { userId, fullName: user?.fullName ?? '' };
  }

  /** Columnas del precio: `null` lo quita; con importe, quién y cuándo lo fijó. */
  private async priceData(
    tx: Tx,
    wineryId: string,
    price: CollectionPriceInputDto | null,
    actor: StaffActor,
    clock: Clock,
  ) {
    if (price === null) {
      return {
        priceAmountMinor: null,
        priceCurrency: null,
        priceSource: null,
        priceSetAt: null,
        priceSetByUserId: null,
      };
    }
    const suggestion = await this.reader.priceSuggestion(wineryId, tx);
    return {
      priceAmountMinor: price.amountMinor,
      priceCurrency: price.currency,
      priceSource:
        suggestion.available && suggestion.amountMinor === price.amountMinor
          ? 'POLICY_SUGGESTED'
          : 'MANUAL',
      priceSetAt: clock.now,
      priceSetByUserId: actor.userId,
    };
  }

  private async statusChange(
    tx: Tx,
    requestId: string,
    status: TokenizationRequestStatus,
    by: {
      userId?: string | null;
      membershipId?: string | null;
      name?: string | null;
      system?: boolean;
      note?: string | null;
      at: Date;
    },
  ): Promise<void> {
    await recordStatusChange(tx, requestId, status, by);
  }

  private eventPayload(
    request: { id: string; wineryId: string; lotId: string; kind: string },
    quantity: number,
  ): TokenizationRequestEventPayload {
    return {
      requestId: request.id,
      wineryId: request.wineryId,
      lotId: request.lotId,
      kind: request.kind,
      quantity,
    };
  }
}

function slugTaken(slug: string | null): TraceRuleException {
  return stateError(
    ErrorCode.TOK_SLUG_TAKEN,
    'Ya existe una colección con ese nombre: cámbialo para que su dirección sea única',
    [
      {
        field: 'commercial.name',
        code: ErrorCode.TOK_SLUG_TAKEN,
        message:
          'El nombre genera un slug que ya usa otra colección de la bodega',
        ...(slug && { meta: { slug } }),
      },
    ],
  );
}

/** Personal de operaciones y administración activo (avisos por correo). */
async function operationsStaff(
  tx: Tx,
): Promise<{ email: string; fullName: string }[]> {
  const rows = await tx.membership.findMany({
    where: {
      organizationId: PLATFORM_ORGANIZATION_ID,
      role: { in: ['ADMIN', 'OPERATIONS'] },
      status: 'ACTIVE',
      user: { isActive: true },
    },
    include: { user: { select: { email: true, fullName: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map((r) => r.user);
}
