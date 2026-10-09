import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { LotClosure, Prisma } from '@prisma/client';
import { AuditAction } from '@shared/audit/audit.actions';
import { AuditService } from '@shared/audit/audit.service';
import type { AuthenticatedUser } from '@shared/decorators/current-user.decorator';
import { toPage, toPrismaPage } from '@shared/dto/pagination-query.dto';
import { AppException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';
import type { Paginated } from '@shared/interfaces/api-response.interface';
import { OutboxService } from '@shared/outbox/outbox.service';
import { PrismaService } from '@shared/prisma/prisma.service';
import {
  CHAIN_SETTINGS,
  type ChainSettings,
} from '@modules/chain/chain.config';
import {
  stateError,
  TraceRuleException,
} from '@modules/lots/domain/trace-errors';
import { AppLinks } from '@modules/mail/app-links';
import { MailService } from '@modules/mail/mail.service';
import type {
  DecideLotClosureDto,
  LotClosureDto,
  LotClosuresQueryDto,
  LotClosureSummaryDto,
  ResolveLotClosureItemDto,
  WineryLotClosureDto,
} from '../dto/collections.dto';
import {
  TOKENIZATION_CHAIN_PORT,
  type TokenizationChainPort,
} from '../ports/tokenization-chain.port';
import {
  CLOSURE_INCLUDE,
  toClosureSummary,
  toClosureView,
  toWineryClosureView,
  type ClosureRow,
} from './closure-view';
import {
  recomputeClosure,
  settleClosure,
  type ClosureDeps,
} from './closure-writes';

type Tx = Prisma.TransactionClient;

/** Decidir puede registrar una quema por cada NFT sin vender de la colección. */
const DECIDE_TX_OPTIONS = { timeout: 120_000, maxWait: 15_000 } as const;
const TX_OPTIONS = { timeout: 30_000, maxWait: 10_000 } as const;

function collectionNotFound(): TraceRuleException {
  return new TraceRuleException(
    404,
    ErrorCode.TOK_COLLECTION_NOT_FOUND,
    'Colección no encontrada',
  );
}

const conflict = (message: string, meta: Record<string, unknown> = {}) =>
  new AppException(HttpStatus.CONFLICT, ErrorCode.CONFLICT, message, [
    { field: null, message, meta },
  ]);

/**
 * Cierre del lote con faltante (contrato O3 §8.4; TOK-10, A-30): lectura,
 * decisión y resolución manual. El cálculo es de `closure-writes.ts`; aquí,
 * las reglas de quién decide y lo que la decisión encola (`BURN_UNSOLD` por
 * el outbox: ninguna ruta toca la red).
 */
@Injectable()
export class LotClosureService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly mail: MailService,
    private readonly links: AppLinks,
    @Inject(TOKENIZATION_CHAIN_PORT)
    private readonly chainPort: TokenizationChainPort,
    @Inject(CHAIN_SETTINGS) private readonly chain: ChainSettings,
  ) {}

  private deps(): ClosureDeps {
    return {
      audit: this.audit,
      mail: this.mail,
      outbox: this.outbox,
      erpUrl: this.links.erpHome(),
      backofficeUrl: this.links.base('BACKOFFICE'),
    };
  }

  // ── Lecturas ─────────────────────────────────────────────────────────────

  /** `GET /v1/platform/lot-closures`: sin los NFT afectados. */
  async list(
    query: LotClosuresQueryDto,
  ): Promise<Paginated<LotClosureSummaryDto>> {
    const where: Prisma.LotClosureWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.wineryId ? { collection: { wineryId: query.wineryId } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.lotClosure.findMany({
        where,
        orderBy: [{ computedAt: 'desc' }, { id: 'desc' }],
        ...toPrismaPage(query),
      }),
      this.prisma.lotClosure.count({ where }),
    ]);
    return toPage(rows.map(toClosureSummary), total, query);
  }

  /** `GET /v1/platform/collections/{id}/closure`. */
  async platformView(collectionId: string): Promise<LotClosureDto> {
    const row = await this.current(collectionId);
    return this.toView(row);
  }

  /** `GET /v1/collections/{id}/closure`: cifras y botellas, sin pedidos. */
  async wineryView(
    wineryId: string | undefined,
    collectionId: string,
  ): Promise<WineryLotClosureDto> {
    return toWineryClosureView(
      await this.toView(await this.current(collectionId, wineryId)),
    );
  }

  /**
   * El cierre al día: lo calcula si aún no existe (un lote embotellado antes
   * de este paso, o el evento todavía en camino) con el mismo código que el
   * procesador del outbox. Lote sin embotellar ni descartar → 409.
   */
  private async current(
    collectionId: string,
    wineryId?: string,
  ): Promise<ClosureRow> {
    return this.prisma.$transaction(async (tx) => {
      const { closure } = await this.ensure(tx, collectionId, wineryId);
      return this.load(tx, closure.id);
    }, TX_OPTIONS);
  }

  private async ensure(
    tx: Tx,
    collectionId: string,
    wineryId?: string,
  ): Promise<{
    closure: LotClosure;
    collection: {
      id: string;
      lotId: string;
      wineryId: string;
      contractId: string;
    };
  }> {
    const collection = await tx.collection.findFirst({
      where: { id: collectionId, ...(wineryId ? { wineryId } : {}) },
      select: { id: true, lotId: true, wineryId: true, contractId: true },
    });
    if (!collection) throw collectionNotFound();
    const change = await recomputeClosure(tx, this.deps(), collection.lotId);
    if (!change.applicable) {
      throw stateError(
        ErrorCode.TOK_CLOSURE_NOT_APPLICABLE,
        'El lote no se ha embotellado ni descartado: todavía no hay cierre que calcular',
        [
          {
            field: null,
            code: ErrorCode.TOK_CLOSURE_NOT_APPLICABLE,
            message: 'El cierre se calcula al embotellar o descartar el lote',
            meta: { stage: change.stage },
          },
        ],
      );
    }
    return { closure: change.closure, collection };
  }

  private load(tx: Tx, closureId: string): Promise<ClosureRow> {
    return tx.lotClosure.findUniqueOrThrow({
      where: { id: closureId },
      include: CLOSURE_INCLUDE,
    });
  }

  private toView(row: ClosureRow): Promise<LotClosureDto> {
    return toClosureView(this.prisma, row, this.chain.explorerBaseUrl);
  }

  // ── Decisión (§8.4) ──────────────────────────────────────────────────────

  /**
   * `POST …/closure/decide`. Con quemas (faltante o `BURN`) solo decide
   * administración; operaciones, solo `KEEP_ON_SALE` sin faltante. Encola un
   * `BURN_UNSOLD` por cada NFT sin vender que pierde su botella (y, con
   * `BURN`, por todos los demás sin vender).
   */
  async decide(
    collectionId: string,
    dto: DecideLotClosureDto,
    user: AuthenticatedUser,
  ): Promise<LotClosureDto> {
    const row = await this.prisma.$transaction(async (tx) => {
      const { closure, collection } = await this.ensure(tx, collectionId);
      await tx.$queryRaw`SELECT id FROM lot_closures WHERE id = ${closure.id}::uuid FOR UPDATE`;
      if (closure.status === 'DECIDED' || closure.status === 'RESOLVED') {
        throw conflict('El cierre del lote ya está decidido', {
          closureStatus: closure.status,
        });
      }
      const withBurns = closure.shortfall > 0 || dto.unsoldPolicy === 'BURN';
      if (withBurns && user.role !== 'ADMIN') {
        throw new AppException(
          HttpStatus.FORBIDDEN,
          ErrorCode.AUTH_INSUFFICIENT_PERMISSIONS,
          'Una decisión con quemas (faltante o quemar los no vendidos) solo la toma administración',
        );
      }
      if (withBurns) await this.assertBurnable(tx, collection.wineryId);
      const actor = await tx.user.findUnique({
        where: { id: user.id },
        select: { fullName: true },
      });
      const fullName = actor?.fullName ?? null;
      const at = new Date();

      // Lo que ya es ítem del cierre: los no vendidos se queman
      const current = await this.load(tx, closure.id);
      const toBurn = current.items.filter(
        (item) => item.outcome === 'PENDING' && item.token.status === 'MINTED',
      );
      // `BURN`: además, los no vendidos que sí tienen botella
      if (dto.unsoldPolicy === 'BURN') {
        const known = new Set(current.items.map((item) => item.tokenRowId));
        const rest = await tx.token.findMany({
          where: { collectionId, status: 'MINTED' },
          select: { id: true, tokenId: true, bottleNumber: true, status: true },
          orderBy: { bottleNumber: 'desc' },
        });
        for (const token of rest.filter((t) => !known.has(t.id))) {
          const item = await tx.lotClosureItem.create({
            data: {
              closureId: closure.id,
              tokenRowId: token.id,
              tokenId: token.tokenId,
              bottleNumber: token.bottleNumber,
              tokenStatus: token.status,
              outcome: 'PENDING',
            },
            include: { token: { select: { status: true } } },
          });
          toBurn.push(item);
        }
      }
      for (const item of toBurn) {
        const burnTxId = await this.chainPort.registerBurnIntent(tx, {
          closureId: closure.id,
          collectionId,
          wineryId: collection.wineryId,
          contractId: collection.contractId,
          tokenRowId: item.tokenRowId,
          tokenId: item.tokenId,
          requestedBy: { userId: user.id, fullName },
        });
        await tx.lotClosureItem.update({
          where: { id: item.id },
          data: { outcome: 'BURN_UNSOLD', burnTxId },
        });
      }

      // Sin faltante y sin quemas no hay nada que resolver: sigue `NO_SHORTFALL`
      const status =
        closure.status === 'NO_SHORTFALL' && toBurn.length === 0
          ? 'NO_SHORTFALL'
          : 'DECIDED';
      await tx.lotClosure.update({
        where: { id: closure.id },
        data: {
          status,
          unsoldPolicy: dto.unsoldPolicy,
          decisionByUserId: user.id,
          decisionByName: fullName,
          decisionAt: at,
          decisionReason: dto.reason,
        },
      });
      const settled =
        status === 'DECIDED' ? await settleClosure(tx, closure.id) : status;
      await this.audit.record(tx, {
        action: AuditAction.LOT_CLOSURE_DECIDED,
        resource: { type: 'lot_closure', id: closure.id },
        organizationId: collection.wineryId,
        before: { status: closure.status, unsoldPolicy: closure.unsoldPolicy },
        after: {
          status: settled,
          unsoldPolicy: dto.unsoldPolicy,
          collectionId,
          shortfall: closure.shortfall,
          burnsRequested: toBurn.length,
          soldWithoutBottle: closure.soldWithoutBottle,
        },
        reason: dto.reason,
        actor: { userId: user.id },
      });
      return this.load(tx, closure.id);
    }, DECIDE_TX_OPTIONS);
    return this.toView(row);
  }

  /** `redeem_burn` falla con el contrato pausado: mejor decirlo al decidir. */
  private async assertBurnable(tx: Tx, wineryId: string): Promise<void> {
    const identity = await this.chainPort.wineryIdentity(tx, wineryId);
    if (identity.contract?.paused || identity.status === 'PAUSED') {
      throw stateError(
        ErrorCode.CHN_CONTRACT_PAUSED,
        'El contrato de la bodega está pausado en la red: reanúdalo antes de decidir un cierre con quemas',
        [
          {
            field: null,
            code: ErrorCode.CHN_CONTRACT_PAUSED,
            message: 'Las quemas no entran con el contrato pausado',
            meta: { status: identity.status },
          },
        ],
      );
    }
  }

  // ── Resolución manual (A-30) ─────────────────────────────────────────────

  /** `POST …/closure/items/{tokenId}/resolve`: devolución o sustitución. */
  async resolveItem(
    collectionId: string,
    tokenId: number,
    dto: ResolveLotClosureItemDto,
    user: AuthenticatedUser,
  ): Promise<LotClosureDto> {
    const row = await this.prisma.$transaction(async (tx) => {
      const { closure, collection } = await this.ensure(tx, collectionId);
      await tx.$queryRaw`SELECT id FROM lot_closures WHERE id = ${closure.id}::uuid FOR UPDATE`;
      const item = await tx.lotClosureItem.findUnique({
        where: { closureId_tokenId: { closureId: closure.id, tokenId } },
      });
      if (!item) {
        throw new AppException(
          HttpStatus.NOT_FOUND,
          ErrorCode.NOT_FOUND,
          'Ese NFT no es un ítem del cierre del lote',
        );
      }
      if (item.outcome !== 'PENDING') {
        throw conflict(
          item.outcome === 'BURN_UNSOLD'
            ? 'Ese NFT no se vendió: se quema, no se resuelve a mano'
            : 'El ítem ya está resuelto',
          { outcome: item.outcome },
        );
      }
      const token = await tx.token.findUniqueOrThrow({
        where: { id: item.tokenRowId },
        select: { status: true },
      });
      if (token.status === 'MINTED') {
        throw conflict(
          'Ese NFT no se ha vendido: decide el cierre para que se queme',
          { tokenStatus: token.status },
        );
      }
      const at = new Date();
      await tx.lotClosureItem.update({
        where: { id: item.id },
        data: { outcome: dto.outcome, note: dto.note, resolvedAt: at },
      });
      const status = await settleClosure(tx, closure.id);
      await this.audit.record(tx, {
        action: AuditAction.LOT_CLOSURE_ITEM_RESOLVED,
        resource: { type: 'lot_closure', id: closure.id },
        organizationId: collection.wineryId,
        before: { tokenId, outcome: 'PENDING' },
        after: {
          tokenId,
          bottleNumber: item.bottleNumber,
          outcome: dto.outcome,
          closureStatus: status,
        },
        reason: dto.note,
        actor: { userId: user.id },
      });
      return this.load(tx, closure.id);
    }, TX_OPTIONS);
    return this.toView(row);
  }
}
