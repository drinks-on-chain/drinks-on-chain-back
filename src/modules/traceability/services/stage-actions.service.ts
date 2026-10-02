import { Injectable, NotFoundException } from '@nestjs/common';
import { AgingStatusEnum, Prisma, RestStatusEnum } from '@prisma/client';
import { AUDIT_TX_OPTIONS, AuditService } from '@shared/audit/audit.service';
import { AuditAction } from '@shared/audit/audit.actions';
import { ErrorCode } from '@shared/exceptions/error-codes';
import { PrismaService } from '@shared/prisma/prisma.service';
import { ensureHarvestLot } from '@modules/lots/chain';
import {
  CloseDistillationDto,
  DiscardProductionBatchDto,
  DiscardWineAgingDto,
} from '@modules/lots/contract/dto/stage-actions.dto';
import { assertDayNotFuture, assertNotBefore } from '@modules/lots/date-rules';
import {
  addDays,
  calendarDay,
  dateOnly,
  toDbDate,
} from '@modules/lots/domain/dates';
import { LOT_RULE_KEYS } from '@modules/lots/domain/lot-rules';
import {
  cutsTotal,
  massBalanceViolation,
} from '@modules/lots/domain/mass-balance';
import { num } from '@modules/lots/domain/sources';
import {
  ruleError,
  stateError,
  violation,
} from '@modules/lots/domain/trace-errors';
import { releaseDueLocks } from '@modules/lots/lock-release';
import { appendLotEvent, formatQuantity } from '@modules/lots/lot-events';
import { lotIntegrity, reevaluateLotIssues } from '@modules/lots/lot-integrity';
import { lockLot, LockedLot, refreshLotStage } from '@modules/lots/lot-records';
import { actorMembership, dbClock, DbClock } from '@modules/lots/trace-db';
import { ProductionBatchesService } from './production-batches.service';
import { WineAgingService } from './wine-aging.service';

type Tx = Prisma.TransactionClient;

/**
 * Acciones sobre las fuentes del embotellado (contrato O2 §5): descarte de
 * una crianza, y cierre con cortes tipados y descarte de una destilación.
 * Cada una bloquea la fila del lote y deja su evento y su entrada de
 * bitácora en la misma transacción.
 */
@Injectable()
export class StageActionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly wineAging: WineAgingService,
    private readonly productionBatches: ProductionBatchesService,
  ) {}

  /** `AGING | READY → DISCARDED`, con motivo (§5.1). */
  async discardAging(
    wineryId: string,
    userId: string,
    id: string,
    dto: DiscardWineAgingDto,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const found = await tx.wineAgingBatch.findFirst({
        where: { id, wineryId },
        select: {
          lotId: true,
          fermentationTank: { select: { harvestBatchId: true } },
        },
      });
      if (!found) throw agingNotFound(id);
      const { lot, clock, membershipId } = await this.lockSourceLot(
        tx,
        wineryId,
        userId,
        found.lotId,
        found.fermentationTank.harvestBatchId,
      );
      const aging = await tx.wineAgingBatch.findUniqueOrThrow({
        where: { id },
      });
      if (
        aging.agingStatus !== AgingStatusEnum.AGING &&
        aging.agingStatus !== AgingStatusEnum.READY
      ) {
        throw sourceClosed('La crianza', aging.agingStatus);
      }
      const available = num(aging.volumeLiters);
      const discardedLiters = dto.discardedLiters ?? available;
      if (
        dto.discardedLiters !== undefined &&
        available !== null &&
        dto.discardedLiters > available + 1e-6
      ) {
        throw ruleError(
          ErrorCode.TRC_VOLUME_EXCEEDS_AVAILABLE,
          `La crianza tiene ${available} L: no se pueden descartar ${dto.discardedLiters} L`,
          [
            violation(
              ErrorCode.TRC_VOLUME_EXCEEDS_AVAILABLE,
              'Litros por encima de lo disponible',
              {
                field: 'discardedLiters',
                expected: available,
                actual: dto.discardedLiters,
                meta: {
                  available,
                  requested: dto.discardedLiters,
                  unit: 'L',
                  sourceId: aging.id,
                },
              },
            ),
          ],
        );
      }
      const reason = dto.reason.trim();
      const updated = await tx.wineAgingBatch.update({
        where: { id },
        data: {
          agingStatus: AgingStatusEnum.DISCARDED,
          discardedAt: clock.now,
          discardReason: reason,
        },
      });
      const stage = await refreshLotStage(tx, lot.id, clock.now);
      await appendLotEvent(tx, lot.id, {
        type: 'LOT_DISCARDED',
        // Las mermas y los motivos internos no son públicos (S-22)
        visibility: 'INTERNAL',
        occurredAt: clock.now,
        stage,
        actorMembershipId: membershipId,
        summary: `Crianza en ${aging.containerType} descartada${discardedLiters !== null ? ` (${formatQuantity(discardedLiters, 2)} L)` : ''}: ${reason}`,
        data: {
          scope: 'SOURCE',
          kind: 'AGING',
          sourceId: aging.id,
          discardedLiters,
          reason,
          unit: 'L',
        },
        resource: { type: 'wine_aging_batch', id: aging.id },
      });
      await this.reevaluate(tx, lot, clock);
      await this.audit.record(tx, {
        action: AuditAction.AGING_DISCARDED,
        resource: { type: 'wine_aging_batch', id: aging.id },
        organizationId: wineryId,
        before: { agingStatus: aging.agingStatus },
        after: {
          agingStatus: updated.agingStatus,
          discardedAt: updated.discardedAt,
          discardedLiters,
          lotId: lot.id,
          lotStage: stage,
        },
        reason,
      });
    }, AUDIT_TX_OPTIONS);
    return this.wineAging.findAgingBatchById(wineryId, id);
  }

  /**
   * Cierre de la destilación con sus cortes (§5.2): balance de masa, reposo
   * desde `processEndDate` con el mínimo de la **instantánea** del lote y, si
   * la fecha declarada ya lo cumple, candado liberado en el momento.
   */
  async closeDistillation(
    wineryId: string,
    userId: string,
    id: string,
    dto: CloseDistillationDto,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const found = await tx.productionBatch.findFirst({
        where: { id, wineryId },
        select: {
          lotId: true,
          fermentationTank: { select: { harvestBatchId: true } },
        },
      });
      if (!found) throw distillationNotFound(id);
      const { lot, clock, membershipId } = await this.lockSourceLot(
        tx,
        wineryId,
        userId,
        found.lotId,
        found.fermentationTank.harvestBatchId,
      );
      const batch = await tx.productionBatch.findUniqueOrThrow({
        where: { id },
      });
      if (
        batch.discardedAt ||
        batch.restStatus === RestStatusEnum.DISCARDED ||
        batch.restStatus === RestStatusEnum.BOTTLED
      ) {
        throw sourceClosed('La destilación', batch.restStatus);
      }
      if (batch.processEndDate) {
        throw stateError(
          ErrorCode.TRC_DISTILLATION_ALREADY_CLOSED,
          `La destilación ya se cerró el ${dateOnly(batch.processEndDate)}: sus cortes se corrigen con una corrección`,
          [
            violation(
              ErrorCode.TRC_DISTILLATION_ALREADY_CLOSED,
              'Destilación ya cerrada',
              { meta: { processEndDate: dateOnly(batch.processEndDate) } },
            ),
          ],
        );
      }

      // Fechas: ni futura ni anterior al inicio de la destilación
      const endDay = calendarDay(dto.processEndDate);
      assertDayNotFuture('processEndDate', endDay, clock);
      assertNotBefore(
        'processEndDate',
        endDay,
        dateOnly(batch.processStartDate),
        'La destilación no puede terminar antes de empezar',
      );

      // Balance de masa: cabezas + corazón + colas (+ vinaza) ≤ entrada
      const input = num(batch.inputVolumeLiters);
      if (input === null) {
        throw ruleError(
          ErrorCode.TRC_VOLUME_MISSING,
          'La destilación no tiene registrado su volumen de entrada: corrígelo antes de cerrarla',
          [
            violation(
              ErrorCode.TRC_VOLUME_MISSING,
              'Volumen de entrada sin registrar',
              {
                field: 'inputVolumeLiters',
                meta: { field: 'inputVolumeLiters' },
              },
            ),
          ],
        );
      }
      const cuts = {
        headsLiters: dto.cuts.headsLiters,
        heartLiters: dto.cuts.heartLiters,
        tailsLiters: dto.cuts.tailsLiters,
        vinasseLiters: dto.vinasseLiters ?? null,
      };
      const unbalanced = massBalanceViolation(input, cuts);
      if (unbalanced) {
        throw ruleError(
          ErrorCode.TRC_MASS_BALANCE_EXCEEDED,
          unbalanced.message,
          [unbalanced],
        );
      }

      const minRestDays = lot.rules.singani.minRestDays;
      const restUntil = addDays(endDay, minRestDays);
      const decimal = (v: number | null) =>
        v !== null ? new Prisma.Decimal(v) : null;
      const updated = await tx.productionBatch.update({
        where: { id },
        data: {
          processEndDate: toDbDate(endDay),
          headsLiters: decimal(cuts.headsLiters),
          heartLiters: decimal(cuts.heartLiters),
          tailsLiters: decimal(cuts.tailsLiters),
          vinasseLiters: decimal(cuts.vinasseLiters),
          heartAbvPercent: decimal(dto.heartAbvPercent),
          // Campos anteriores a la Ola 2, coherentes con los cortes
          outputVolumeLiters: decimal(cuts.heartLiters),
          wasteVolumeLiters: decimal(
            Math.round((cuts.headsLiters + cuts.tailsLiters) * 1000) / 1000,
          ),
          mandatoryRestUntil: toDbDate(restUntil),
          restStatus: RestStatusEnum.RESTING,
          ...(dto.notes !== undefined && { notes: dto.notes }),
        },
      });
      const pureAlcoholLiters =
        Math.round(cuts.heartLiters * dto.heartAbvPercent * 10) / 1000;
      const stage = await refreshLotStage(tx, lot.id, clock.now);
      await appendLotEvent(tx, lot.id, {
        type: 'DISTILLATION_CLOSED',
        occurredAt: toDbDate(endDay),
        stage,
        actorMembershipId: membershipId,
        summary: `Destilación cerrada: corazón de ${formatQuantity(cuts.heartLiters, 3)} L al ${dto.heartAbvPercent} %; reposo de ${minRestDays} días hasta ${restUntil}`,
        data: {
          headsLiters: cuts.headsLiters,
          heartLiters: cuts.heartLiters,
          tailsLiters: cuts.tailsLiters,
          vinasseLiters: cuts.vinasseLiters,
          heartAbvPercent: dto.heartAbvPercent,
          pureAlcoholLiters,
          inputLiters: input,
          outputLiters: cutsTotal(cuts),
          restUntil,
          rule: LOT_RULE_KEYS.minRestDays,
          minRestDays,
          unit: 'L',
        },
        resource: { type: 'production_batch', id },
      });
      await this.audit.record(tx, {
        action: AuditAction.DISTILLATION_CLOSED,
        resource: { type: 'production_batch', id },
        organizationId: wineryId,
        before: { processEndDate: null, restStatus: batch.restStatus },
        after: {
          processEndDate: endDay,
          cuts,
          heartAbvPercent: dto.heartAbvPercent,
          pureAlcoholLiters,
          mandatoryRestUntil: restUntil,
          restStatus: updated.restStatus,
          lotId: lot.id,
          lotStage: stage,
        },
      });
      // Registro tardío con el reposo ya cumplido: no espera a la tarea diaria
      await releaseDueLocks(tx, { ...lot, stage }, clock, this.audit);
    }, AUDIT_TX_OPTIONS);
    return this.productionBatches.findProductionBatchById(wineryId, id);
  }

  /** `→ DISCARDED`, con motivo (§5.2). */
  async discardDistillation(
    wineryId: string,
    userId: string,
    id: string,
    dto: DiscardProductionBatchDto,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const found = await tx.productionBatch.findFirst({
        where: { id, wineryId },
        select: {
          lotId: true,
          fermentationTank: { select: { harvestBatchId: true } },
        },
      });
      if (!found) throw distillationNotFound(id);
      const { lot, clock, membershipId } = await this.lockSourceLot(
        tx,
        wineryId,
        userId,
        found.lotId,
        found.fermentationTank.harvestBatchId,
      );
      const batch = await tx.productionBatch.findUniqueOrThrow({
        where: { id },
      });
      if (
        batch.discardedAt ||
        batch.restStatus === RestStatusEnum.DISCARDED ||
        batch.restStatus === RestStatusEnum.BOTTLED
      ) {
        throw sourceClosed('La destilación', batch.restStatus);
      }
      const reason = dto.reason.trim();
      const updated = await tx.productionBatch.update({
        where: { id },
        data: {
          restStatus: RestStatusEnum.DISCARDED,
          discardedAt: clock.now,
          discardReason: reason,
        },
      });
      const stage = await refreshLotStage(tx, lot.id, clock.now);
      await appendLotEvent(tx, lot.id, {
        type: 'LOT_DISCARDED',
        visibility: 'INTERNAL',
        occurredAt: clock.now,
        stage,
        actorMembershipId: membershipId,
        summary: `Destilación en ${batch.equipmentIdentifier} descartada: ${reason}`,
        data: {
          scope: 'SOURCE',
          kind: 'REST',
          sourceId: batch.id,
          reason,
        },
        resource: { type: 'production_batch', id: batch.id },
      });
      await this.reevaluate(tx, lot, clock);
      await this.audit.record(tx, {
        action: AuditAction.DISTILLATION_DISCARDED,
        resource: { type: 'production_batch', id: batch.id },
        organizationId: wineryId,
        before: { restStatus: batch.restStatus },
        after: {
          restStatus: updated.restStatus,
          discardedAt: updated.discardedAt,
          lotId: lot.id,
          lotStage: stage,
        },
        reason,
      });
    }, AUDIT_TX_OPTIONS);
    return this.productionBatches.findProductionBatchById(wineryId, id);
  }

  private async lockSourceLot(
    tx: Tx,
    wineryId: string,
    userId: string,
    lotId: string | null,
    harvestBatchId: string,
  ): Promise<{ lot: LockedLot; clock: DbClock; membershipId: string | null }> {
    const resolved = lotId ?? (await ensureHarvestLot(tx, harvestBatchId));
    if (!resolved) {
      throw new NotFoundException('El registro no pertenece a ningún lote');
    }
    const lot = await lockLot(tx, resolved, wineryId, { writable: true });
    const clock = await dbClock(tx);
    const membership = await actorMembership(tx, userId, wineryId);
    return { lot, clock, membershipId: membership?.id ?? null };
  }

  /**
   * Un descarte puede resolver una incidencia (p. ej. una fuente abierta en
   * un lote ya embotellado, §6.2.3): se reevalúan las abiertas.
   */
  private async reevaluate(tx: Tx, lot: LockedLot, clock: DbClock) {
    await reevaluateLotIssues(tx, lot.id, {
      violations: await lotIntegrity(tx, lot.id),
      record: [],
      source: 'RULES_REEVALUATION',
      correctionId: null,
      now: clock.now,
    });
  }
}

function agingNotFound(id: string): NotFoundException {
  return new NotFoundException(
    `Lote de crianza con ID ${id} no encontrado en esta bodega`,
  );
}

function distillationNotFound(id: string): NotFoundException {
  return new NotFoundException(
    `Lote de producción con ID ${id} no encontrado en esta bodega`,
  );
}

/** 409 `TRC_INVALID_STAGE`: la fuente ya está embotellada o descartada. */
function sourceClosed(label: string, status: string) {
  return stateError(
    ErrorCode.TRC_INVALID_STAGE,
    `${label} está ${status}: ya no admite esta acción`,
    [
      violation(ErrorCode.TRC_INVALID_STAGE, `Fuente ${status}`, {
        meta: { status },
      }),
    ],
  );
}
