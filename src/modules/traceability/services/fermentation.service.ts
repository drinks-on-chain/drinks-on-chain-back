import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '@shared/prisma/prisma.service';
import { AUDIT_TX_OPTIONS, AuditService } from '@shared/audit/audit.service';
import { AuditAction } from '@shared/audit/audit.actions';
import { ErrorCode } from '@shared/exceptions/error-codes';
import { ValidationException } from '@shared/exceptions/validation.exception';
import { AppException } from '@shared/exceptions/app.exception';
import { CreateFermentationTankDto } from '../dto/create-fermentation-tank.dto';
import { CreateFermentationLogDto } from '../dto/create-fermentation-log.dto';
import { CreateEnologicalTreatmentDto } from '../dto/create-enological-treatment.dto';
import { QueryTanksDto } from '../dto/query-tanks.dto';
import {
  Prisma,
  FermentationTank,
  FermentationLog,
  EnologicalTreatment,
  TankStatusEnum,
  DestinationTypeEnum,
} from '@prisma/client';
import { toPage, toPrismaPage } from '@shared/dto/pagination-query.dto';
import { createLotFromBody } from '@modules/lots/lots.service';
import {
  createLotRecord,
  lockLot,
  LockedLot,
  refreshLotStage,
} from '@modules/lots/lot-records';
import { appendLotEvent, formatQuantity } from '@modules/lots/lot-events';
import { actorMembership, dbClock, DbClock } from '@modules/lots/trace-db';
import {
  assertDestination,
  assertLotDo,
  assertStage,
  decideProductType,
  ensureHarvestLot,
} from '@modules/lots/chain';
import { laPazDate } from '@modules/lots/domain/dates';
import { TANK_VOLUME_INCLUDE, toTankViews } from '@modules/lots/tank-view';
import { LOT_RULE_KEYS } from '@modules/lots/domain/lot-rules';
import {
  ruleError,
  stateError,
  violation,
} from '@modules/lots/domain/trace-errors';
import type { ErrorDetail } from '@shared/interfaces/api-response.interface';

const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
/** Estados en los que un tanque admite lecturas y tratamientos (§4.4). */
const ACTIVE_TANK_STATUSES: readonly TankStatusEnum[] = [
  TankStatusEnum.FILLING,
  TankStatusEnum.FERMENTING,
  TankStatusEnum.COMPLETED,
];

@Injectable()
export class FermentationService {
  private readonly logger = new Logger(FermentationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Llenado de un tanque (contrato O2 §4.1): entradas del mismo lote con el
   * dictamen exigido por la instantánea (EA-04), kilos ≤ disponibles,
   * llenado ≤ capacidad, fecha coherente y código físico libre (S-7).
   */
  async createTank(
    wineryId: string,
    user: { id: string; role: string | null },
    dto: CreateFermentationTankDto,
  ) {
    const inputs =
      dto.inputs ??
      (dto.harvestBatchId ? [{ harvestBatchId: dto.harvestBatchId }] : []);
    if (inputs.length === 0) {
      throw ValidationException.forField(
        'inputs',
        'Indica al menos un pesaje (`inputs` o `harvestBatchId`)',
      );
    }
    if (new Set(inputs.map((i) => i.harvestBatchId)).size !== inputs.length) {
      throw ValidationException.forField(
        'inputs',
        'Un pesaje aparece dos veces',
      );
    }
    if (dto.lotId && dto.newLot) {
      throw new ValidationException([
        { field: 'lotId', message: 'Indica lotId o newLot, no ambos' },
        { field: 'newLot', message: 'Indica lotId o newLot, no ambos' },
      ]);
    }
    if (
      dto.status &&
      dto.status !== TankStatusEnum.FILLING &&
      dto.status !== TankStatusEnum.FERMENTING
    ) {
      throw ValidationException.forField(
        'status',
        'Un tanque nace en FILLING o FERMENTING: el resto de estados cambian con sus acciones (start, complete, clean)',
      );
    }
    if (
      dto.capacityLiters !== undefined &&
      dto.volumeFilledLiters !== undefined &&
      dto.volumeFilledLiters > dto.capacityLiters
    ) {
      throw ruleError(
        ErrorCode.TRC_TANK_CAPACITY_EXCEEDED,
        `El llenado (${dto.volumeFilledLiters} L) supera la capacidad del tanque (${dto.capacityLiters} L)`,
        [
          violation(
            ErrorCode.TRC_TANK_CAPACITY_EXCEEDED,
            'Llenado mayor que la capacidad',
            {
              field: 'volumeFilledLiters',
              expected: dto.capacityLiters,
              actual: dto.volumeFilledLiters,
              meta: { capacityLiters: dto.capacityLiters },
            },
          ),
        ],
      );
    }

    const tankId = await this.prisma.$transaction(async (tx) => {
      const clock = await dbClock(tx);
      const startDate = new Date(dto.startDate);
      assertNotFuture('startDate', startDate, clock);
      const membership = await actorMembership(tx, user.id, wineryId);

      // Pesajes de la bodega (los anteriores a la Ola 2 se rellenan al vuelo)
      for (const input of inputs) {
        const exists = await tx.harvestBatch.findFirst({
          where: { id: input.harvestBatchId, wineryId },
          select: { id: true },
        });
        if (!exists) {
          throw new NotFoundException(
            `Lote de vendimia con ID ${input.harvestBatchId} no encontrado en esta bodega`,
          );
        }
        await tx.$queryRaw`SELECT id FROM harvest_batches WHERE id = ${input.harvestBatchId}::uuid FOR UPDATE`;
        await ensureLegacyLot(tx, input.harvestBatchId);
      }
      const harvests = await tx.harvestBatch.findMany({
        where: { id: { in: inputs.map((i) => i.harvestBatchId) } },
        include: { terroir: true, tankInputs: { select: { kg: true } } },
      });
      const byId = new Map(harvests.map((h) => [h.id, h]));

      // Lote: `lotId`, `newLot` o el de las entradas (S-4: sin mezclar lotes)
      const inputLots = [
        ...new Set(
          harvests.map((h) => h.lotId).filter((l): l is string => !!l),
        ),
      ];
      let lot: LockedLot;
      if (dto.newLot) {
        if (!['OWNER', 'ENOLOGIST'].includes(user.role ?? '')) {
          throw new AppException(
            403,
            ErrorCode.AUTH_INSUFFICIENT_PERMISSIONS,
            'Solo la dirección y la enología crean lotes',
          );
        }
        const created = await createLotFromBody(
          tx,
          wineryId,
          dto.newLot,
          membership?.id ?? null,
          clock,
          'newLot',
        );
        lot = await lockLot(tx, created.id, wineryId, { writable: true });
      } else if (dto.lotId) {
        lot = await lockLot(tx, dto.lotId, wineryId, { writable: true });
      } else if (inputLots.length === 1) {
        lot = await lockLot(tx, inputLots[0], wineryId, { writable: true });
      } else if (inputLots.length === 0) {
        // Uva recibida sin lote y ninguno indicado: se crea el lote del tanque
        // (como hacía el ERP con su lote derivado por pesaje)
        const first = harvests[0];
        const created = await createLotRecord(tx, {
          wineryId,
          name: `${first.terroir.varietyName} ${first.harvestYear}`.slice(
            0,
            120,
          ),
          harvestYear: first.harvestYear,
          createdByMembershipId: membership?.id ?? null,
          origin: 'LOT_CREATION',
          takenAt: clock.now,
          summary: `Lote creado al llenar el tanque ${dto.tankCode} con uva sin lote`,
        });
        lot = await lockLot(tx, created.id, wineryId, { writable: true });
      } else {
        throw mixedLots(inputLots);
      }
      const foreign = harvests.filter((h) => h.lotId && h.lotId !== lot.id);
      if (foreign.length > 0) {
        throw mixedLots([lot.id, ...foreign.map((h) => h.lotId as string)]);
      }
      assertStage(lot, ['ORIGIN', 'HARVEST', 'FERMENTING'], 'nuevos tanques');

      // Tanque físico libre hasta limpiarlo (S-7)
      const busy = await tx.fermentationTank.findFirst({
        where: {
          wineryId,
          tankCode: dto.tankCode,
          status: { not: TankStatusEnum.CLEANED },
        },
        select: { id: true, status: true },
      });
      if (busy) {
        throw stateError(
          ErrorCode.TRC_TANK_CODE_IN_USE,
          `El tanque ${dto.tankCode} está ocupado (${busy.status}): límpialo antes de volver a llenarlo`,
          [
            violation(ErrorCode.TRC_TANK_CODE_IN_USE, 'Tanque ocupado', {
              field: 'tankCode',
              meta: { tankId: busy.id, status: busy.status },
            }),
          ],
        );
      }

      const wrongYear = harvests.filter(
        (h) => h.harvestYear !== lot.harvestYear,
      );
      if (wrongYear.length > 0) {
        throw ruleError(
          ErrorCode.TRC_HARVEST_YEAR_MISMATCH,
          'Hay pesajes de otra añada que la del lote',
          wrongYear.map((h) =>
            violation(
              ErrorCode.TRC_HARVEST_YEAR_MISMATCH,
              `${h.harvestBatchCode} es de ${h.harvestYear}`,
              {
                field: 'inputs',
                expected: lot.harvestYear,
                actual: h.harvestYear,
                meta: { harvestBatchId: h.id },
              },
            ),
          ),
        );
      }

      // Dictamen (R4, EA-04): APPROVED; PENDING solo si la instantánea no lo exige
      const allowed = lot.rules.phytosanitary.requireApproved
        ? ['APPROVED']
        : ['APPROVED', 'PENDING_INSPECTION'];
      const notApproved = harvests.filter(
        (h) => !allowed.includes(h.phytosanitaryStatus),
      );
      if (notApproved.length > 0) {
        throw ruleError(
          ErrorCode.TRC_PHYTO_NOT_APPROVED,
          'La uva necesita un dictamen fitosanitario aprobado para entrar a un tanque',
          notApproved.map((h) =>
            violation(
              ErrorCode.TRC_PHYTO_NOT_APPROVED,
              `${h.harvestBatchCode}: dictamen ${h.phytosanitaryStatus}`,
              {
                field: 'inputs',
                rule: LOT_RULE_KEYS.requireApproved,
                expected: allowed,
                actual: h.phytosanitaryStatus,
                meta: {
                  harvestBatchId: h.id,
                  harvestBatchCode: h.harvestBatchCode,
                  status: h.phytosanitaryStatus,
                },
              },
            ),
          ),
        );
      }

      // Kilos ≤ disponibles
      const kgByInput: { harvestBatchId: string; kg: number }[] = [];
      const volumeIssues: ErrorDetail[] = [];
      for (const [i, input] of inputs.entries()) {
        const h = byId.get(input.harvestBatchId)!;
        const used = h.tankInputs.reduce((s, t) => s + t.kg.toNumber(), 0);
        const available = Math.max(
          0,
          Math.round((h.netWeightKg.toNumber() - used) * 1000) / 1000,
        );
        const kg = input.kg ?? available;
        if (kg <= 0 || kg > available + 1e-6) {
          volumeIssues.push(
            violation(
              ErrorCode.TRC_VOLUME_EXCEEDS_AVAILABLE,
              `${h.harvestBatchCode}: quedan ${available} kg disponibles`,
              {
                field: `inputs.${i}.kg`,
                expected: available,
                actual: kg,
                meta: {
                  harvestBatchId: h.id,
                  available,
                  requested: kg,
                  unit: 'kg',
                },
              },
            ),
          );
        }
        kgByInput.push({ harvestBatchId: h.id, kg });
      }
      if (volumeIssues.length > 0) {
        throw ruleError(
          ErrorCode.TRC_VOLUME_EXCEEDS_AVAILABLE,
          'Kilos por encima de lo disponible',
          volumeIssues,
        );
      }

      // Fecha: no anterior al último ingreso de las entradas
      const lastIntake = harvests
        .map((h) => h.intakeDate.toISOString().slice(0, 10))
        .reduce((a, b) => (a > b ? a : b));
      if (laPazDate(startDate) < lastIntake) {
        throw ruleError(
          ErrorCode.TRC_DATE_BEFORE_PREVIOUS_STAGE,
          'El tanque no puede empezar antes del ingreso de la uva',
          [
            violation(
              ErrorCode.TRC_DATE_BEFORE_PREVIOUS_STAGE,
              'Fecha anterior al pesaje',
              {
                field: 'startDate',
                expected: lastIntake,
                actual: laPazDate(startDate),
                meta: { minimum: lastIntake },
              },
            ),
          ],
        );
      }

      // Bifurcación predeclarada (legado): coherente con el lote y D.O. si es singani
      const product = assertDestination(lot, dto.destinationType);

      for (const h of harvests) {
        if (!h.lotId) {
          await tx.harvestBatch.update({
            where: { id: h.id },
            data: { lotId: lot.id },
          });
        }
      }
      if (product) {
        await decideProductType(
          tx,
          lot,
          product,
          membership?.id ?? null,
          startDate,
          {
            type: 'lot',
            id: lot.id,
          },
        );
        if (product === 'SINGANI') await assertLotDo(tx, lot);
      }

      this.logger.log(
        `Registrando cuba de fermentación ${dto.tankCode} del lote ${lot.id}`,
      );
      const created = await tx.fermentationTank.create({
        data: {
          wineryId,
          harvestBatchId: inputs[0].harvestBatchId,
          tankCode: dto.tankCode,
          capacityLiters:
            dto.capacityLiters !== undefined
              ? new Prisma.Decimal(dto.capacityLiters)
              : null,
          material: dto.material,
          volumeFilledLiters:
            dto.volumeFilledLiters !== undefined
              ? new Prisma.Decimal(dto.volumeFilledLiters)
              : null,
          destinationType: (dto.destinationType ??
            null) as DestinationTypeEnum | null,
          status:
            dto.startFermentation || dto.status === TankStatusEnum.FERMENTING
              ? TankStatusEnum.FERMENTING
              : TankStatusEnum.FILLING,
          startDate,
          lotId: lot.id,
          createdByMembershipId: membership?.id ?? null,
        },
      });
      await tx.fermentationTankInput.createMany({
        data: kgByInput.map((i) => ({
          fermentationTankId: created.id,
          harvestBatchId: i.harvestBatchId,
          kg: new Prisma.Decimal(i.kg),
        })),
      });
      await appendLotEvent(tx, lot.id, {
        type: 'TANK_FILLED',
        occurredAt: startDate,
        stage: 'FERMENTING',
        actorMembershipId: membership?.id ?? null,
        summary: `Tanque ${dto.tankCode} lleno con ${formatQuantity(
          kgByInput.reduce((s, i) => s + i.kg, 0),
          3,
        )} kg${dto.volumeFilledLiters ? ` (${formatQuantity(dto.volumeFilledLiters, 2)} L de mosto)` : ''}`,
        data: {
          tankCode: dto.tankCode,
          inputs: kgByInput,
          volumeFilledLiters: dto.volumeFilledLiters ?? null,
          unit: 'L',
        },
        resource: { type: 'fermentation_tank', id: created.id },
      });
      await refreshLotStage(tx, lot.id, clock.now);
      await this.audit.record(tx, {
        action: AuditAction.FERMENTATION_TANK_CREATED,
        resource: { type: 'fermentation_tank', id: created.id },
        organizationId: wineryId,
        after: { ...created, inputs: kgByInput },
      });
      return created.id;
    }, AUDIT_TX_OPTIONS);
    return this.findTankById(wineryId, tankId);
  }

  async findTanks(wineryId: string | undefined, query: QueryTanksDto) {
    const where: Prisma.FermentationTankWhereInput = {
      ...(wineryId && { wineryId }),
      ...(query.status && { status: query.status }),
      ...(query.destinationType && { destinationType: query.destinationType }),
      ...(query.harvestBatchId && { harvestBatchId: query.harvestBatchId }),
    };

    const [items, total] = await Promise.all([
      this.prisma.fermentationTank.findMany({
        where,
        ...toPrismaPage(query),
        orderBy: [{ startDate: 'desc' }, { id: 'asc' }],
        include: {
          harvestBatch: true,
          inputs: { select: { harvestBatchId: true, kg: true } },
          ...TANK_VOLUME_INCLUDE,
        },
      }),
      this.prisma.fermentationTank.count({ where }),
    ]);

    return toPage(await toTankViews(this.prisma, items), total, query);
  }

  async findTankById(wineryId: string | undefined, id: string) {
    const tank = await this.prisma.fermentationTank.findFirst({
      where: {
        id,
        ...(wineryId && { wineryId }),
      },
      include: {
        harvestBatch: true,
        inputs: { select: { harvestBatchId: true, kg: true } },
        logs: {
          orderBy: { recordedAt: 'asc' },
        },
        treatments: {
          orderBy: { appliedAt: 'asc' },
        },
        ...TANK_VOLUME_INCLUDE,
      },
    });

    if (!tank) {
      throw new NotFoundException(
        `Cuba de fermentación con ID ${id} no encontrada en esta bodega`,
      );
    }

    return (await toTankViews(this.prisma, [tank]))[0];
  }

  /** Lectura (§4.4): solo en tanques activos, fecha entre el inicio y ahora. */
  async addLog(
    wineryId: string,
    tankId: string,
    userId: string,
    dto: CreateFermentationLogDto,
  ): Promise<FermentationLog> {
    return this.prisma.$transaction(async (tx) => {
      const { tank, lot, clock, membershipId } = await this.activeTank(
        tx,
        wineryId,
        tankId,
        userId,
      );
      const recordedAt = new Date(dto.recordedAt);
      assertNotFuture('recordedAt', recordedAt, clock);
      assertAfter('recordedAt', recordedAt, tank.startDate);
      this.logger.log(
        `Registrando log térmico (${dto.temperatureCelsius}°C) en cuba ${tankId}`,
      );
      const created = await tx.fermentationLog.create({
        data: {
          fermentationTankId: tankId,
          temperatureCelsius: new Prisma.Decimal(dto.temperatureCelsius),
          specificGravity:
            dto.specificGravity !== undefined
              ? new Prisma.Decimal(dto.specificGravity)
              : null,
          phValue:
            dto.phValue !== undefined ? new Prisma.Decimal(dto.phValue) : null,
          co2Observations: dto.co2Observations,
          recordedAt,
          recordedByUserId: userId,
          notes: dto.notes,
        },
      });
      if (lot) {
        await this.recordReadingsEvent(
          tx,
          lot,
          tank,
          recordedAt,
          membershipId,
          dto.temperatureCelsius,
        );
      }
      await this.audit.record(tx, {
        action: AuditAction.FERMENTATION_LOG_ADDED,
        resource: { type: 'fermentation_log', id: created.id },
        organizationId: wineryId,
        after: created,
      });
      return created;
    }, AUDIT_TX_OPTIONS);
  }

  /** Tratamiento (§4.4): solo inserción, hasta `COMPLETED`. */
  async addTreatment(
    wineryId: string,
    tankId: string,
    userId: string,
    dto: CreateEnologicalTreatmentDto,
  ): Promise<EnologicalTreatment> {
    const member = await this.prisma.wineryMember.findFirst({
      where: { userId, wineryId, isActive: true },
    });
    if (!member) {
      throw new ForbiddenException(
        'El usuario no es miembro activo acreditado de esta bodega',
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const { tank, lot, clock, membershipId } = await this.activeTank(
        tx,
        wineryId,
        tankId,
        userId,
      );
      const appliedAt = new Date(dto.appliedAt);
      assertNotFuture('appliedAt', appliedAt, clock);
      assertAfter('appliedAt', appliedAt, tank.startDate);
      this.logger.log(
        `Registrando tratamiento enológico "${dto.additiveName}" (${dto.dosageAppliedGPerHl} g/hL) en cuba ${tankId}`,
      );
      const created = await tx.enologicalTreatment.create({
        data: {
          fermentationTankId: tankId,
          treatmentType: dto.treatmentType,
          additiveName: dto.additiveName,
          additiveSupplier: dto.additiveSupplier,
          dosageAppliedGPerHl: new Prisma.Decimal(dto.dosageAppliedGPerHl),
          totalAppliedG:
            dto.totalAppliedG !== undefined
              ? new Prisma.Decimal(dto.totalAppliedG)
              : null,
          regulatoryAuthCode: dto.regulatoryAuthCode,
          appliedAt,
          authorizedByMemberId: member.id,
          notes: dto.notes,
        },
      });
      if (lot) {
        await appendLotEvent(tx, lot.id, {
          type: 'TREATMENT_APPLIED',
          occurredAt: appliedAt,
          stage: lot.stage,
          actorMembershipId: membershipId,
          summary: `Tratamiento ${dto.treatmentType} en ${tank.tankCode}: ${dto.additiveName} (${dto.regulatoryAuthCode})`,
          data: {
            treatmentType: dto.treatmentType,
            additiveName: dto.additiveName,
            regulatoryAuthCode: dto.regulatoryAuthCode,
            dosageAppliedGPerHl: dto.dosageAppliedGPerHl,
            unit: 'g/hL',
          },
          resource: { type: 'enological_treatment', id: created.id },
        });
        await tx.lot.update({
          where: { id: lot.id },
          data: { updatedAt: clock.now },
        });
      }
      await this.audit.record(tx, {
        action: AuditAction.ENOLOGICAL_TREATMENT_ADDED,
        resource: { type: 'enological_treatment', id: created.id },
        organizationId: wineryId,
        after: created,
      });
      return created;
    }, AUDIT_TX_OPTIONS);
  }

  private async activeTank(
    tx: Prisma.TransactionClient,
    wineryId: string,
    tankId: string,
    userId: string,
  ) {
    const tank = await tx.fermentationTank.findFirst({
      where: { id: tankId, wineryId },
    });
    if (!tank) {
      throw new NotFoundException(
        `Cuba de fermentación con ID ${tankId} no encontrada en esta bodega`,
      );
    }
    const lotId =
      tank.lotId ?? (await ensureLegacyLot(tx, tank.harvestBatchId));
    const lot = lotId
      ? await lockLot(tx, lotId, wineryId, { writable: true })
      : null;
    if (!ACTIVE_TANK_STATUSES.includes(tank.status)) {
      throw stateError(
        ErrorCode.TRC_TANK_NOT_ACTIVE,
        `El tanque ${tank.tankCode} está ${tank.status}: ya no admite registros`,
        [
          violation(ErrorCode.TRC_TANK_NOT_ACTIVE, 'Tanque cerrado', {
            meta: { status: tank.status, allowed: ACTIVE_TANK_STATUSES },
          }),
        ],
      );
    }
    const clock = await dbClock(tx);
    const membership = await actorMembership(tx, userId, wineryId);
    return { tank, lot, clock, membershipId: membership?.id ?? null };
  }

  /** Las lecturas diarias se agrupan en un evento por tanque y día (§11.1). */
  private async recordReadingsEvent(
    tx: Prisma.TransactionClient,
    lot: LockedLot,
    tank: FermentationTank,
    at: Date,
    actorMembershipId: string | null,
    temperature: number,
  ): Promise<void> {
    const day = laPazDate(at);
    const events = await tx.lotEvent.findMany({
      where: {
        lotId: lot.id,
        type: 'FERMENTATION_READINGS',
        resourceId: tank.id,
      },
      select: { id: true, data: true },
    });
    const existing = events.find(
      (e) => (e.data as Record<string, unknown>)?.day === day,
    );
    if (existing) {
      const data = existing.data as Record<string, unknown>;
      const count = Number(data.count ?? 0) + 1;
      await tx.lotEvent.update({
        where: { id: existing.id },
        data: {
          summary: `${count} lecturas en ${tank.tankCode}`,
          data: {
            ...data,
            count,
            lastTemperatureC: temperature,
          } as Prisma.InputJsonObject,
        },
      });
    } else {
      await appendLotEvent(tx, lot.id, {
        type: 'FERMENTATION_READINGS',
        occurredAt: at,
        stage: lot.stage,
        actorMembershipId,
        summary: `1 lectura en ${tank.tankCode}`,
        data: { day, count: 1, lastTemperatureC: temperature, unit: '°C' },
        resource: { type: 'fermentation_tank', id: tank.id },
      });
    }
    await tx.lot.update({
      where: { id: lot.id },
      data: { updatedAt: new Date() },
    });
  }
}

/** Lote de un pesaje anterior a la Ola 2 sin rellenar todavía (§2.6). */
async function ensureLegacyLot(
  tx: Prisma.TransactionClient,
  harvestBatchId: string,
): Promise<string | null> {
  const pending = await tx.lotBackfillPending.findUnique({
    where: { harvestBatchId },
    select: { harvestBatchId: true },
  });
  const harvest = await tx.harvestBatch.findUnique({
    where: { id: harvestBatchId },
    select: { lotId: true, _count: { select: { fermentationTanks: true } } },
  });
  if (!harvest || harvest.lotId) return harvest?.lotId ?? null;
  // Uva sin lote de la Ola 2 (sin tanques): se queda sin lote hasta el tanque
  if (!pending && harvest._count.fermentationTanks === 0) return null;
  return ensureHarvestLot(tx, harvestBatchId);
}

function mixedLots(lotIds: string[]) {
  return ruleError(
    ErrorCode.TRC_MIXED_LOTS,
    'Un tanque solo recibe uva de un lote (S-4)',
    [
      violation(ErrorCode.TRC_MIXED_LOTS, 'Entradas de lotes distintos', {
        field: 'inputs',
        meta: { lotIds: [...new Set(lotIds)] },
      }),
    ],
  );
}

function assertNotFuture(field: string, value: Date, clock: DbClock): void {
  if (value.getTime() > clock.now.getTime() + FUTURE_TOLERANCE_MS) {
    throw ruleError(
      ErrorCode.TRC_DATE_IN_FUTURE,
      'La fecha no puede ser futura',
      [
        violation(ErrorCode.TRC_DATE_IN_FUTURE, 'Fecha futura', {
          field,
          expected: clock.now.toISOString(),
          actual: value.toISOString(),
          meta: { field },
        }),
      ],
    );
  }
}

function assertAfter(field: string, value: Date, minimum: Date): void {
  if (value.getTime() < minimum.getTime()) {
    throw ruleError(
      ErrorCode.TRC_DATE_BEFORE_PREVIOUS_STAGE,
      'La fecha es anterior al inicio del tanque',
      [
        violation(
          ErrorCode.TRC_DATE_BEFORE_PREVIOUS_STAGE,
          'Fecha anterior al inicio del tanque',
          {
            field,
            expected: minimum.toISOString(),
            actual: value.toISOString(),
            meta: { minimum: minimum.toISOString() },
          },
        ),
      ],
    );
  }
}
