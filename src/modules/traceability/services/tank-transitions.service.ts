import { Injectable, NotFoundException } from '@nestjs/common';
import {
  DestinationTypeEnum,
  FermentationTank,
  Prisma,
  TankStatusEnum,
} from '@prisma/client';
import { AUDIT_TX_OPTIONS, AuditService } from '@shared/audit/audit.service';
import { AuditAction } from '@shared/audit/audit.actions';
import { ErrorCode } from '@shared/exceptions/error-codes';
import { PrismaService } from '@shared/prisma/prisma.service';
import {
  assertDestination,
  assertLotDo,
  assertStage,
  decideProductType,
  ensureHarvestLot,
} from '@modules/lots/chain';
import {
  assertDayNotFuture,
  assertInstantNotFuture,
  assertNotBefore,
  laPazNoon,
} from '@modules/lots/date-rules';
import { calendarDay, laPazDate } from '@modules/lots/domain/dates';
import { num } from '@modules/lots/domain/sources';
import {
  parseTankTransitions,
  StoredTankTransition,
  TankAction,
  TankStatus,
  tankTransitionViolation,
} from '@modules/lots/domain/tank-transitions';
import {
  ruleError,
  stateError,
  violation,
} from '@modules/lots/domain/trace-errors';
import { appendLotEvent, formatQuantity } from '@modules/lots/lot-events';
import { lockLot, LockedLot, refreshLotStage } from '@modules/lots/lot-records';
import { actorMembership, dbClock, DbClock } from '@modules/lots/trace-db';
import {
  CleanFermentationTankDto,
  CompleteFermentationTankDto,
  StartFermentationTankDto,
} from '@modules/lots/contract/dto/stage-actions.dto';
import { FermentationService } from './fermentation.service';

type Tx = Prisma.TransactionClient;

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Etapas del lote en las que un tanque todavía fermenta o se completa. */
const FERMENTATION_STAGES = [
  'HARVEST',
  'FERMENTING',
  'AGING',
  'DISTILLING',
  'RESTING',
] as const;

/**
 * Transiciones del tanque de fermentación (contrato O2 §4.2–§4.3): acciones,
 * no `PATCH`. Cada una bloquea la fila del lote, deja su evento en la línea
 * de tiempo y su entrada `TANK_TRANSITION` en la bitácora, en la misma
 * transacción.
 */
@Injectable()
export class TankTransitionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly fermentation: FermentationService,
  ) {}

  /** `FILLING → FERMENTING`. */
  async start(
    wineryId: string,
    userId: string,
    tankId: string,
    dto: StartFermentationTankDto,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const { tank, lot, clock, membershipId } = await this.load(
        tx,
        wineryId,
        userId,
        tankId,
        'start',
      );
      const startedAt = dto.startedAt ? instantOf(dto.startedAt) : clock.now;
      assertInstantNotFuture('startedAt', startedAt, clock);
      assertNotBefore(
        'startedAt',
        startedAt,
        tank.startDate,
        'La fermentación no puede empezar antes del llenado del tanque',
      );
      const updated = await tx.fermentationTank.update({
        where: { id: tank.id },
        data: {
          status: TankStatusEnum.FERMENTING,
          transitionLog: appendTransition(tank, {
            status: 'FERMENTING',
            at: startedAt.toISOString(),
            byMembershipId: membershipId,
          }),
        },
      });
      await appendLotEvent(tx, lot.id, {
        type: 'FERMENTATION_STARTED',
        occurredAt: startedAt,
        stage: lot.stage,
        actorMembershipId: membershipId,
        summary: `Fermentación iniciada en el tanque ${tank.tankCode}`,
        data: { tankCode: tank.tankCode },
        resource: { type: 'fermentation_tank', id: tank.id },
      });
      await refreshLotStage(tx, lot.id, clock.now);
      await this.recordTransition(tx, wineryId, tank, updated, startedAt);
    }, AUDIT_TX_OPTIONS);
    return this.fermentation.findTankById(wineryId, tankId);
  }

  /**
   * `FERMENTING → COMPLETED` con la **bifurcación** (§4.3): el destino debe
   * coincidir con el tipo del lote o lo fija (`PRODUCT_DECIDED`); con destino
   * singani, la D.O. se evalúa sobre todos los pesajes con la instantánea.
   */
  async complete(
    wineryId: string,
    userId: string,
    tankId: string,
    dto: CompleteFermentationTankDto,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const { tank, lot, clock, membershipId } = await this.load(
        tx,
        wineryId,
        userId,
        tankId,
        'complete',
      );
      assertStage(lot, FERMENTATION_STAGES, 'completar tanques');

      // Fin de la fermentación: ni futuro ni anterior al llenado
      const endDay = calendarDay(dto.endDate);
      assertDayNotFuture('endDate', endDay, clock);
      assertNotBefore(
        'endDate',
        endDay,
        laPazDate(tank.startDate),
        'La fermentación no puede terminar antes del llenado del tanque',
      );
      const endDate = endInstant(dto.endDate, endDay, tank.startDate, clock);

      // Volumen final ≤ llenado (la diferencia es la merma de fermentación)
      const filled = num(tank.volumeFilledLiters);
      if (filled !== null && dto.finalVolumeLiters > filled + 1e-6) {
        throw ruleError(
          ErrorCode.TRC_VOLUME_EXCEEDS_AVAILABLE,
          `El tanque ${tank.tankCode} se llenó con ${filled} L: el volumen final no puede ser mayor`,
          [
            violation(
              ErrorCode.TRC_VOLUME_EXCEEDS_AVAILABLE,
              'Volumen final mayor que el de llenado',
              {
                field: 'finalVolumeLiters',
                expected: filled,
                actual: dto.finalVolumeLiters,
                meta: {
                  available: filled,
                  requested: dto.finalVolumeLiters,
                  unit: 'L',
                  tankId: tank.id,
                },
              },
            ),
          ],
        );
      }

      // Bifurcación coherente con el destino (ERP-09)
      const product = assertDestination(lot, dto.destination, 'destination');
      if (product) {
        await decideProductType(tx, lot, product, membershipId, endDate, {
          type: 'fermentation_tank',
          id: tank.id,
        });
        if (product === 'SINGANI') await assertLotDo(tx, lot);
      }

      const updated = await tx.fermentationTank.update({
        where: { id: tank.id },
        data: {
          status: TankStatusEnum.COMPLETED,
          endDate,
          finalVolumeLiters: new Prisma.Decimal(dto.finalVolumeLiters),
          destinationType: dto.destination as DestinationTypeEnum,
          transitionLog: appendTransition(tank, {
            status: 'COMPLETED',
            at: endDate.toISOString(),
            byMembershipId: membershipId,
          }),
        },
      });
      const lossLiters =
        filled !== null
          ? Math.round((filled - dto.finalVolumeLiters) * 1000) / 1000
          : null;
      await appendLotEvent(tx, lot.id, {
        type: 'FERMENTATION_COMPLETED',
        occurredAt: endDate,
        stage: lot.stage,
        actorMembershipId: membershipId,
        summary: `Fermentación completada en ${tank.tankCode}: ${formatQuantity(dto.finalVolumeLiters, 2)} L con destino ${product === 'SINGANI' ? 'singani' : 'vino'}`,
        data: {
          tankCode: tank.tankCode,
          finalVolumeLiters: dto.finalVolumeLiters,
          lossLiters,
          destination: dto.destination,
          unit: 'L',
        },
        resource: { type: 'fermentation_tank', id: tank.id },
      });
      await refreshLotStage(tx, lot.id, clock.now);
      await this.recordTransition(tx, wineryId, tank, updated, endDate);
    }, AUDIT_TX_OPTIONS);
    return this.fermentation.findTankById(wineryId, tankId);
  }

  /**
   * `TRANSFERRED → CLEANED`: libera el `tankCode` (S-7). El tanque de un lote
   * descartado o rechazado se limpia desde cualquier estado (su contenido se
   * retiró con el lote); si no, su código físico quedaría ocupado para siempre.
   */
  async clean(
    wineryId: string,
    userId: string,
    tankId: string,
    dto: CleanFermentationTankDto,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const { tank, lot, clock, membershipId } = await this.load(
        tx,
        wineryId,
        userId,
        tankId,
        'clean',
      );
      const cleanedAt = dto.cleanedAt ? instantOf(dto.cleanedAt) : clock.now;
      assertInstantNotFuture('cleanedAt', cleanedAt, clock);
      assertNotBefore(
        'cleanedAt',
        cleanedAt,
        tank.endDate ?? tank.startDate,
        'El tanque no se puede limpiar antes de terminar su fermentación',
      );
      const updated = await tx.fermentationTank.update({
        where: { id: tank.id },
        data: {
          status: TankStatusEnum.CLEANED,
          transitionLog: appendTransition(tank, {
            status: 'CLEANED',
            at: cleanedAt.toISOString(),
            byMembershipId: membershipId,
          }),
        },
      });
      // La limpieza no es un hecho de la producción del lote (no tiene tipo
      // de evento en §11.1 y el lote puede estar cerrado): queda en el
      // historial del tanque y en la bitácora
      void lot;
      await this.recordTransition(tx, wineryId, tank, updated, cleanedAt);
    }, AUDIT_TX_OPTIONS);
    return this.fermentation.findTankById(wineryId, tankId);
  }

  /** Tanque de la bodega con su lote bloqueado y la transición comprobada. */
  private async load(
    tx: Tx,
    wineryId: string,
    userId: string,
    tankId: string,
    action: 'start' | 'complete',
  ): Promise<{
    tank: FermentationTank;
    lot: LockedLot;
    clock: DbClock;
    membershipId: string | null;
  }>;
  private async load(
    tx: Tx,
    wineryId: string,
    userId: string,
    tankId: string,
    action: 'clean',
  ): Promise<{
    tank: FermentationTank;
    lot: LockedLot | null;
    clock: DbClock;
    membershipId: string | null;
  }>;
  private async load(
    tx: Tx,
    wineryId: string,
    userId: string,
    tankId: string,
    action: TankAction,
  ) {
    const found = await tx.fermentationTank.findFirst({
      where: { id: tankId, wineryId },
      select: { id: true, lotId: true, harvestBatchId: true },
    });
    if (!found) throw tankNotFound(tankId);
    const lotId =
      found.lotId ?? (await ensureHarvestLot(tx, found.harvestBatchId));
    // Limpiar no escribe en el lote: vale aunque esté cerrado o descartado
    const lot = lotId
      ? await lockLot(tx, lotId, wineryId, { writable: action !== 'clean' })
      : null;
    if (!lot && action !== 'clean') {
      throw new NotFoundException('El tanque no pertenece a ningún lote');
    }
    // Con la fila del lote bloqueada, el estado del tanque ya no cambia
    await tx.$queryRaw`SELECT id FROM fermentation_tanks WHERE id = ${tankId}::uuid FOR UPDATE`;
    const tank = await tx.fermentationTank.findUniqueOrThrow({
      where: { id: tankId },
    });
    const withdrawn =
      action === 'clean' &&
      tank.status !== TankStatusEnum.CLEANED &&
      (lot?.stage === 'DISCARDED' || lot?.stage === 'REJECTED');
    const invalid = withdrawn
      ? null
      : tankTransitionViolation(
          action,
          tank.status as TankStatus,
          tank.tankCode,
        );
    if (invalid) {
      throw stateError(ErrorCode.TRC_TANK_INVALID_TRANSITION, invalid.message, [
        invalid,
      ]);
    }
    const clock = await dbClock(tx);
    const membership = await actorMembership(tx, userId, wineryId);
    return { tank, lot, clock, membershipId: membership?.id ?? null };
  }

  private async recordTransition(
    tx: Tx,
    wineryId: string,
    before: FermentationTank,
    after: FermentationTank,
    at: Date,
  ): Promise<void> {
    await this.audit.record(tx, {
      action: AuditAction.TANK_TRANSITION,
      resource: { type: 'fermentation_tank', id: after.id },
      organizationId: wineryId,
      before: {
        status: before.status,
        endDate: before.endDate,
        finalVolumeLiters: before.finalVolumeLiters,
        destinationType: before.destinationType,
      },
      after: {
        status: after.status,
        at: at.toISOString(),
        endDate: after.endDate,
        finalVolumeLiters: after.finalVolumeLiters,
        destinationType: after.destinationType,
        lotId: after.lotId,
        tankCode: after.tankCode,
      },
    });
  }
}

function tankNotFound(tankId: string): NotFoundException {
  return new NotFoundException(
    `Cuba de fermentación con ID ${tankId} no encontrada en esta bodega`,
  );
}

function instantOf(value: string): Date {
  return YMD.test(value) ? laPazNoon(value) : new Date(value);
}

/**
 * Instante del fin de la fermentación: el enviado, o el mediodía de La Paz de
 * un día de calendario (sin salirse del intervalo llenado–ahora).
 */
function endInstant(
  raw: string,
  day: string,
  startDate: Date,
  clock: DbClock,
): Date {
  if (!YMD.test(raw)) {
    const instant = new Date(raw);
    assertInstantNotFuture('endDate', instant, clock);
    assertNotBefore(
      'endDate',
      instant,
      startDate,
      'La fermentación no puede terminar antes del llenado del tanque',
    );
    return instant;
  }
  const noon = laPazNoon(day).getTime();
  return new Date(
    Math.min(Math.max(noon, startDate.getTime()), clock.now.getTime()),
  );
}

/** Historial guardado más una transición (JSON de `transition_log`). */
export function appendTransition(
  tank: { transitionLog: Prisma.JsonValue },
  transition: StoredTankTransition,
): Prisma.InputJsonArray {
  return [
    ...parseTankTransitions(tank.transitionLog),
    transition,
  ] as unknown as Prisma.InputJsonArray;
}
