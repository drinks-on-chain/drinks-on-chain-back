import { Injectable } from '@nestjs/common';
import {
  AgingStatusEnum,
  LotStageEnum,
  Prisma,
  RestStatusEnum,
} from '@prisma/client';
import { PrismaService } from '@shared/prisma/prisma.service';
import { AUDIT_TX_OPTIONS, AuditService } from '@shared/audit/audit.service';
import { AuditAction } from '@shared/audit/audit.actions';
import { ErrorCode } from '@shared/exceptions/error-codes';
import { ValidationException } from '@shared/exceptions/validation.exception';
import type { Paginated } from '@shared/interfaces/api-response.interface';
import { toPage } from '@shared/dto/pagination-query.dto';
import {
  CreateLotDto,
  DiscardLotDto,
  LOT_STAGES,
  QueryLotsDto,
  UpdateLotDto,
} from './dto/lot.dto';
import { createLotRecord, lockLot, refreshLotStage } from './lot-records';
import { appendLotEvent } from './lot-events';
import { actorMembership, dbClock } from './trace-db';
import { resolveTraceActors } from './trace-actors';
import {
  LOT_VIEW_INCLUDE,
  lotActorIds,
  LotSummaryView,
  LotView,
  toLotSummary,
  toLotView,
} from './lot-view';
import { daysBetween, toDbDate } from './domain/dates';
import type { LotRules } from './domain/lot-rules';
import {
  doRulesFromLot,
  doViolations,
  evaluateDo,
} from './domain/do-evaluation';
import type { LotProductType } from './domain/lot-stage';
import { lotNotFound, ruleError, violation } from './domain/trace-errors';
import { estimateBelowMinted } from '@modules/tokenization/domain/quota';

/** Lote del servidor (contrato O2 §2): creación, consulta, edición y descarte. */
@Injectable()
export class LotsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(
    wineryId: string | undefined,
    query: QueryLotsDto,
  ): Promise<Paginated<LotSummaryView>> {
    const where: Prisma.LotWhereInput = { ...(wineryId && { wineryId }) };
    if (query.stage) {
      const stages = query.stage
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const invalid = stages.filter(
        (s) => !(LOT_STAGES as readonly string[]).includes(s),
      );
      if (invalid.length > 0) {
        throw ValidationException.forField(
          'stage',
          `Etapas desconocidas: ${invalid.join(', ')} (válidas: ${LOT_STAGES.join(', ')})`,
        );
      }
      where.stage = { in: stages as LotStageEnum[] };
    }
    if (query.productType) where.productType = query.productType;
    if (query.harvestYear) where.harvestYear = query.harvestYear;
    if (query.q) {
      where.OR = [
        { name: { contains: query.q, mode: 'insensitive' } },
        { reference: { contains: query.q, mode: 'insensitive' } },
        { lotCode: { contains: query.q, mode: 'insensitive' } },
      ];
    }
    if (query.hasComplianceIssues === 'true') {
      where.complianceIssues = { some: { resolvedAt: null } };
    } else if (query.hasComplianceIssues === 'false') {
      where.complianceIssues = { none: { resolvedAt: null } };
    }
    const { today } = await dbClock(this.prisma);
    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;

    if (query.lockDueWithinDays !== undefined) {
      // El candado se calcula con la instantánea de cada lote: se filtra en memoria
      const all = await this.prisma.lot.findMany({
        where,
        include: LOT_VIEW_INCLUDE,
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      });
      const due = all
        .map((lot) => toLotSummary(lot, today))
        .filter(
          (s) =>
            s.nextLock !== null &&
            daysBetween(today, s.nextLock.unlockDate) <=
              (query.lockDueWithinDays as number),
        );
      return toPage(due.slice(offset, offset + limit), due.length, query);
    }

    const [items, total] = await Promise.all([
      this.prisma.lot.findMany({
        where,
        include: LOT_VIEW_INCLUDE,
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        skip: offset,
        take: limit,
      }),
      this.prisma.lot.count({ where }),
    ]);
    return toPage(
      items.map((lot) => toLotSummary(lot, today)),
      total,
      query,
    );
  }

  async get(wineryId: string | undefined, id: string): Promise<LotView> {
    const lot = await this.prisma.lot.findFirst({
      where: { id, ...(wineryId && { wineryId }) },
      include: LOT_VIEW_INCLUDE,
    });
    if (!lot) throw lotNotFound();
    const { today, now } = await dbClock(this.prisma);
    const actors = await resolveTraceActors(this.prisma, lotActorIds(lot));
    return toLotView(lot, today, actors, now);
  }

  async create(
    wineryId: string,
    userId: string,
    dto: CreateLotDto,
  ): Promise<LotView> {
    const lotId = await this.prisma.$transaction(async (tx) => {
      const clock = await dbClock(tx);
      const membership = await actorMembership(tx, userId, wineryId);
      const created = await createLotFromBody(
        tx,
        wineryId,
        dto,
        membership?.id ?? null,
        clock,
      );
      await this.audit.record(tx, {
        action: AuditAction.LOT_CREATED,
        resource: { type: 'lot', id: created.id },
        organizationId: wineryId,
        after: {
          reference: created.reference,
          name: dto.name,
          harvestYear: dto.harvestYear,
          productType: dto.productType ?? null,
          estimatedBottles: dto.estimatedBottles ?? null,
          rulesTakenAt: created.rules.takenAt,
        },
      });
      return created.id;
    }, AUDIT_TX_OPTIONS);
    return this.get(wineryId, lotId);
  }

  async update(
    wineryId: string,
    id: string,
    userId: string,
    dto: UpdateLotDto,
  ): Promise<LotView> {
    await this.prisma.$transaction(async (tx) => {
      const locked = await lockLot(tx, id, wineryId, { writable: true });
      const before = await tx.lot.findUniqueOrThrow({ where: { id } });
      const estimateChanges =
        dto.estimatedBottles !== undefined &&
        dto.estimatedBottles !== before.estimatedBottles;
      if (estimateChanges && !dto.reason?.trim()) {
        throw ValidationException.forField(
          'reason',
          'Indica el motivo del cambio de la estimación de botellas (queda en su historial)',
        );
      }
      if (
        estimateChanges &&
        dto.estimatedBottles !== undefined &&
        dto.estimatedBottles !== null
      ) {
        // La estimación no baja de lo emitido como NFT (contrato O3 §5.2.6)
        const collection = await tx.collection.findUnique({
          where: { lotId: id },
          select: { minted: true },
        });
        const below = collection
          ? estimateBelowMinted(dto.estimatedBottles, collection.minted)
          : null;
        if (below) {
          throw ruleError(ErrorCode.TOK_ESTIMATE_BELOW_MINTED, below.message, [
            below,
          ]);
        }
      }
      const clock = await dbClock(tx);
      const membership = await actorMembership(tx, userId, wineryId);
      const data: Prisma.LotUpdateInput = {};
      if (dto.name !== undefined) data.name = dto.name.trim();
      if (dto.estimatedBottles !== undefined)
        data.estimatedBottles = dto.estimatedBottles;
      if (dto.plannedFormatCl !== undefined)
        data.plannedFormatCl = dto.plannedFormatCl;
      if (dto.targetAbvPercent !== undefined)
        data.targetAbvPercent = new Prisma.Decimal(dto.targetAbvPercent);
      if (dto.targetReadyDate !== undefined)
        data.targetReadyDate = toDbDate(dto.targetReadyDate.slice(0, 10));
      if (dto.notes !== undefined) data.notes = dto.notes;
      const after = await tx.lot.update({ where: { id }, data });
      if (estimateChanges) {
        await appendLotEvent(tx, id, {
          type: 'ESTIMATE_CHANGED',
          occurredAt: clock.now,
          stage: locked.stage,
          actorMembershipId: membership?.id ?? null,
          summary: `Estimación de botellas: ${before.estimatedBottles ?? '—'} → ${dto.estimatedBottles}`,
          data: {
            value: dto.estimatedBottles,
            previous: before.estimatedBottles,
            reason: dto.reason?.trim() ?? null,
          },
          resource: { type: 'lot', id },
        });
      }
      await this.audit.record(tx, {
        action: AuditAction.LOT_UPDATED,
        resource: { type: 'lot', id },
        organizationId: wineryId,
        before: pick(before, Object.keys(data)),
        after: pick(after, Object.keys(data)),
        reason: dto.reason ?? null,
      });
    }, AUDIT_TX_OPTIONS);
    return this.get(wineryId, id);
  }

  async discard(
    wineryId: string,
    id: string,
    userId: string,
    dto: DiscardLotDto,
  ): Promise<LotView> {
    await this.prisma.$transaction(async (tx) => {
      const locked = await lockLot(tx, id, wineryId, { writable: true });
      const clock = await dbClock(tx);
      const membership = await actorMembership(tx, userId, wineryId);
      const reason = dto.reason.trim();
      await tx.lot.update({
        where: { id },
        data: {
          discardedAt: clock.now,
          discardedByMembershipId: membership?.id ?? null,
          discardReason: reason,
        },
      });
      // Fuentes abiertas → DISCARDED; códigos de botella anulados (§2.2)
      await tx.wineAgingBatch.updateMany({
        where: {
          lotId: id,
          agingStatus: { in: [AgingStatusEnum.AGING, AgingStatusEnum.READY] },
        },
        data: {
          agingStatus: AgingStatusEnum.DISCARDED,
          discardedAt: clock.now,
          discardReason: reason,
        },
      });
      await tx.productionBatch.updateMany({
        where: {
          lotId: id,
          restStatus: {
            in: [
              RestStatusEnum.RESTING,
              RestStatusEnum.READY,
              RestStatusEnum.NOT_REQUIRED,
            ],
          },
          discardedAt: null,
        },
        data: {
          restStatus: RestStatusEnum.DISCARDED,
          discardedAt: clock.now,
          discardReason: reason,
        },
      });
      const voided = await tx.bottleUnit.updateMany({
        where: { lotId: id, status: 'ACTIVE' },
        data: {
          status: 'VOIDED',
          voidedAt: clock.now,
          voidedByMembershipId: membership?.id ?? null,
          voidReason: `Lote descartado: ${reason}`,
        },
      });
      const stage = await refreshLotStage(tx, id, clock.now);
      await appendLotEvent(tx, id, {
        type: 'LOT_DISCARDED',
        occurredAt: clock.now,
        stage,
        actorMembershipId: membership?.id ?? null,
        summary: `Lote descartado: ${reason}`,
        data: {
          reason,
          previousStage: locked.stage,
          voidedBottleCodes: voided.count,
        },
        resource: { type: 'lot', id },
      });
      await this.audit.record(tx, {
        action: AuditAction.LOT_DISCARDED,
        resource: { type: 'lot', id },
        organizationId: wineryId,
        before: { stage: locked.stage },
        after: { stage, voidedBottleCodes: voided.count },
        reason,
      });
    }, AUDIT_TX_OPTIONS);
    return this.get(wineryId, id);
  }
}

/** `productType` del cuerpo: solo `WINE` o `SINGANI` en el MVP (S-1). */
export function parseProductType(
  value: string | undefined | null,
  field = 'productType',
): LotProductType | null {
  if (value === undefined || value === null) return null;
  if (value === 'WINE' || value === 'SINGANI') return value;
  throw ruleError(
    ErrorCode.TRC_PRODUCT_NOT_SUPPORTED,
    `El lote solo admite vino o singani (recibido: ${value})`,
    [
      violation(
        ErrorCode.TRC_PRODUCT_NOT_SUPPORTED,
        'Tipo de producto no admitido',
        {
          field,
          expected: ['WINE', 'SINGANI'],
          actual: value,
        },
      ),
    ],
  );
}

function pick(
  row: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> {
  return Object.fromEntries(keys.map((k) => [k, row[k]]));
}

/**
 * Crea un lote a partir de `CreateLotBody` (en origen, desde la vendimia o
 * desde el tanque, §2.4) en la transacción `tx`: tipo admitido, añada no
 * futura, parcelas previstas de la bodega y D.O. de las previstas si es
 * singani (con la instantánea recién tomada).
 */
export async function createLotFromBody(
  tx: Prisma.TransactionClient,
  wineryId: string,
  dto: CreateLotDto,
  membershipId: string | null,
  clock: { now: Date; today: string },
  field = '',
): Promise<{ id: string; rules: LotRules; reference: string }> {
  const at = (name: string) => (field ? `${field}.${name}` : name);
  const productType = parseProductType(dto.productType, at('productType'));
  const year = Number(clock.today.slice(0, 4));
  if (dto.harvestYear > year) {
    throw ValidationException.forField(
      at('harvestYear'),
      `La añada no puede ser posterior al año actual (${year})`,
    );
  }
  const terroirs = await plannedTerroirs(
    tx,
    wineryId,
    dto.plannedTerroirIds,
    at('plannedTerroirIds'),
  );
  const created = await createLotRecord(tx, {
    wineryId,
    name: dto.name.trim(),
    harvestYear: dto.harvestYear,
    productType,
    estimatedBottles: dto.estimatedBottles ?? null,
    plannedFormatCl: dto.plannedFormatCl ?? null,
    targetAbvPercent: dto.targetAbvPercent ?? null,
    plannedTerroirIds: terroirs.map((t) => t.id),
    targetReadyDate: dto.targetReadyDate?.slice(0, 10) ?? null,
    notes: dto.notes ?? null,
    createdByMembershipId: membershipId,
    origin: 'LOT_CREATION',
    takenAt: clock.now,
  });
  if (productType === 'SINGANI' && terroirs.length > 0) {
    const evaluation = evaluateDo(
      terroirs.map((t) => ({
        id: t.id,
        altitudeMasl: t.altitudeMasl.toNumber(),
        varietyName: t.varietyName,
      })),
      doRulesFromLot(created.rules),
      'LOT_SNAPSHOT',
      clock.now,
    );
    if (evaluation.status === 'NOT_ELIGIBLE') {
      const names = Object.fromEntries(
        terroirs.map((t) => [t.id, t.parcelName]),
      );
      throw ruleError(
        ErrorCode.TRC_DO_TERROIR_NOT_ELIGIBLE,
        'Una parcela prevista no es apta para la D.O. Singani',
        doViolations(
          evaluation,
          ErrorCode.TRC_DO_TERROIR_NOT_ELIGIBLE,
          names,
        ).map((d) => ({
          ...d,
          field: at('plannedTerroirIds'),
        })),
      );
    }
  }
  return created;
}

async function plannedTerroirs(
  tx: Prisma.TransactionClient,
  wineryId: string,
  ids: string[] | undefined,
  field: string,
) {
  const unique = [...new Set(ids ?? [])];
  if (unique.length === 0) return [];
  const terroirs = await tx.terroir.findMany({
    where: { id: { in: unique }, wineryId },
    select: {
      id: true,
      parcelName: true,
      altitudeMasl: true,
      varietyName: true,
    },
  });
  if (terroirs.length !== unique.length) {
    const found = new Set(terroirs.map((t) => t.id));
    throw new ValidationException(
      unique
        .filter((tid) => !found.has(tid))
        .map((tid) => ({
          field,
          message: `La parcela ${tid} no existe en esta bodega`,
        })),
    );
  }
  return terroirs;
}
