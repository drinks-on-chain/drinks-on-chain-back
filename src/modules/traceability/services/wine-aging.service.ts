import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '@shared/prisma/prisma.service';
import { AUDIT_TX_OPTIONS, AuditService } from '@shared/audit/audit.service';
import { AuditAction } from '@shared/audit/audit.actions';
import { CreateWineAgingBatchDto } from '../dto/create-wine-aging-batch.dto';
import { Prisma, WineAgingBatch, AgingStatusEnum } from '@prisma/client';
import {
  PaginationQueryDto,
  toPage,
  toPrismaPage,
} from '@shared/dto/pagination-query.dto';
import { ConflictException as AppConflictException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';
import { lockLot, refreshLotStage } from '@modules/lots/lot-records';
import { appendLotEvent, formatQuantity } from '@modules/lots/lot-events';
import { actorMembership, dbClock } from '@modules/lots/trace-db';
import {
  assertDestination,
  assertStage,
  assertTankIsSource,
  decideProductType,
  ensureHarvestLot,
  tankAvailableLiters,
  transferTank,
} from '@modules/lots/chain';
import { laPazNoon } from '@modules/lots/date-rules';
import {
  addMonths,
  calendarDay,
  dateOnly,
  laPazDate,
  toDbDate,
} from '@modules/lots/domain/dates';
import { agingLock, LotLock } from '@modules/lots/domain/locks';
import { LOT_RULE_KEYS, parseLotRules } from '@modules/lots/domain/lot-rules';
import { num } from '@modules/lots/domain/sources';
import { ruleError, violation } from '@modules/lots/domain/trace-errors';
import { markRows } from '@modules/lots/correction-marks';

type AgingView<T> = T & {
  unlockDate: string;
  lock: LotLock | null;
  availableLiters: number | null;
};

@Injectable()
export class WineAgingService {
  private readonly logger = new Logger(WineAgingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Crianza (contrato O2 §5.1): tanque de un lote de vino, meses ≥ mínimo de
   * la instantánea, volumen ≤ disponible del tanque y candado de meses de
   * calendario desde el inicio (America/La_Paz).
   */
  async createAgingBatch(
    wineryId: string,
    userId: string,
    dto: CreateWineAgingBatchDto,
  ) {
    const id = await this.prisma.$transaction(async (tx) => {
      const tank = await tx.fermentationTank.findFirst({
        where: { id: dto.fermentationTankId, wineryId },
        include: { wineAgingBatch: true },
      });
      if (!tank) {
        throw new NotFoundException(
          `Cuba de fermentación con ID ${dto.fermentationTankId} no encontrada en esta bodega`,
        );
      }
      const lotId =
        tank.lotId ?? (await ensureHarvestLot(tx, tank.harvestBatchId));
      if (!lotId) {
        throw new NotFoundException('El tanque no pertenece a ningún lote');
      }
      const lot = await lockLot(tx, lotId, wineryId, { writable: true });
      if (tank.wineAgingBatch) {
        throw new AppConflictException(
          ErrorCode.FERMENTATION_TANK_ALREADY_TRANSFERRED,
          `La cuba ${tank.tankCode} ya ha sido transferida a un lote de crianza previo`,
        );
      }
      assertTankIsSource(tank);
      assertStage(lot, ['FERMENTING', 'AGING'], 'crianzas');
      assertDestination(
        lot,
        tank.destinationType ?? 'WINE_AGING',
        'fermentationTankId',
      );

      // Meses ≥ mínimo de la instantánea del lote
      const minimum = lot.rules.wine.minAgingMonths;
      if (dto.plannedMonths < minimum) {
        throw ruleError(
          ErrorCode.TRC_AGING_BELOW_MINIMUM,
          `La crianza mínima del lote es de ${minimum} meses`,
          [
            violation(
              ErrorCode.TRC_AGING_BELOW_MINIMUM,
              'Crianza bajo el mínimo',
              {
                field: 'plannedMonths',
                rule: LOT_RULE_KEYS.minAgingMonths,
                expected: minimum,
                actual: dto.plannedMonths,
              },
            ),
          ],
        );
      }

      // Volumen ≤ disponible del tanque (la diferencia es merma de trasiego)
      const available = await tankAvailableLiters(tx, tank.id);
      if (available !== null && dto.volumeLiters > available + 1e-6) {
        throw ruleError(
          ErrorCode.TRC_VOLUME_EXCEEDS_AVAILABLE,
          `Del tanque ${tank.tankCode} quedan ${available} L`,
          [
            violation(
              ErrorCode.TRC_VOLUME_EXCEEDS_AVAILABLE,
              'Litros por encima de lo disponible',
              {
                field: 'volumeLiters',
                expected: available,
                actual: dto.volumeLiters,
                meta: {
                  available,
                  requested: dto.volumeLiters,
                  unit: 'L',
                  tankId: tank.id,
                },
              },
            ),
          ],
        );
      }

      const clock = await dbClock(tx);
      const startDay = dto.startDate ? calendarDay(dto.startDate) : clock.today;
      if (startDay > clock.today) {
        throw ruleError(
          ErrorCode.TRC_DATE_IN_FUTURE,
          'La fecha no puede ser futura',
          [
            violation(ErrorCode.TRC_DATE_IN_FUTURE, 'Fecha futura', {
              field: 'startDate',
              expected: clock.today,
              actual: startDay,
            }),
          ],
        );
      }
      const minimumStart = laPazDate(tank.endDate ?? tank.startDate);
      if (startDay < minimumStart) {
        throw ruleError(
          ErrorCode.TRC_DATE_BEFORE_PREVIOUS_STAGE,
          'La crianza no puede empezar antes que el tanque',
          [
            violation(
              ErrorCode.TRC_DATE_BEFORE_PREVIOUS_STAGE,
              'Fecha anterior al tanque',
              {
                field: 'startDate',
                expected: minimumStart,
                actual: startDay,
                meta: { minimum: minimumStart },
              },
            ),
          ],
        );
      }
      const unlockDate = addMonths(
        startDay,
        Math.max(dto.plannedMonths, minimum),
      );
      const membership = await actorMembership(tx, userId, wineryId);
      this.logger.log(
        `Iniciando crianza de vino en ${dto.containerType} por ${dto.plannedMonths} meses (bloqueado hasta ${unlockDate})`,
      );

      await decideProductType(
        tx,
        lot,
        'WINE',
        membership?.id ?? null,
        toDbDate(startDay),
        {
          type: 'fermentation_tank',
          id: tank.id,
        },
      );
      const created = await tx.wineAgingBatch.create({
        data: {
          wineryId,
          fermentationTankId: dto.fermentationTankId,
          containerType: dto.containerType,
          containerMaterial: dto.containerMaterial,
          containerCode: dto.containerCode,
          barrelUseCycle: dto.barrelUseCycle,
          containerCount: dto.containerCount ?? null,
          volumeLiters: new Prisma.Decimal(dto.volumeLiters),
          plannedMonths: dto.plannedMonths,
          startDate: toDbDate(startDay),
          lockUntilDate: toDbDate(unlockDate),
          agingStatus: AgingStatusEnum.AGING,
          notes: dto.notes,
          lotId: lot.id,
          createdByMembershipId: membership?.id ?? null,
        },
      });
      // → TRANSFERRED al crear la crianza del tanque (§4.2)
      await transferTank(
        tx,
        tank,
        'WINE_AGING',
        laPazNoon(startDay),
        membership?.id ?? null,
      );
      await appendLotEvent(tx, lot.id, {
        type: 'AGING_STARTED',
        occurredAt: toDbDate(startDay),
        stage: 'AGING',
        actorMembershipId: membership?.id ?? null,
        summary: `Crianza en ${dto.containerType} de ${formatQuantity(dto.volumeLiters, 2)} L por ${dto.plannedMonths} meses (hasta ${unlockDate})`,
        data: {
          plannedMonths: dto.plannedMonths,
          volumeLiters: dto.volumeLiters,
          unlockDate,
          unit: 'L',
        },
        resource: { type: 'wine_aging_batch', id: created.id },
      });
      await refreshLotStage(tx, lot.id, clock.now);
      await this.audit.record(tx, {
        action: AuditAction.WINE_AGING_BATCH_CREATED,
        resource: { type: 'wine_aging_batch', id: created.id },
        organizationId: wineryId,
        after: created,
      });
      return created.id;
    }, AUDIT_TX_OPTIONS);
    return this.findAgingBatchById(wineryId, id);
  }

  async findAgingBatchById(wineryId: string | undefined, id: string) {
    const batch = await this.prisma.wineAgingBatch.findFirst({
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
        `Lote de crianza con ID ${id} no encontrado en esta bodega`,
      );
    }
    const { today } = await dbClock(this.prisma);
    return (
      await markRows(this.prisma, 'WINE_AGING', [withLock(batch, today)])
    )[0];
  }

  async findAll(wineryId: string | undefined, query: PaginationQueryDto) {
    const where: Prisma.WineAgingBatchWhereInput = {
      ...(wineryId && { wineryId }),
    };

    const [items, total] = await Promise.all([
      this.prisma.wineAgingBatch.findMany({
        where,
        ...toPrismaPage(query),
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        include: {
          lot: { select: { rules: true } },
          fermentationTank: true,
          bottlingBatches: { select: { id: true } },
        },
      }),
      this.prisma.wineAgingBatch.count({ where }),
    ]);
    const { today } = await dbClock(this.prisma);
    return toPage(
      await markRows(
        this.prisma,
        'WINE_AGING',
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

/** Candado (con la instantánea del lote) y litros aún sin embotellar. */
function withLock<
  T extends WineAgingBatch & {
    lot: { rules: Prisma.JsonValue } | null;
    bottlingBatches: { id: string }[];
  },
>(batch: T, today: string): AgingView<Omit<T, 'lot'>> {
  const { lot, ...rest } = batch;
  const startDate = batch.startDate
    ? dateOnly(batch.startDate)
    : laPazDate(batch.createdAt);
  const lock = lot
    ? agingLock(
        {
          id: batch.id,
          startDate,
          plannedMonths: batch.plannedMonths,
          storedUnlockDate: dateOnly(batch.lockUntilDate),
        },
        parseLotRules(lot.rules),
        today,
      )
    : null;
  return {
    ...rest,
    unlockDate: lock?.unlockDate ?? dateOnly(batch.lockUntilDate),
    lock,
    availableLiters:
      batch.bottlingBatches.length > 0 || batch.agingStatus === 'DISCARDED'
        ? 0
        : num(batch.volumeLiters),
  };
}
