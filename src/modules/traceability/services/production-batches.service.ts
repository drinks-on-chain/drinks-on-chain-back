import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '@shared/prisma/prisma.service';
import { AUDIT_TX_OPTIONS, AuditService } from '@shared/audit/audit.service';
import { AuditAction } from '@shared/audit/audit.actions';
import { ErrorCode } from '@shared/exceptions/error-codes';
import { CreateDistillationBatchDto } from '../dto/create-distillation-batch.dto';
import { QueryProductionBatchesDto } from '../dto/query-production-batches.dto';
import {
  Prisma,
  ProductionBatch,
  ProductionProcessEnum,
  RestStatusEnum,
} from '@prisma/client';
import { toPage, toPrismaPage } from '@shared/dto/pagination-query.dto';
import { lockLot, refreshLotStage } from '@modules/lots/lot-records';
import { appendLotEvent, formatQuantity } from '@modules/lots/lot-events';
import { actorMembership, dbClock } from '@modules/lots/trace-db';
import {
  assertDestination,
  assertLotDo,
  assertStage,
  assertTankIsSource,
  decideProductType,
  tankAvailableLiters,
  transferTank,
} from '@modules/lots/chain';
import { laPazNoon } from '@modules/lots/date-rules';
import {
  calendarDay,
  dateOnly,
  daysBetween,
  laPazDate,
  toDbDate,
} from '@modules/lots/domain/dates';
import { LotLock, restLock } from '@modules/lots/domain/locks';
import { parseLotRules } from '@modules/lots/domain/lot-rules';
import { distillationHeart } from '@modules/lots/domain/sources';
import { ruleError, violation } from '@modules/lots/domain/trace-errors';
import { markRows } from '@modules/lots/correction-marks';

type DistillationView<T> = T & {
  lock: LotLock | null;
  pureAlcoholLiters: number | null;
  availableLiters: number | null;
};

@Injectable()
export class ProductionBatchesService {
  private readonly logger = new Logger(ProductionBatchesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Abre una destilación del singani (contrato O2 §5.2): tanque completado
   * con destino singani, D.O. calculada en el servidor sobre todos los
   * pesajes del lote con su instantánea (EA-03) y entrada ≤ lo disponible del
   * tanque. Los cortes, el grado del corazón y el reposo llegan con el cierre
   * (`POST …/close`).
   */
  async createDistillationBatch(
    wineryId: string,
    userId: string,
    dto: CreateDistillationBatchDto,
  ) {
    const id = await this.prisma.$transaction(async (tx) => {
      const tank = await tx.fermentationTank.findFirst({
        where: { id: dto.fermentationTankId, wineryId },
      });
      if (!tank) {
        throw new NotFoundException(
          `Cuba de fermentación con ID ${dto.fermentationTankId} no encontrada en esta bodega`,
        );
      }
      const lot = await lockLot(tx, tank.lotId, wineryId, { writable: true });
      assertTankIsSource(tank);
      assertStage(
        lot,
        ['FERMENTING', 'DISTILLING', 'RESTING'],
        'destilaciones',
      );
      assertDestination(
        lot,
        tank.destinationType ?? 'SINGANI_DIST',
        'fermentationTankId',
      );
      const membership = await actorMembership(tx, userId, wineryId);
      const clock = await dbClock(tx);

      // D.O. del lote con la instantánea antes que nada (EA-03)
      const startDay = calendarDay(dto.processStartDate);
      await decideProductType(
        tx,
        lot,
        'SINGANI',
        membership?.id ?? null,
        toDbDate(startDay),
        {
          type: 'fermentation_tank',
          id: tank.id,
        },
      );
      await assertLotDo(tx, lot);

      // Fechas: inicio no futuro ni anterior al fin de la fermentación
      if (startDay > clock.today) {
        throw ruleError(
          ErrorCode.TRC_DATE_IN_FUTURE,
          'La fecha no puede ser futura',
          [
            violation(ErrorCode.TRC_DATE_IN_FUTURE, 'Fecha futura', {
              field: 'processStartDate',
              expected: clock.today,
              actual: startDay,
            }),
          ],
        );
      }
      const tankEnd = laPazDate(tank.endDate ?? tank.startDate);
      if (startDay < tankEnd) {
        throw ruleError(
          ErrorCode.TRC_DATE_BEFORE_PREVIOUS_STAGE,
          'Fecha anterior a la etapa previa',
          [
            violation(
              ErrorCode.TRC_DATE_BEFORE_PREVIOUS_STAGE,
              'Fecha anterior a la etapa previa',
              {
                field: 'processStartDate',
                expected: tankEnd,
                actual: startDay,
                meta: { minimum: tankEnd },
              },
            ),
          ],
        );
      }

      // Entrada ≤ disponible del tanque
      const available = await tankAvailableLiters(tx, tank.id);
      if (available !== null && dto.inputVolumeLiters > available + 1e-6) {
        throw ruleError(
          ErrorCode.TRC_VOLUME_EXCEEDS_AVAILABLE,
          `Del tanque ${tank.tankCode} quedan ${available} L`,
          [
            violation(
              ErrorCode.TRC_VOLUME_EXCEEDS_AVAILABLE,
              'Litros por encima de lo disponible',
              {
                field: 'inputVolumeLiters',
                expected: available,
                actual: dto.inputVolumeLiters,
                meta: {
                  available,
                  requested: dto.inputVolumeLiters,
                  unit: 'L',
                  tankId: tank.id,
                },
              },
            ),
          ],
        );
      }

      this.logger.log(
        `Registrando lote de destilación en ${dto.equipmentIdentifier} para bodega ${wineryId}`,
      );
      const created = await tx.productionBatch.create({
        data: {
          wineryId,
          fermentationTankId: dto.fermentationTankId,
          processType: ProductionProcessEnum.SINGANI_DISTILLATION,
          equipmentIdentifier: dto.equipmentIdentifier,
          processStartDate: toDbDate(startDay),
          inputVolumeLiters: new Prisma.Decimal(dto.inputVolumeLiters),
          initialAlcoholPercentage:
            dto.initialAlcoholPercentage !== undefined
              ? new Prisma.Decimal(dto.initialAlcoholPercentage)
              : null,
          // D.O. calculada sobre el lote (acaba de comprobarse)
          isDoEligible: true,
          // El reposo se abre al cerrar la destilación (§5.2)
          restStatus: RestStatusEnum.NOT_REQUIRED,
          notes: dto.notes,
          lotId: lot.id,
          createdByMembershipId: membership?.id ?? null,
        },
      });
      await appendLotEvent(tx, lot.id, {
        type: 'DISTILLATION_STARTED',
        occurredAt: toDbDate(startDay),
        stage: 'DISTILLING',
        actorMembershipId: membership?.id ?? null,
        summary: `Destilación en ${dto.equipmentIdentifier} de ${formatQuantity(dto.inputVolumeLiters, 3)} L`,
        data: { inputVolumeLiters: dto.inputVolumeLiters, unit: 'L' },
        resource: { type: 'production_batch', id: created.id },
      });
      // → TRANSFERRED al agotarse el tanque o con `closeTank` (§4.2)
      const remaining = await tankAvailableLiters(tx, tank.id);
      if (dto.closeTank === true || (remaining !== null && remaining <= 1e-6)) {
        await transferTank(
          tx,
          tank,
          'SINGANI_DIST',
          laPazNoon(startDay),
          membership?.id ?? null,
        );
      }
      await refreshLotStage(tx, lot.id, clock.now);
      await this.audit.record(tx, {
        action: AuditAction.PRODUCTION_BATCH_CREATED,
        resource: { type: 'production_batch', id: created.id },
        organizationId: wineryId,
        after: created,
      });
      return created.id;
    }, AUDIT_TX_OPTIONS);
    return this.findProductionBatchById(wineryId, id);
  }

  /** Reposo (§5.2) con la instantánea del lote y el reloj de la base. */
  async getRestStatus(
    wineryId: string | undefined,
    id: string,
  ): Promise<{
    id: string;
    restStatus: RestStatusEnum;
    processEndDate: Date | null;
    mandatoryRestUntil: Date | null;
    daysElapsed: number;
    daysRemaining: number;
    isRestCompleted: boolean;
  }> {
    const batch = await this.findProductionBatchById(wineryId, id);
    if (!batch.processEndDate || !batch.lock) {
      return {
        id: batch.id,
        restStatus: batch.restStatus,
        processEndDate: batch.processEndDate,
        mandatoryRestUntil: batch.mandatoryRestUntil,
        daysElapsed: 0,
        daysRemaining: 0,
        isRestCompleted: false,
      };
    }
    const { today } = await dbClock(this.prisma);
    const daysElapsed = Math.max(
      0,
      daysBetween(dateOnly(batch.processEndDate), today),
    );
    const released = batch.lock.released;
    return {
      id: batch.id,
      restStatus:
        released && batch.restStatus === RestStatusEnum.RESTING
          ? RestStatusEnum.READY
          : batch.restStatus,
      processEndDate: batch.processEndDate,
      mandatoryRestUntil: toDbDate(batch.lock.unlockDate),
      daysElapsed,
      daysRemaining: batch.lock.daysRemaining,
      isRestCompleted: released,
    };
  }

  async findProductionBatchById(wineryId: string | undefined, id: string) {
    const batch = await this.prisma.productionBatch.findFirst({
      where: {
        id,
        ...(wineryId && { wineryId }),
      },
      include: {
        lot: { select: { rules: true } },
        fermentationTank: {
          include: {
            harvestBatch: {
              include: { terroir: true },
            },
          },
        },
        bottlingBatches: true,
      },
    });

    if (!batch) {
      throw new NotFoundException(
        `Lote de producción con ID ${id} no encontrado en esta bodega`,
      );
    }
    const { today } = await dbClock(this.prisma);
    return (
      await markRows(this.prisma, 'PRODUCTION_BATCH', [withLock(batch, today)])
    )[0];
  }

  async findAll(
    wineryId: string | undefined,
    query: QueryProductionBatchesDto,
  ) {
    const where: Prisma.ProductionBatchWhereInput = {
      ...(wineryId && { wineryId }),
      ...(query.processType && { processType: query.processType }),
      ...(query.restStatus && { restStatus: query.restStatus }),
      ...(query.fermentationTankId && {
        fermentationTankId: query.fermentationTankId,
      }),
    };

    const [items, total] = await Promise.all([
      this.prisma.productionBatch.findMany({
        where,
        ...toPrismaPage(query),
        orderBy: [{ processStartDate: 'desc' }, { id: 'asc' }],
        include: {
          lot: { select: { rules: true } },
          fermentationTank: true,
          bottlingBatches: { select: { id: true } },
        },
      }),
      this.prisma.productionBatch.count({ where }),
    ]);
    const { today } = await dbClock(this.prisma);
    return toPage(
      await markRows(
        this.prisma,
        'PRODUCTION_BATCH',
        items.map((i) => {
          // La lista no trae los embotellados (solo se usan para el cálculo)
          const { bottlingBatches: _b, ...view } = withLock(i, today);
          void _b;
          return view;
        }),
      ),
      total,
      query,
    );
  }
}

function withLock<
  T extends ProductionBatch & {
    lot: { rules: Prisma.JsonValue } | null;
    bottlingBatches: { id: string }[];
  },
>(batch: T, today: string): DistillationView<Omit<T, 'lot'>> {
  const { lot, ...rest } = batch;
  const lock = lot
    ? restLock(
        {
          id: batch.id,
          processEndDate: batch.processEndDate
            ? dateOnly(batch.processEndDate)
            : null,
          storedUnlockDate: batch.mandatoryRestUntil
            ? dateOnly(batch.mandatoryRestUntil)
            : null,
        },
        parseLotRules(lot.rules),
        today,
      )
    : null;
  const heart = distillationHeart(batch);
  return {
    ...rest,
    lock,
    pureAlcoholLiters:
      heart.liters !== null && heart.abv !== null
        ? Math.round(heart.liters * heart.abv * 10) / 1000
        : null,
    availableLiters:
      batch.bottlingBatches.length > 0 || batch.discardedAt
        ? 0
        : batch.processEndDate
          ? heart.liters
          : null,
  };
}
