import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '@shared/prisma/prisma.service';
import { CreateHarvestBatchDto } from './dto/create-harvest-batch.dto';
import { UpdatePhytoStatusDto } from './dto/update-phyto-status.dto';
import { QueryHarvestBatchesDto } from './dto/query-harvest-batches.dto';
import {
  CreateMaturityAnalysisDto,
  CreatePhytoDecisionDto,
  PHYTO_DECISIONS,
  PhytoDecisionValue,
} from './dto/phyto-decision.dto';
import { Prisma, PhytoStatusEnum } from '@prisma/client';
import {
  PaginationQueryDto,
  toPage,
  toPrismaPage,
} from '@shared/dto/pagination-query.dto';
import type { Paginated } from '@shared/interfaces/api-response.interface';
import { ValidationException } from '@shared/exceptions/validation.exception';
import { AppException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';
import { AUDIT_TX_OPTIONS, AuditService } from '@shared/audit/audit.service';
import { AuditAction } from '@shared/audit/audit.actions';
import { createLotFromBody } from '@modules/lots/lots.service';
import { lockLot, LockedLot, refreshLotStage } from '@modules/lots/lot-records';
import { appendLotEvent, formatQuantity } from '@modules/lots/lot-events';
import {
  actorMembership,
  dbClock,
  DbClock,
  nextSequence,
} from '@modules/lots/trace-db';
import {
  actorOf,
  resolveTraceActors,
  TraceActor,
} from '@modules/lots/trace-actors';
import { parseLotRules } from '@modules/lots/domain/lot-rules';
import {
  doRulesFromLot,
  DoEvaluation,
  doViolations,
  evaluateDo,
} from '@modules/lots/domain/do-evaluation';
import {
  calendarDay,
  daysBetween,
  laPazDate,
} from '@modules/lots/domain/dates';
import {
  ruleError,
  stateError,
  violation,
} from '@modules/lots/domain/trace-errors';
import type { LotStage } from '@modules/lots/domain/lot-stage';
import {
  CorrectionMarks,
  correctionMarks,
  markRows,
  withMarks,
} from '@modules/lots/correction-marks';

/** Etapas del lote que aún admiten pesajes (§3.2). */
const HARVEST_STAGES: readonly LotStage[] = ['ORIGIN', 'HARVEST', 'FERMENTING'];
/** Tolerancia de los instantes futuros (§0). */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
/** Registro tardío: más de 7 días entre el hecho y el registro (S-9). */
const LATE_ENTRY_DAYS = 7;

const HARVEST_INCLUDE = {
  terroir: true,
  lot: { select: { productType: true, rules: true } },
  maturityAnalyses: {
    where: { voidedAt: null },
    orderBy: [{ measuredAt: 'asc' }, { recordedAt: 'asc' }],
  },
  phytoDecisions: {
    where: { voidedAt: null },
    orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
  },
  tankInputs: { select: { kg: true } },
} satisfies Prisma.HarvestBatchInclude;

type HarvestRow = Prisma.HarvestBatchGetPayload<{
  include: typeof HARVEST_INCLUDE;
}>;

type Maturity = {
  brixDegrees: number;
  ph: number;
  acidityGl: number;
  measuredAt?: string;
};

@Injectable()
export class HarvestBatchesService {
  private readonly logger = new Logger(HarvestBatchesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Pesaje (contrato O2 §3.2): sin dictamen en el alta (EA-04), con lote
   * existente, nuevo (`newLot`) o sin lote (uva recibida); el código de
   * vendimia sale de la secuencia por bodega y año con bloqueo de fila
   * (EA-07); el análisis de madurez es opcional y se guarda aparte.
   */
  async create(
    wineryId: string,
    user: { id: string; role: string | null },
    dto: CreateHarvestBatchDto,
  ) {
    if (
      dto.phytosanitaryStatus !== undefined &&
      dto.phytosanitaryStatus !== PhytoStatusEnum.PENDING_INSPECTION
    ) {
      throw ruleError(
        ErrorCode.TRC_PHYTO_IN_CREATE,
        'El dictamen fitosanitario no se registra en el alta del pesaje: usa POST /v1/harvest-batches/{id}/phyto-decisions',
        [
          violation(
            ErrorCode.TRC_PHYTO_IN_CREATE,
            'Dictamen en el alta del pesaje',
            {
              field: 'phytosanitaryStatus',
              expected: PhytoStatusEnum.PENDING_INSPECTION,
              actual: dto.phytosanitaryStatus,
            },
          ),
        ],
      );
    }
    if (dto.lotId && dto.newLot) {
      throw new ValidationException([
        { field: 'lotId', message: 'Indica lotId o newLot, no ambos' },
        { field: 'newLot', message: 'Indica lotId o newLot, no ambos' },
      ]);
    }
    if (dto.newLot && !['OWNER', 'ENOLOGIST'].includes(user.role ?? '')) {
      throw new AppException(
        403,
        ErrorCode.AUTH_INSUFFICIENT_PERMISSIONS,
        'Solo la dirección y la enología crean lotes (newLot)',
      );
    }
    if (dto.grossWeightKg <= dto.tareWeightKg) {
      throw ValidationException.forField(
        'grossWeightKg',
        'El peso bruto debe ser estrictamente mayor al peso tara',
      );
    }
    const maturity = maturityOf(dto);
    const netWeight = dto.grossWeightKg - dto.tareWeightKg;

    const id = await this.prisma.$transaction(async (tx) => {
      const clock = await dbClock(tx);
      const intakeDay = calendarDay(dto.intakeDate);
      if (intakeDay > clock.today) {
        throw futureDate('intakeDate', intakeDay, clock.today);
      }
      if (maturity?.measuredAt) {
        assertNotFuture(
          'maturity.measuredAt',
          new Date(maturity.measuredAt),
          clock,
        );
      }
      const terroir = await tx.terroir.findFirst({
        where: { id: dto.terroirId, wineryId },
      });
      if (!terroir) {
        throw new NotFoundException(
          `Parcela con ID ${dto.terroirId} no encontrada en esta bodega`,
        );
      }
      const membership = await actorMembership(tx, user.id, wineryId);

      // Lote: existente, nuevo o ninguno
      let lot: LockedLot | null = null;
      if (dto.newLot) {
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
      }
      if (lot && !HARVEST_STAGES.includes(lot.stage)) {
        throw stateError(
          ErrorCode.TRC_INVALID_STAGE,
          `El lote está en etapa ${lot.stage}: ya no admite pesajes`,
          [
            violation(
              ErrorCode.TRC_INVALID_STAGE,
              'Etapa del lote sin pesajes',
              {
                field: 'lotId',
                meta: { stage: lot.stage, allowed: HARVEST_STAGES },
              },
            ),
          ],
        );
      }
      const harvestYear =
        dto.harvestYear ?? lot?.harvestYear ?? Number(intakeDay.slice(0, 4));
      if (lot && harvestYear !== lot.harvestYear) {
        throw ruleError(
          ErrorCode.TRC_HARVEST_YEAR_MISMATCH,
          `El pesaje es de la añada ${harvestYear} y el lote de la ${lot.harvestYear}`,
          [
            violation(
              ErrorCode.TRC_HARVEST_YEAR_MISMATCH,
              'Añada distinta de la del lote',
              {
                field: 'harvestYear',
                expected: lot.harvestYear,
                actual: harvestYear,
              },
            ),
          ],
        );
      }
      if (lot?.productType === 'SINGANI') {
        const evaluation = evaluateDo(
          [
            {
              id: terroir.id,
              altitudeMasl: terroir.altitudeMasl.toNumber(),
              varietyName: terroir.varietyName,
            },
          ],
          doRulesFromLot(lot.rules),
          'LOT_SNAPSHOT',
          clock.now,
        );
        if (evaluation.status === 'NOT_ELIGIBLE') {
          throw ruleError(
            ErrorCode.TRC_DO_TERROIR_NOT_ELIGIBLE,
            `La parcela ${terroir.parcelName} no es apta para la D.O. Singani del lote`,
            doViolations(evaluation, ErrorCode.TRC_DO_TERROIR_NOT_ELIGIBLE, {
              [terroir.id]: terroir.parcelName,
            }),
          );
        }
      }

      // Código de vendimia con la secuencia de la bodega (EA-07)
      const seq = await nextSequence(tx, wineryId, harvestYear, 'HARVEST');
      const terroirSlug = terroir.parcelName
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, 8);
      const harvestBatchCode = `HARV-${harvestYear}-${terroirSlug || 'PARCELA'}-${String(seq).padStart(3, '0')}`;
      this.logger.log(
        `Registrando lote de vendimia "${harvestBatchCode}" (${netWeight} kg netos)`,
      );

      const created = await tx.harvestBatch.create({
        data: {
          wineryId,
          terroirId: dto.terroirId,
          harvestBatchCode,
          intakeDate: new Date(`${intakeDay}T00:00:00.000Z`),
          harvestYear,
          grossWeightKg: new Prisma.Decimal(dto.grossWeightKg),
          tareWeightKg: new Prisma.Decimal(dto.tareWeightKg),
          netWeightKg: new Prisma.Decimal(netWeight),
          brixDegrees: maturity
            ? new Prisma.Decimal(maturity.brixDegrees)
            : null,
          initialPh: maturity ? new Prisma.Decimal(maturity.ph) : null,
          initialAcidityGl: maturity
            ? new Prisma.Decimal(maturity.acidityGl)
            : null,
          temperatureAtIntakeC:
            dto.temperatureAtIntakeC !== undefined
              ? new Prisma.Decimal(dto.temperatureAtIntakeC)
              : null,
          phytosanitaryStatus: PhytoStatusEnum.PENDING_INSPECTION,
          notes: dto.notes,
          lotId: lot?.id ?? null,
          terroirSnapshot: {
            parcelName: terroir.parcelName,
            altitudeMasl: terroir.altitudeMasl.toNumber(),
            varietyName: terroir.varietyName,
            rawMaterialType: terroir.rawMaterialType,
            takenAt: clock.now.toISOString(),
          },
          createdByMembershipId: membership?.id ?? null,
        },
      });
      let analysisId: string | null = null;
      if (maturity) {
        const analysis = await tx.maturityAnalysis.create({
          data: {
            harvestBatchId: created.id,
            brixDegrees: new Prisma.Decimal(maturity.brixDegrees),
            ph: new Prisma.Decimal(maturity.ph),
            acidityGl: new Prisma.Decimal(maturity.acidityGl),
            measuredAt: maturity.measuredAt
              ? new Date(maturity.measuredAt)
              : created.intakeDate,
            recordedByMembershipId: membership?.id ?? null,
          },
        });
        analysisId = analysis.id;
      }
      if (lot) {
        await appendLotEvent(tx, lot.id, {
          type: 'HARVEST_WEIGHED',
          occurredAt: created.intakeDate,
          stage: 'HARVEST',
          actorMembershipId: membership?.id ?? null,
          summary: `Pesaje de ${formatQuantity(netWeight, 3)} kg desde ${terroir.parcelName}`,
          data: { netWeightKg: netWeight, unit: 'kg', harvestBatchCode },
          resource: { type: 'harvest_batch', id: created.id },
        });
        if (maturity && analysisId) {
          await appendLotEvent(tx, lot.id, {
            type: 'MATURITY_ANALYZED',
            occurredAt: maturity.measuredAt
              ? new Date(maturity.measuredAt)
              : created.intakeDate,
            stage: 'HARVEST',
            actorMembershipId: membership?.id ?? null,
            summary: `Análisis de madurez: ${maturity.brixDegrees} °Bx, pH ${maturity.ph}, acidez ${maturity.acidityGl} g/L`,
            data: { ...maturity },
            resource: { type: 'maturity_analysis', id: analysisId },
          });
        }
        await refreshLotStage(tx, lot.id, clock.now);
      }
      await this.audit.record(tx, {
        action: AuditAction.HARVEST_BATCH_CREATED,
        resource: { type: 'harvest_batch', id: created.id },
        organizationId: wineryId,
        after: created,
      });
      return created.id;
    }, AUDIT_TX_OPTIONS);
    return this.findById(wineryId, id);
  }

  async findAll(wineryId: string | undefined, query: QueryHarvestBatchesDto) {
    const where: Prisma.HarvestBatchWhereInput = {
      ...(wineryId && { wineryId }),
      ...(query.harvestYear && { harvestYear: query.harvestYear }),
      ...(query.terroirId && { terroirId: query.terroirId }),
      ...(query.phytosanitaryStatus && {
        phytosanitaryStatus: query.phytosanitaryStatus,
      }),
      ...(query.lotId === 'none'
        ? { lotId: null }
        : query.lotId
          ? { lotId: query.lotId }
          : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.harvestBatch.findMany({
        where,
        ...toPrismaPage(query),
        orderBy: [{ intakeDate: 'desc' }, { id: 'asc' }],
        include: HARVEST_INCLUDE,
      }),
      this.prisma.harvestBatch.count({ where }),
    ]);
    const actors = await resolveTraceActors(this.prisma, actorIds(items));
    const now = new Date();
    return toPage(
      await this.withCorrections(
        items.map((row) => toHarvestView(row, actors, now)),
      ),
      total,
      query,
    );
  }

  async findById(wineryId: string | undefined, id: string) {
    const batch = await this.prisma.harvestBatch.findFirst({
      where: {
        id,
        ...(wineryId && { wineryId }),
      },
      include: {
        ...HARVEST_INCLUDE,
        fermentationTanks: true,
      },
    });

    if (!batch) {
      throw new NotFoundException(
        `Lote de vendimia con ID ${id} no encontrado en esta bodega`,
      );
    }
    const actors = await resolveTraceActors(this.prisma, actorIds([batch]));
    const [view] = await this.withCorrections([
      toHarvestView(batch, actors, new Date()),
    ]);
    return { ...view, fermentationTanks: batch.fermentationTanks };
  }

  /** Marcas de corrección del pesaje, de sus análisis y de sus dictámenes (§9). */
  private async withCorrections(views: HarvestView[]): Promise<
    (Omit<HarvestView, 'maturityAnalyses' | 'phytoDecisions'> &
      CorrectionMarks & {
        maturityAnalyses: (MaturityView & CorrectionMarks)[];
        phytoDecisions: (PhytoDecisionView & CorrectionMarks)[];
      })[]
  > {
    const [harvests, analyses, decisions] = await Promise.all([
      correctionMarks(
        this.prisma,
        'HARVEST_BATCH',
        views.map((v) => v.id),
      ),
      correctionMarks(
        this.prisma,
        'MATURITY_ANALYSIS',
        views.flatMap((v) => v.maturityAnalyses.map((m) => m.id)),
      ),
      correctionMarks(
        this.prisma,
        'PHYTO_DECISION',
        views.flatMap((v) => v.phytoDecisions.map((d) => d.id)),
      ),
    ]);
    return views.map((view) => ({
      ...withMarks(view, harvests),
      maturityAnalyses: view.maturityAnalyses.map((m) =>
        withMarks(m, analyses),
      ),
      phytoDecisions: view.phytoDecisions.map((d) => withMarks(d, decisions)),
    }));
  }

  /** Ruta legada `PATCH …/phyto-status`: alias del dictamen (§3.4). */
  async updatePhytoStatus(
    wineryId: string,
    id: string,
    userId: string | null,
    dto: UpdatePhytoStatusDto,
  ) {
    if (
      !(PHYTO_DECISIONS as readonly string[]).includes(dto.phytosanitaryStatus)
    ) {
      throw ValidationException.forField(
        'phytosanitaryStatus',
        `Un dictamen es ${PHYTO_DECISIONS.join(', ')}: PENDING_INSPECTION no es un dictamen`,
      );
    }
    return this.decide(
      wineryId,
      id,
      userId,
      {
        decision: dto.phytosanitaryStatus as PhytoDecisionValue,
        notes: dto.notes,
      },
      { legacyPdfUrl: dto.phytoInspectionPdfUrl },
    );
  }

  /**
   * Dictamen fitosanitario (§3.4, EA-04): solo inserción; `APPROVED` y
   * `REJECTED` son finales y nada cambia una vez que la uva entró a un tanque.
   */
  async decide(
    wineryId: string,
    id: string,
    userId: string | null,
    dto: CreatePhytoDecisionDto,
    options: { legacyPdfUrl?: string } = {},
  ) {
    const notes = dto.notes?.trim() || null;
    if (
      (dto.decision === 'REJECTED' || dto.decision === 'QUARANTINE') &&
      !notes
    ) {
      throw ValidationException.forField(
        'notes',
        'Indica el motivo del rechazo o de la cuarentena',
      );
    }
    if (
      dto.inspectionReportKey &&
      !dto.inspectionReportKey.startsWith(`org/${wineryId}/`)
    ) {
      throw ruleError(
        ErrorCode.TRC_FILE_NOT_FOUND,
        'El informe de inspección no existe o no es de esta bodega',
        [
          violation(ErrorCode.TRC_FILE_NOT_FOUND, 'Archivo no encontrado', {
            field: 'inspectionReportKey',
          }),
        ],
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM harvest_batches WHERE id = ${id}::uuid FOR UPDATE`;
      const harvest = await tx.harvestBatch.findFirst({
        where: { id, wineryId },
        include: {
          _count: { select: { fermentationTanks: true, tankInputs: true } },
        },
      });
      if (!harvest) {
        throw new NotFoundException(
          `Lote de vendimia con ID ${id} no encontrado en esta bodega`,
        );
      }
      const lot = harvest.lotId
        ? await lockLot(tx, harvest.lotId, wineryId, { writable: true })
        : null;
      const current = harvest.phytosanitaryStatus;
      const inTank =
        harvest._count.fermentationTanks > 0 || harvest._count.tankInputs > 0;
      if (current === 'APPROVED' || current === 'REJECTED' || inTank) {
        throw stateError(
          ErrorCode.TRC_PHYTO_DECISION_FINAL,
          inTank
            ? 'La uva ya entró a un tanque: el dictamen no se puede cambiar'
            : `El dictamen ${current} es final`,
          [
            violation(ErrorCode.TRC_PHYTO_DECISION_FINAL, 'Dictamen final', {
              field: 'decision',
              meta: { status: current, inTank },
            }),
          ],
        );
      }
      const clock = await dbClock(tx);
      const decidedAt = dto.decidedAt ? new Date(dto.decidedAt) : clock.now;
      assertNotFuture('decidedAt', decidedAt, clock);
      const intakeDay = harvest.intakeDate.toISOString().slice(0, 10);
      if (laPazDate(decidedAt) < intakeDay) {
        throw ruleError(
          ErrorCode.TRC_DATE_BEFORE_PREVIOUS_STAGE,
          'El dictamen no puede ser anterior al pesaje',
          [
            violation(
              ErrorCode.TRC_DATE_BEFORE_PREVIOUS_STAGE,
              'Fecha anterior al pesaje',
              {
                field: 'decidedAt',
                expected: intakeDay,
                actual: laPazDate(decidedAt),
                meta: { minimum: intakeDay },
              },
            ),
          ],
        );
      }
      const membership = await actorMembership(tx, userId, wineryId);
      const legacyMember = membership
        ? await tx.wineryMember.findUnique({
            where: { id: membership.id },
            select: { id: true },
          })
        : null;
      const decision = await tx.phytoDecision.create({
        data: {
          harvestBatchId: id,
          decision: dto.decision,
          decidedAt,
          decidedByMembershipId: membership?.id ?? null,
          inspectionReportKey: dto.inspectionReportKey ?? null,
          notes,
          source: 'ERP',
        },
      });
      const updated = await tx.harvestBatch.update({
        where: { id },
        data: {
          phytosanitaryStatus: dto.decision,
          // `certifiedByMemberId` = autor del último dictamen (§3.4)
          certifiedByMemberId: legacyMember?.id ?? null,
          ...(options.legacyPdfUrl && {
            phytoInspectionPdfUrl: options.legacyPdfUrl,
          }),
        },
      });
      if (lot) {
        await appendLotEvent(tx, lot.id, {
          type: 'PHYTO_DECIDED',
          occurredAt: decidedAt,
          stage: lot.stage,
          actorMembershipId: membership?.id ?? null,
          summary: `Dictamen fitosanitario de ${harvest.harvestBatchCode}: ${dto.decision}`,
          data: {
            decision: dto.decision,
            harvestBatchCode: harvest.harvestBatchCode,
          },
          resource: { type: 'phyto_decision', id: decision.id },
        });
        const stage = await refreshLotStage(tx, lot.id, clock.now);
        if (stage === 'REJECTED' && lot.stage !== 'REJECTED') {
          await appendLotEvent(tx, lot.id, {
            type: 'LOT_REJECTED',
            occurredAt: decidedAt,
            stage,
            actorMembershipId: null,
            summary:
              'Lote rechazado: todos sus pesajes tienen dictamen negativo',
            resource: { type: 'lot', id: lot.id },
          });
        }
      }
      await this.audit.record(tx, {
        action: AuditAction.PHYTO_DECIDED,
        resource: { type: 'harvest_batch', id },
        organizationId: wineryId,
        before: { phytosanitaryStatus: current },
        after: {
          phytosanitaryStatus: updated.phytosanitaryStatus,
          decisionId: decision.id,
          inspectionReportKey: decision.inspectionReportKey,
          phytoInspectionPdfUrl: updated.phytoInspectionPdfUrl,
          certifiedByMemberId: updated.certifiedByMemberId,
        },
        reason: notes,
      });
    }, AUDIT_TX_OPTIONS);
    return this.findById(wineryId, id);
  }

  async listDecisions(
    wineryId: string | undefined,
    id: string,
    query: PaginationQueryDto,
  ): Promise<Paginated<PhytoDecisionView & CorrectionMarks>> {
    await this.assertExists(wineryId, id);
    const where = { harvestBatchId: id };
    const [rows, total] = await Promise.all([
      this.prisma.phytoDecision.findMany({
        where,
        ...toPrismaPage(query),
        orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.phytoDecision.count({ where }),
    ]);
    const actors = await resolveTraceActors(
      this.prisma,
      rows.map((r) => r.decidedByMembershipId),
    );
    return toPage(
      await markRows(
        this.prisma,
        'PHYTO_DECISION',
        rows.map((r) => toDecisionView(r, actors)),
      ),
      total,
      query,
    );
  }

  /** Análisis de madurez (§3.3): solo inserción; el último es el vigente. */
  async addMaturityAnalysis(
    wineryId: string,
    id: string,
    userId: string,
    dto: CreateMaturityAnalysisDto,
  ): Promise<MaturityView> {
    const analysisId = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM harvest_batches WHERE id = ${id}::uuid FOR UPDATE`;
      const harvest = await tx.harvestBatch.findFirst({
        where: { id, wineryId },
      });
      if (!harvest) {
        throw new NotFoundException(
          `Lote de vendimia con ID ${id} no encontrado en esta bodega`,
        );
      }
      const lot = harvest.lotId
        ? await lockLot(tx, harvest.lotId, wineryId, { writable: true })
        : null;
      const clock = await dbClock(tx);
      const measuredAt = new Date(dto.measuredAt);
      assertNotFuture('measuredAt', measuredAt, clock);
      const membership = await actorMembership(tx, userId, wineryId);
      const analysis = await tx.maturityAnalysis.create({
        data: {
          harvestBatchId: id,
          brixDegrees: new Prisma.Decimal(dto.brixDegrees),
          ph: new Prisma.Decimal(dto.ph),
          acidityGl: new Prisma.Decimal(dto.acidityGl),
          measuredAt,
          recordedByMembershipId: membership?.id ?? null,
          notes: dto.notes?.trim() || null,
        },
      });
      // El pesaje refleja el último análisis (por fecha de medición)
      const latest = await tx.maturityAnalysis.findFirst({
        where: { harvestBatchId: id, voidedAt: null },
        orderBy: [{ measuredAt: 'desc' }, { recordedAt: 'desc' }],
      });
      if (latest) {
        await tx.harvestBatch.update({
          where: { id },
          data: {
            brixDegrees: latest.brixDegrees,
            initialPh: latest.ph,
            initialAcidityGl: latest.acidityGl,
          },
        });
      }
      if (lot) {
        await appendLotEvent(tx, lot.id, {
          type: 'MATURITY_ANALYZED',
          occurredAt: measuredAt,
          stage: lot.stage,
          actorMembershipId: membership?.id ?? null,
          summary: `Análisis de madurez de ${harvest.harvestBatchCode}: ${dto.brixDegrees} °Bx, pH ${dto.ph}, acidez ${dto.acidityGl} g/L`,
          data: {
            brixDegrees: dto.brixDegrees,
            ph: dto.ph,
            acidityGl: dto.acidityGl,
          },
          resource: { type: 'maturity_analysis', id: analysis.id },
        });
        await tx.lot.update({
          where: { id: lot.id },
          data: { updatedAt: clock.now },
        });
      }
      await this.audit.record(tx, {
        action: AuditAction.MATURITY_ANALYZED,
        resource: { type: 'maturity_analysis', id: analysis.id },
        organizationId: wineryId,
        after: { ...analysis, harvestBatchId: id },
      });
      return analysis.id;
    }, AUDIT_TX_OPTIONS);
    const row = await this.prisma.maturityAnalysis.findUniqueOrThrow({
      where: { id: analysisId },
    });
    const actors = await resolveTraceActors(this.prisma, [
      row.recordedByMembershipId,
    ]);
    return toMaturityView(row, actors);
  }

  async listMaturityAnalyses(
    wineryId: string | undefined,
    id: string,
    query: PaginationQueryDto,
  ): Promise<Paginated<MaturityView & CorrectionMarks>> {
    await this.assertExists(wineryId, id);
    const where = { harvestBatchId: id, voidedAt: null };
    const [rows, total] = await Promise.all([
      this.prisma.maturityAnalysis.findMany({
        where,
        ...toPrismaPage(query),
        orderBy: [{ measuredAt: 'asc' }, { recordedAt: 'asc' }],
      }),
      this.prisma.maturityAnalysis.count({ where }),
    ]);
    const actors = await resolveTraceActors(
      this.prisma,
      rows.map((r) => r.recordedByMembershipId),
    );
    return toPage(
      await markRows(
        this.prisma,
        'MATURITY_ANALYSIS',
        rows.map((r) => toMaturityView(r, actors)),
      ),
      total,
      query,
    );
  }

  private async assertExists(wineryId: string | undefined, id: string) {
    const found = await this.prisma.harvestBatch.findFirst({
      where: { id, ...(wineryId && { wineryId }) },
      select: { id: true },
    });
    if (!found) {
      throw new NotFoundException(
        `Lote de vendimia con ID ${id} no encontrado en esta bodega`,
      );
    }
  }
}

// ── Vistas ──────────────────────────────────────────────────────────────────

export interface PhytoDecisionView {
  id: string;
  harvestBatchId: string;
  decision: string;
  decidedAt: string;
  recordedAt: string;
  decidedBy: TraceActor | null;
  inspectionReport: {
    key: string;
    sha256: string | null;
    url: string | null;
  } | null;
  notes: string | null;
  source: string;
}

export interface MaturityView {
  id: string;
  harvestBatchId: string;
  brixDegrees: number;
  ph: number;
  acidityGl: number;
  measuredAt: string;
  recordedAt: string;
  recordedBy: TraceActor | null;
  notes: string | null;
  source: string;
}

export type HarvestView = Omit<
  HarvestRow,
  | 'lot'
  | 'maturityAnalyses'
  | 'phytoDecisions'
  | 'tankInputs'
  | 'brixDegrees'
  | 'initialPh'
  | 'initialAcidityGl'
> & {
  brixDegrees: Prisma.Decimal | null;
  initialPh: Prisma.Decimal | null;
  initialAcidityGl: Prisma.Decimal | null;
  maturityAnalyses: MaturityView[];
  phytoDecisions: PhytoDecisionView[];
  availableKg: number;
  doEvaluation: DoEvaluation | null;
  lateEntry: boolean;
};

function actorIds(rows: HarvestRow[]): string[] {
  return rows
    .flatMap((r) => [
      ...r.maturityAnalyses.map((m) => m.recordedByMembershipId),
      ...r.phytoDecisions.map((d) => d.decidedByMembershipId),
    ])
    .filter((x): x is string => !!x);
}

function toDecisionView(
  d: Prisma.PhytoDecisionGetPayload<object>,
  actors: Map<string, TraceActor>,
): PhytoDecisionView {
  return {
    id: d.id,
    harvestBatchId: d.harvestBatchId,
    decision: d.decision,
    decidedAt: d.decidedAt.toISOString(),
    recordedAt: d.recordedAt.toISOString(),
    decidedBy: actorOf(actors, d.decidedByMembershipId),
    inspectionReport: d.inspectionReportKey
      ? {
          key: d.inspectionReportKey,
          sha256: d.inspectionReportSha256,
          url: null,
        }
      : null,
    notes: d.notes,
    source: d.source,
  };
}

function toMaturityView(
  m: Prisma.MaturityAnalysisGetPayload<object>,
  actors: Map<string, TraceActor>,
): MaturityView {
  return {
    id: m.id,
    harvestBatchId: m.harvestBatchId,
    brixDegrees: m.brixDegrees.toNumber(),
    ph: m.ph.toNumber(),
    acidityGl: m.acidityGl.toNumber(),
    measuredAt: m.measuredAt.toISOString(),
    recordedAt: m.recordedAt.toISOString(),
    recordedBy: actorOf(actors, m.recordedByMembershipId),
    notes: m.notes,
    source: m.source,
  };
}

/** Pesaje con los campos de la Ola 2 (§3.2). */
export function toHarvestView(
  row: HarvestRow,
  actors: Map<string, TraceActor>,
  now: Date,
): HarvestView {
  const { lot, maturityAnalyses, phytoDecisions, tankInputs, ...rest } = row;
  const latest = maturityAnalyses[maturityAnalyses.length - 1];
  const used = tankInputs.reduce((sum, i) => sum + i.kg.toNumber(), 0);
  let doEvaluation: DoEvaluation | null = null;
  if (lot?.productType === 'SINGANI') {
    doEvaluation = evaluateDo(
      [
        {
          id: row.terroir.id,
          altitudeMasl: row.terroir.altitudeMasl.toNumber(),
          varietyName: row.terroir.varietyName,
        },
      ],
      doRulesFromLot(parseLotRules(lot.rules)),
      'LOT_SNAPSHOT',
      now,
    );
  }
  return {
    ...rest,
    brixDegrees: latest ? latest.brixDegrees : null,
    initialPh: latest ? latest.ph : null,
    initialAcidityGl: latest ? latest.acidityGl : null,
    maturityAnalyses: maturityAnalyses.map((m) => toMaturityView(m, actors)),
    phytoDecisions: phytoDecisions.map((d) => toDecisionView(d, actors)),
    availableKg: Math.max(
      0,
      Math.round((row.netWeightKg.toNumber() - used) * 1000) / 1000,
    ),
    doEvaluation,
    lateEntry:
      daysBetween(
        row.intakeDate.toISOString().slice(0, 10),
        laPazDate(row.createdAt),
      ) > LATE_ENTRY_DAYS,
  };
}

/** Análisis de la entrada: `maturity` o los campos planos legados (los tres juntos). */
function maturityOf(dto: CreateHarvestBatchDto): Maturity | null {
  if (dto.maturity) return dto.maturity;
  const flat = [dto.brixDegrees, dto.initialPh, dto.initialAcidityGl];
  if (flat.every((v) => v === undefined)) return null;
  if (flat.some((v) => v === undefined)) {
    throw new ValidationException(
      (['brixDegrees', 'initialPh', 'initialAcidityGl'] as const)
        .filter((k) => dto[k] === undefined)
        .map((field) => ({
          field,
          message: 'Brix, pH y acidez van juntos (o usa `maturity`)',
        })),
    );
  }
  return {
    brixDegrees: dto.brixDegrees as number,
    ph: dto.initialPh as number,
    acidityGl: dto.initialAcidityGl as number,
  };
}

function futureDate(field: string, actual: string, today: string) {
  return ruleError(
    ErrorCode.TRC_DATE_IN_FUTURE,
    'La fecha no puede ser futura',
    [
      violation(ErrorCode.TRC_DATE_IN_FUTURE, 'Fecha futura', {
        field,
        expected: today,
        actual,
        meta: { field },
      }),
    ],
  );
}

/** Un instante no puede ser futuro (5 min de tolerancia, reloj de la base). */
export function assertNotFuture(
  field: string,
  value: Date,
  clock: DbClock,
): void {
  if (value.getTime() > clock.now.getTime() + FUTURE_TOLERANCE_MS) {
    throw futureDate(field, value.toISOString(), clock.now.toISOString());
  }
}
