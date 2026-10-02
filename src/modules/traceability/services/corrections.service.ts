import { Injectable, NotFoundException } from '@nestjs/common';
import {
  AgingStatusEnum,
  PhytoStatusEnum,
  Prisma,
  RestStatusEnum,
} from '@prisma/client';
import { AUDIT_TX_OPTIONS, AuditService } from '@shared/audit/audit.service';
import { AuditAction } from '@shared/audit/audit.actions';
import {
  PaginationQueryDto,
  toPage,
  toPrismaPage,
} from '@shared/dto/pagination-query.dto';
import { AppException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';
import { ValidationException } from '@shared/exceptions/validation.exception';
import type {
  ErrorDetail,
  Paginated,
} from '@shared/interfaces/api-response.interface';
import { PrismaService } from '@shared/prisma/prisma.service';
import {
  CreateLotCorrectionDto,
  CreateTerroirCorrectionDto,
} from '@modules/lots/contract/dto/corrections.dto';
import {
  assertDayNotFuture,
  assertInstantNotFuture,
} from '@modules/lots/date-rules';
import {
  canCorrect,
  CorrectionKind,
  CorrectionTargetType,
  CorrectionValue,
  LeftoverValue,
  parseCorrectionChanges,
  sameValue,
  toChangeValue,
  VOIDABLE_TARGETS,
} from '@modules/lots/domain/corrections';
import {
  addDays,
  addMonths,
  dateOnly,
  laPazDate,
  toDbDate,
} from '@modules/lots/domain/dates';
import {
  computeLabConformity,
  methanolToAnhydrous,
} from '@modules/lots/domain/lab-conformity';
import { agingLock, restLock } from '@modules/lots/domain/locks';
import { compareIntegrity } from '@modules/lots/domain/lot-integrity';
import type { LotProductType } from '@modules/lots/domain/lot-stage';
import { num } from '@modules/lots/domain/sources';
import {
  lotNotFound,
  ruleError,
  stateError,
  violation,
} from '@modules/lots/domain/trace-errors';
import { effectiveDoRules, terroirDo } from '@modules/lots/do-rules';
import { releaseDueLocks } from '@modules/lots/lock-release';
import { appendLotEvent } from '@modules/lots/lot-events';
import { lotIntegrity, reevaluateLotIssues } from '@modules/lots/lot-integrity';
import { lockLot, LockedLot, refreshLotStage } from '@modules/lots/lot-records';
import {
  actorOf,
  resolveTraceActors,
  TraceActor,
} from '@modules/lots/trace-actors';
import {
  actorMembership,
  dbClock,
  DbClock,
  lockLotRow,
} from '@modules/lots/trace-db';
import { dossierClosed } from './lab-analyses.service';

type Tx = Prisma.TransactionClient;
type Values = Record<string, CorrectionValue>;

export interface CorrectionChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface CorrectionView {
  id: string;
  lotId: string | null;
  target: { type: CorrectionTargetType; id: string };
  kind: CorrectionKind;
  changes: CorrectionChange[];
  reason: string;
  createdAt: string;
  createdBy: TraceActor | null;
}

/** Lo que devuelve cada registro al aplicarle una corrección. */
interface Applied {
  changes: CorrectionChange[];
  /** Recurso de los eventos de la línea de tiempo del registro corregido. */
  resource: { type: string; id: string };
  /** Texto del registro para el resumen ("el pesaje HARV-2026-…"). */
  label: string;
  /** Día de las lecturas del tanque (su evento agrupa por tanque y día). */
  readingsDay?: string;
  /** Efectos en otros registros (p. ej. el estado del pesaje al anular su dictamen). */
  effects?: Record<string, unknown>;
}

interface Context {
  wineryId: string;
  lot: LockedLot;
  clock: DbClock;
  targetId: string;
  kind: CorrectionKind;
  values: Values;
}

/**
 * Correcciones compensatorias (contrato O2 §9; EA-06). Ningún registro de la
 * trazabilidad se edita ni se borra por una ruta propia: la corrección es un
 * registro aparte, con motivo y autor, que guarda el valor anterior y el
 * nuevo (`AMEND`) o deja de contar el registro (`VOID`). El recurso pasa a
 * devolver el valor vigente y el original queda en `changes[].before` y en
 * la bitácora.
 *
 * Cada corrección vuelve a validar las reglas del lote con su instantánea
 * (candados, balances, D.O.):
 * - si incumple una regla → 422 `TRC_CORRECTION_BREAKS_RULES` con los
 *   detalles de la regla y su `code`;
 * - si lo que incumple es una regla de un embotellado **ya hecho** (que no
 *   se puede deshacer), la corrección se registra y abre una incidencia
 *   `CORRECTION` que bloquea el cierre del expediente;
 * - si deja de incumplirse una regla con incidencia abierta, la incidencia
 *   queda resuelta (`resolvedAt`).
 */
@Injectable()
export class CorrectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async createForLot(
    wineryId: string,
    user: { id: string; role: string | null },
    lotId: string,
    dto: CreateLotCorrectionDto,
  ): Promise<CorrectionView> {
    const type = dto.target.type;
    if (type === 'TERROIR') {
      throw ValidationException.forField(
        'target.type',
        'Una parcela se corrige con POST /v1/terroirs/{id}/corrections',
      );
    }
    // S-17: corrige quien tiene el rol para crear ese registro
    if (!canCorrect(type, user.role)) {
      throw new AppException(
        403,
        ErrorCode.AUTH_INSUFFICIENT_PERMISSIONS,
        'Tu rol no puede corregir este registro: lo corrige quien puede crearlo',
      );
    }
    const values = parseBody(type, dto.kind, dto.changes);
    const reason = dto.reason.trim();

    const id = await this.prisma.$transaction(async (tx) => {
      const lot = await this.lockCorrectableLot(tx, wineryId, lotId, {
        type,
        kind: dto.kind,
      });
      const clock = await dbClock(tx);
      const membership = await actorMembership(tx, user.id, wineryId);
      const before = await lotIntegrity(tx, lot.id);

      const applied = await this.apply(type, tx, {
        wineryId,
        lot,
        clock,
        targetId: dto.target.id,
        kind: dto.kind,
        values,
      });
      if (dto.kind === 'AMEND' && applied.changes.length === 0) {
        throw ValidationException.forField(
          'changes',
          'La corrección no cambia ningún valor del registro',
        );
      }
      await syncBottlingAvailable(tx, lot.id);

      // Reglas del lote con los valores ya corregidos
      const after = await lotIntegrity(tx, lot.id);
      const comparison = compareIntegrity(before, after);
      if (comparison.rejected.length > 0) {
        throw breaksRules(comparison.rejected);
      }

      const correction = await tx.traceCorrection.create({
        data: {
          lotId: lot.id,
          wineryId,
          targetType: type,
          targetId: dto.target.id,
          kind: dto.kind,
          changes: applied.changes as unknown as Prisma.InputJsonArray,
          reason,
          createdAt: clock.now,
          createdByMembershipId: membership?.id ?? null,
        },
      });
      const issues = await reevaluateLotIssues(tx, lot.id, {
        violations: after,
        record: comparison.recorded,
        source: 'CORRECTION',
        correctionId: correction.id,
        now: clock.now,
      });

      const stage = await refreshLotStage(tx, lot.id, clock.now);
      await syncLockStatuses(tx, { ...lot, stage }, clock, this.audit);
      await markCorrected(tx, lot.id, applied);
      await appendLotEvent(tx, lot.id, {
        type: 'CORRECTION',
        occurredAt: clock.now,
        stage,
        actorMembershipId: membership?.id ?? null,
        summary: `${dto.kind === 'VOID' ? 'Anulación' : 'Corrección'} de ${applied.label}: ${reason}`,
        data: {
          correctionId: correction.id,
          target: { type, id: dto.target.id },
          kind: dto.kind,
          fields: applied.changes.map((c) => c.field),
          reason,
          openedIssueIds: issues.openedIssueIds,
          resolvedIssueIds: issues.resolvedIssueIds,
          ...(applied.effects && { effects: applied.effects }),
        },
        resource: applied.resource,
      });
      await this.audit.record(tx, {
        action: AuditAction.CORRECTION_REGISTERED,
        resource: { type: 'trace_correction', id: correction.id },
        organizationId: wineryId,
        before: Object.fromEntries(
          applied.changes.map((c) => [c.field, c.before]),
        ),
        after: {
          ...Object.fromEntries(applied.changes.map((c) => [c.field, c.after])),
          lotId: lot.id,
          target: { type, id: dto.target.id },
          kind: dto.kind,
          openedIssueIds: issues.openedIssueIds,
          resolvedIssueIds: issues.resolvedIssueIds,
          ...(applied.effects && { effects: applied.effects }),
        },
        reason,
      });
      return correction.id;
    }, AUDIT_TX_OPTIONS);
    return this.findView(id);
  }

  /**
   * Corrección de los campos normativos de una parcela usada (§3.1, §9):
   * reevalúa la D.O. de los lotes singani abiertos que la usan; el que deja
   * de cumplir recibe una incidencia `TRC_DO_NOT_ELIGIBLE` con
   * `source: RULES_REEVALUATION` (y el que vuelve a cumplir, la resuelve).
   */
  async createForTerroir(
    wineryId: string,
    user: { id: string; role: string | null },
    terroirId: string,
    dto: CreateTerroirCorrectionDto,
  ): Promise<CorrectionView> {
    const values = parseBody('TERROIR', 'AMEND', dto.changes);
    const reason = dto.reason.trim();
    const id = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM terroirs
        WHERE id = ${terroirId}::uuid AND winery_id = ${wineryId}::uuid
        FOR UPDATE`;
      if (locked.length === 0) {
        throw new NotFoundException(
          `Parcela con ID ${terroirId} no encontrada en esta bodega`,
        );
      }
      const terroir = await tx.terroir.findUniqueOrThrow({
        where: { id: terroirId },
      });
      const clock = await dbClock(tx);
      const membership = await actorMembership(tx, user.id, wineryId);
      const changes = diff(terroir, values);
      if (changes.length === 0) {
        throw ValidationException.forField(
          'changes',
          'La corrección no cambia ningún valor de la parcela',
        );
      }
      const altitudeMasl =
        (values.altitudeMasl as number | undefined) ??
        terroir.altitudeMasl.toNumber();
      const varietyName =
        (values.varietyName as string | undefined) ?? terroir.varietyName;
      const computed = terroirDo(
        { id: terroirId, altitudeMasl, varietyName },
        await effectiveDoRules(tx, wineryId),
        clock.now,
      );
      await tx.terroir.update({
        where: { id: terroirId },
        data: {
          ...(values.altitudeMasl !== undefined && {
            altitudeMasl: new Prisma.Decimal(values.altitudeMasl as number),
          }),
          ...(values.varietyName !== undefined && {
            varietyName: values.varietyName as string,
          }),
          ...(values.rawMaterialType !== undefined && {
            rawMaterialType: values.rawMaterialType as string,
          }),
          isDoEligible: computed.isDoEligible,
        },
      });
      const correction = await tx.traceCorrection.create({
        data: {
          lotId: null,
          wineryId,
          targetType: 'TERROIR',
          targetId: terroirId,
          kind: 'AMEND',
          changes: changes as unknown as Prisma.InputJsonArray,
          reason,
          createdAt: clock.now,
          createdByMembershipId: membership?.id ?? null,
        },
      });

      // Lotes singani abiertos que usan la parcela, en orden estable
      const lots = await tx.lot.findMany({
        where: {
          wineryId,
          productType: 'SINGANI',
          stage: { notIn: ['DISCARDED', 'REJECTED', 'CERTIFIED', 'ANCHORED'] },
          harvestBatches: { some: { terroirId } },
        },
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      const reevaluated: {
        lotId: string;
        opened: string[];
        resolved: string[];
      }[] = [];
      for (const { id: lotId } of lots) {
        const lot = await lockLot(tx, lotId, wineryId);
        const violations = await lotIntegrity(tx, lot.id);
        const issues = await reevaluateLotIssues(tx, lot.id, {
          violations,
          record: violations.filter(
            (v) => v.code === ErrorCode.TRC_DO_NOT_ELIGIBLE,
          ),
          source: 'RULES_REEVALUATION',
          correctionId: correction.id,
          now: clock.now,
        });
        await appendLotEvent(tx, lot.id, {
          type: 'CORRECTION',
          occurredAt: clock.now,
          stage: lot.stage,
          actorMembershipId: membership?.id ?? null,
          summary:
            issues.openedIssueIds.length > 0
              ? `Corrección de la parcela ${terroir.parcelName}: el lote deja de cumplir la D.O. (${reason})`
              : `Corrección de la parcela ${terroir.parcelName}: ${reason}`,
          data: {
            correctionId: correction.id,
            target: { type: 'TERROIR', id: terroirId },
            kind: 'AMEND',
            fields: changes.map((c) => c.field),
            reason,
            openedIssueIds: issues.openedIssueIds,
            resolvedIssueIds: issues.resolvedIssueIds,
          },
          resource: { type: 'terroir', id: terroirId },
        });
        await tx.lot.update({
          where: { id: lot.id },
          data: { updatedAt: clock.now },
        });
        reevaluated.push({
          lotId: lot.id,
          opened: issues.openedIssueIds,
          resolved: issues.resolvedIssueIds,
        });
      }
      await this.audit.record(tx, {
        action: AuditAction.CORRECTION_REGISTERED,
        resource: { type: 'trace_correction', id: correction.id },
        organizationId: wineryId,
        before: Object.fromEntries(changes.map((c) => [c.field, c.before])),
        after: {
          ...Object.fromEntries(changes.map((c) => [c.field, c.after])),
          target: { type: 'TERROIR', id: terroirId },
          kind: 'AMEND',
          isDoEligible: computed.isDoEligible,
          reevaluatedLots: reevaluated,
        },
        reason,
      });
      return correction.id;
    }, AUDIT_TX_OPTIONS);
    return this.findView(id);
  }

  /** Correcciones del lote, la más reciente primero. */
  async listForLot(
    wineryId: string | undefined,
    lotId: string,
    query: PaginationQueryDto,
  ): Promise<Paginated<CorrectionView>> {
    const lot = await this.prisma.lot.findFirst({
      where: { id: lotId, ...(wineryId && { wineryId }) },
      select: { id: true },
    });
    if (!lot) throw lotNotFound();
    const where = { lotId };
    const [rows, total] = await Promise.all([
      this.prisma.traceCorrection.findMany({
        where,
        ...toPrismaPage(query),
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      }),
      this.prisma.traceCorrection.count({ where }),
    ]);
    const actors = await resolveTraceActors(
      this.prisma,
      rows.map((r) => r.createdByMembershipId),
    );
    return toPage(
      rows.map((r) => toCorrectionView(r, actors)),
      total,
      query,
    );
  }

  private async findView(id: string): Promise<CorrectionView> {
    const row = await this.prisma.traceCorrection.findUniqueOrThrow({
      where: { id },
    });
    const actors = await resolveTraceActors(this.prisma, [
      row.createdByMembershipId,
    ]);
    return toCorrectionView(row, actors);
  }

  /**
   * Bloquea el lote y comprueba que admite la corrección: con el expediente
   * cerrado → 409 `TRC_DOSSIER_CLOSED`; descartado → 409 `TRC_LOT_TERMINAL`.
   * Un lote `REJECTED` solo admite anular un dictamen (así se corrige un
   * rechazo erróneo mientras la uva no entró a un tanque, §3.4).
   */
  private async lockCorrectableLot(
    tx: Tx,
    wineryId: string,
    lotId: string,
    target: { type: CorrectionTargetType; kind: CorrectionKind },
  ): Promise<LockedLot> {
    await lockLotRow(tx, lotId);
    const row = await tx.lot.findFirst({
      where: { id: lotId, wineryId },
      select: { dossier: { select: { status: true, closedAt: true } } },
    });
    if (!row) throw lotNotFound();
    if (row.dossier?.status === 'CLOSED') {
      throw dossierClosed(row.dossier.closedAt);
    }
    const lot = await lockLot(tx, lotId, wineryId);
    if (lot.stage === 'CERTIFIED' || lot.stage === 'ANCHORED') {
      throw dossierClosed(null);
    }
    const rejectedVoid =
      lot.stage === 'REJECTED' &&
      target.type === 'PHYTO_DECISION' &&
      target.kind === 'VOID';
    if (
      lot.stage === 'DISCARDED' ||
      (lot.stage === 'REJECTED' && !rejectedVoid)
    ) {
      throw stateError(
        ErrorCode.TRC_LOT_TERMINAL,
        `El lote está en etapa ${lot.stage}: no admite correcciones`,
        [
          violation(
            ErrorCode.TRC_LOT_TERMINAL,
            `Etapa terminal: ${lot.stage}`,
            {
              meta: { stage: lot.stage },
            },
          ),
        ],
      );
    }
    return lot;
  }

  private apply(
    type: Exclude<CorrectionTargetType, 'TERROIR'>,
    tx: Tx,
    ctx: Context,
  ): Promise<Applied> {
    switch (type) {
      case 'HARVEST_BATCH':
        return this.amendHarvest(tx, ctx);
      case 'MATURITY_ANALYSIS':
        return this.correctMaturity(tx, ctx);
      case 'PHYTO_DECISION':
        return this.voidPhytoDecision(tx, ctx);
      case 'FERMENTATION_TANK':
        return this.amendTank(tx, ctx);
      case 'FERMENTATION_LOG':
        return this.correctLog(tx, ctx);
      case 'TREATMENT':
        return this.correctTreatment(tx, ctx);
      case 'WINE_AGING':
        return this.amendAging(tx, ctx);
      case 'PRODUCTION_BATCH':
        return this.amendDistillation(tx, ctx);
      case 'BOTTLING':
        return this.amendBottling(tx, ctx);
      case 'LAB_ANALYSIS':
        return this.correctLabAnalysis(tx, ctx);
    }
  }

  // ── Pesaje ────────────────────────────────────────────────────────────────

  private async amendHarvest(tx: Tx, ctx: Context): Promise<Applied> {
    const row = await tx.harvestBatch.findFirst({
      where: { id: ctx.targetId, wineryId: ctx.wineryId, lotId: ctx.lot.id },
      include: {
        tankInputs: {
          orderBy: { createdAt: 'asc' },
          include: {
            fermentationTank: { select: { tankCode: true, startDate: true } },
          },
        },
        phytoDecisions: {
          where: { voidedAt: null },
          select: { decidedAt: true },
        },
      },
    });
    if (!row) throw targetNotFound('El pesaje');
    const v = ctx.values;
    const current = {
      grossWeightKg: row.grossWeightKg,
      tareWeightKg: row.tareWeightKg,
      intakeDate: dateOnly(row.intakeDate),
      temperatureAtIntakeC: row.temperatureAtIntakeC,
      notes: row.notes,
    };
    const changes = diff(current, v);
    const gross =
      (v.grossWeightKg as number | undefined) ?? row.grossWeightKg.toNumber();
    const tare =
      (v.tareWeightKg as number | undefined) ?? row.tareWeightKg.toNumber();
    const net = round3(gross - tare);
    if (net <= 0) {
      throw ValidationException.forField(
        'changes.grossWeightKg',
        'El peso bruto debe ser estrictamente mayor al peso tara',
      );
    }
    if (typeof v.intakeDate === 'string') {
      assertDayNotFuture('changes.intakeDate', v.intakeDate, ctx.clock);
      const limits = [
        ...row.tankInputs.map((i) => laPazDate(i.fermentationTank.startDate)),
        ...row.phytoDecisions.map((d) => laPazDate(d.decidedAt)),
      ];
      const maximum = limits.length > 0 ? limits.reduce(min) : null;
      if (maximum && v.intakeDate > maximum) {
        throw breaksRules([
          violation(
            ErrorCode.TRC_DATE_BEFORE_PREVIOUS_STAGE,
            `El ingreso de la uva no puede ser posterior a su dictamen ni al llenado del tanque (${maximum})`,
            {
              field: 'changes.intakeDate',
              expected: maximum,
              actual: v.intakeDate,
              meta: { maximum },
            },
          ),
        ]);
      }
    }
    // Toda la uva del pesaje estaba en tanques: las entradas siguen al neto
    const oldNet = row.netWeightKg.toNumber();
    const inputsKg = row.tankInputs.reduce((s, i) => s + i.kg.toNumber(), 0);
    if (
      Math.abs(net - oldNet) > 1e-9 &&
      row.tankInputs.length > 0 &&
      Math.abs(inputsKg - oldNet) < 1e-6
    ) {
      let assigned = 0;
      for (const [index, input] of row.tankInputs.entries()) {
        const last = index === row.tankInputs.length - 1;
        const kg = last
          ? round3(net - assigned)
          : round3((input.kg.toNumber() * net) / oldNet);
        assigned = round3(assigned + kg);
        await tx.fermentationTankInput.update({
          where: { id: input.id },
          data: { kg: new Prisma.Decimal(kg) },
        });
        changes.push({
          field: `tankInputs.${input.fermentationTank.tankCode}.kg`,
          before: input.kg.toNumber(),
          after: kg,
        });
      }
    }
    if (Math.abs(net - oldNet) > 1e-9) {
      changes.push({ field: 'netWeightKg', before: oldNet, after: net });
    }
    await tx.harvestBatch.update({
      where: { id: row.id },
      data: {
        ...(v.grossWeightKg !== undefined && {
          grossWeightKg: new Prisma.Decimal(gross),
        }),
        ...(v.tareWeightKg !== undefined && {
          tareWeightKg: new Prisma.Decimal(tare),
        }),
        netWeightKg: new Prisma.Decimal(net),
        ...(typeof v.intakeDate === 'string' && {
          intakeDate: toDbDate(v.intakeDate),
        }),
        ...(v.temperatureAtIntakeC !== undefined && {
          temperatureAtIntakeC: decimal(v.temperatureAtIntakeC),
        }),
        ...(v.notes !== undefined && { notes: v.notes as string | null }),
      },
    });
    return {
      changes,
      resource: { type: 'harvest_batch', id: row.id },
      label: `el pesaje ${row.harvestBatchCode}`,
    };
  }

  // ── Análisis de madurez ───────────────────────────────────────────────────

  private async correctMaturity(tx: Tx, ctx: Context): Promise<Applied> {
    const row = await tx.maturityAnalysis.findFirst({
      where: {
        id: ctx.targetId,
        harvestBatch: { wineryId: ctx.wineryId, lotId: ctx.lot.id },
      },
      include: { harvestBatch: { select: { harvestBatchCode: true } } },
    });
    if (!row) throw targetNotFound('El análisis de madurez');
    assertNotVoided(row.voidedAt);
    const v = ctx.values;
    let changes: CorrectionChange[];
    if (ctx.kind === 'VOID') {
      await tx.maturityAnalysis.update({
        where: { id: row.id },
        data: { voidedAt: ctx.clock.now },
      });
      changes = [];
    } else {
      changes = diff(row, v);
      if (v.measuredAt instanceof Date) {
        assertInstantNotFuture('changes.measuredAt', v.measuredAt, ctx.clock);
      }
      await tx.maturityAnalysis.update({
        where: { id: row.id },
        data: {
          ...(v.brixDegrees !== undefined && {
            brixDegrees: new Prisma.Decimal(v.brixDegrees as number),
          }),
          ...(v.ph !== undefined && {
            ph: new Prisma.Decimal(v.ph as number),
          }),
          ...(v.acidityGl !== undefined && {
            acidityGl: new Prisma.Decimal(v.acidityGl as number),
          }),
          ...(v.measuredAt instanceof Date && { measuredAt: v.measuredAt }),
          ...(v.notes !== undefined && { notes: v.notes as string | null }),
        },
      });
    }
    // El pesaje refleja el último análisis vigente (o ninguno)
    const latest = await tx.maturityAnalysis.findFirst({
      where: { harvestBatchId: row.harvestBatchId, voidedAt: null },
      orderBy: [{ measuredAt: 'desc' }, { recordedAt: 'desc' }],
    });
    await tx.harvestBatch.update({
      where: { id: row.harvestBatchId },
      data: {
        brixDegrees: latest?.brixDegrees ?? null,
        initialPh: latest?.ph ?? null,
        initialAcidityGl: latest?.acidityGl ?? null,
      },
    });
    return {
      changes,
      resource: { type: 'maturity_analysis', id: row.id },
      label: `un análisis de madurez de ${row.harvestBatch.harvestBatchCode}`,
    };
  }

  // ── Dictamen fitosanitario ────────────────────────────────────────────────

  private async voidPhytoDecision(tx: Tx, ctx: Context): Promise<Applied> {
    const row = await tx.phytoDecision.findFirst({
      where: {
        id: ctx.targetId,
        harvestBatch: { wineryId: ctx.wineryId, lotId: ctx.lot.id },
      },
      include: {
        harvestBatch: {
          select: {
            id: true,
            harvestBatchCode: true,
            phytosanitaryStatus: true,
            _count: { select: { fermentationTanks: true, tankInputs: true } },
          },
        },
      },
    });
    if (!row) throw targetNotFound('El dictamen');
    assertNotVoided(row.voidedAt);
    const harvest = row.harvestBatch;
    if (harvest._count.fermentationTanks > 0 || harvest._count.tankInputs > 0) {
      throw stateError(
        ErrorCode.TRC_PHYTO_DECISION_FINAL,
        'La uva ya entró a un tanque: el dictamen no se puede anular',
        [
          violation(ErrorCode.TRC_PHYTO_DECISION_FINAL, 'Dictamen final', {
            meta: { status: harvest.phytosanitaryStatus, inTank: true },
          }),
        ],
      );
    }
    await tx.phytoDecision.update({
      where: { id: row.id },
      data: { voidedAt: ctx.clock.now },
    });
    // El estado del pesaje vuelve al del último dictamen vigente
    const previous = await tx.phytoDecision.findFirst({
      where: { harvestBatchId: harvest.id, voidedAt: null },
      orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
    });
    const status = previous?.decision ?? PhytoStatusEnum.PENDING_INSPECTION;
    const legacyMember = previous?.decidedByMembershipId
      ? await tx.wineryMember.findUnique({
          where: { id: previous.decidedByMembershipId },
          select: { id: true },
        })
      : null;
    await tx.harvestBatch.update({
      where: { id: harvest.id },
      data: {
        phytosanitaryStatus: status,
        certifiedByMemberId: legacyMember?.id ?? null,
      },
    });
    return {
      // Una anulación no cambia campos del dictamen: su efecto es el estado
      // del pesaje, que vuelve al del último dictamen vigente
      changes: [],
      effects: {
        harvestBatchId: harvest.id,
        phytosanitaryStatus: {
          before: harvest.phytosanitaryStatus,
          after: status,
        },
      },
      resource: { type: 'phyto_decision', id: row.id },
      label: `el dictamen ${row.decision} de ${harvest.harvestBatchCode}`,
    };
  }

  // ── Tanque ────────────────────────────────────────────────────────────────

  private async amendTank(tx: Tx, ctx: Context): Promise<Applied> {
    const row = await tx.fermentationTank.findFirst({
      where: { id: ctx.targetId, wineryId: ctx.wineryId, lotId: ctx.lot.id },
      include: {
        inputs: { select: { harvestBatch: { select: { intakeDate: true } } } },
        logs: { where: { voidedAt: null }, select: { recordedAt: true } },
        treatments: { where: { voidedAt: null }, select: { appliedAt: true } },
        wineAgingBatch: { select: { startDate: true, createdAt: true } },
        productionBatches: { select: { processStartDate: true } },
      },
    });
    if (!row) throw targetNotFound('El tanque');
    const v = ctx.values;
    const completed = row.endDate !== null || row.finalVolumeLiters !== null;
    for (const field of ['finalVolumeLiters', 'endDate'] as const) {
      if (v[field] !== undefined && !completed) {
        throw notCorrectableNow(
          field,
          `El tanque ${row.tankCode} aún no se completó: ${field} se registra al completarlo`,
        );
      }
    }
    const changes = diff(row, v);
    const startDate = (v.startDate as Date | undefined) ?? row.startDate;
    const endDate = (v.endDate as Date | undefined) ?? row.endDate;
    const details: ErrorDetail[] = [];
    if (v.startDate instanceof Date) {
      assertInstantNotFuture('changes.startDate', v.startDate, ctx.clock);
      const intakes = row.inputs.map((i) =>
        dateOnly(i.harvestBatch.intakeDate),
      );
      const lastIntake = intakes.length > 0 ? intakes.reduce(max) : null;
      if (lastIntake && laPazDate(startDate) < lastIntake) {
        details.push(
          dateViolation(
            'changes.startDate',
            'El tanque no puede empezar antes del ingreso de la uva',
            laPazDate(startDate),
            { minimum: lastIntake },
          ),
        );
      }
      const records = [
        ...row.logs.map((l) => l.recordedAt),
        ...row.treatments.map((t) => t.appliedAt),
      ];
      const first =
        records.length > 0 ? records.reduce((a, b) => (a < b ? a : b)) : null;
      if (first && startDate > first) {
        details.push(
          dateViolation(
            'changes.startDate',
            'El tanque no puede empezar después de sus lecturas y tratamientos',
            startDate.toISOString(),
            { maximum: first.toISOString() },
          ),
        );
      }
    }
    if (v.endDate instanceof Date) {
      assertInstantNotFuture('changes.endDate', v.endDate, ctx.clock);
      const next = [
        ...(row.wineAgingBatch
          ? [
              row.wineAgingBatch.startDate
                ? dateOnly(row.wineAgingBatch.startDate)
                : laPazDate(row.wineAgingBatch.createdAt),
            ]
          : []),
        ...row.productionBatches.map((p) => dateOnly(p.processStartDate)),
      ];
      const firstNext = next.length > 0 ? next.reduce(min) : null;
      if (firstNext && laPazDate(v.endDate) > firstNext) {
        details.push(
          dateViolation(
            'changes.endDate',
            'La fermentación no puede terminar después del inicio de la crianza o de la destilación',
            laPazDate(v.endDate),
            { maximum: firstNext },
          ),
        );
      }
    }
    if (endDate && endDate < startDate) {
      details.push(
        dateViolation(
          v.endDate !== undefined ? 'changes.endDate' : 'changes.startDate',
          'La fermentación no puede terminar antes del llenado del tanque',
          endDate.toISOString(),
          { minimum: startDate.toISOString() },
        ),
      );
    }
    if (details.length > 0) throw breaksRules(details);
    await tx.fermentationTank.update({
      where: { id: row.id },
      data: {
        ...(v.volumeFilledLiters !== undefined && {
          volumeFilledLiters: decimal(v.volumeFilledLiters),
        }),
        ...(v.finalVolumeLiters !== undefined && {
          finalVolumeLiters: decimal(v.finalVolumeLiters),
        }),
        ...(v.startDate instanceof Date && { startDate: v.startDate }),
        ...(v.endDate instanceof Date && { endDate: v.endDate }),
      },
    });
    return {
      changes,
      resource: { type: 'fermentation_tank', id: row.id },
      label: `el tanque ${row.tankCode}`,
    };
  }

  // ── Lecturas y tratamientos ───────────────────────────────────────────────

  private async correctLog(tx: Tx, ctx: Context): Promise<Applied> {
    const row = await tx.fermentationLog.findFirst({
      where: {
        id: ctx.targetId,
        fermentationTank: { wineryId: ctx.wineryId, lotId: ctx.lot.id },
      },
      include: {
        fermentationTank: {
          select: { id: true, tankCode: true, startDate: true },
        },
      },
    });
    if (!row) throw targetNotFound('La lectura');
    assertNotVoided(row.voidedAt);
    const v = ctx.values;
    let changes: CorrectionChange[];
    if (ctx.kind === 'VOID') {
      await tx.fermentationLog.update({
        where: { id: row.id },
        data: { voidedAt: ctx.clock.now },
      });
      changes = [];
    } else {
      changes = diff(row, v);
      if (v.recordedAt instanceof Date) {
        this.assertWithinTank(
          'changes.recordedAt',
          v.recordedAt,
          row.fermentationTank.startDate,
          ctx.clock,
        );
      }
      await tx.fermentationLog.update({
        where: { id: row.id },
        data: {
          ...(v.temperatureCelsius !== undefined && {
            temperatureCelsius: new Prisma.Decimal(
              v.temperatureCelsius as number,
            ),
          }),
          ...(v.specificGravity !== undefined && {
            specificGravity: decimal(v.specificGravity),
          }),
          ...(v.phValue !== undefined && { phValue: decimal(v.phValue) }),
          ...(v.co2Observations !== undefined && {
            co2Observations: v.co2Observations as string | null,
          }),
          ...(v.recordedAt instanceof Date && { recordedAt: v.recordedAt }),
          ...(v.notes !== undefined && { notes: v.notes as string | null }),
        },
      });
    }
    return {
      changes,
      // El evento de las lecturas agrupa por tanque y día (§11.1)
      resource: { type: 'fermentation_tank', id: row.fermentationTank.id },
      readingsDay: laPazDate(row.recordedAt),
      label: `una lectura del tanque ${row.fermentationTank.tankCode}`,
    };
  }

  private async correctTreatment(tx: Tx, ctx: Context): Promise<Applied> {
    const row = await tx.enologicalTreatment.findFirst({
      where: {
        id: ctx.targetId,
        fermentationTank: { wineryId: ctx.wineryId, lotId: ctx.lot.id },
      },
      include: {
        fermentationTank: { select: { tankCode: true, startDate: true } },
      },
    });
    if (!row) throw targetNotFound('El tratamiento');
    assertNotVoided(row.voidedAt);
    const v = ctx.values;
    let changes: CorrectionChange[];
    if (ctx.kind === 'VOID') {
      await tx.enologicalTreatment.update({
        where: { id: row.id },
        data: { voidedAt: ctx.clock.now },
      });
      changes = [];
    } else {
      changes = diff(row, v);
      if (v.appliedAt instanceof Date) {
        this.assertWithinTank(
          'changes.appliedAt',
          v.appliedAt,
          row.fermentationTank.startDate,
          ctx.clock,
        );
      }
      await tx.enologicalTreatment.update({
        where: { id: row.id },
        data: {
          ...(v.dosageAppliedGPerHl !== undefined && {
            dosageAppliedGPerHl: new Prisma.Decimal(
              v.dosageAppliedGPerHl as number,
            ),
          }),
          ...(v.totalAppliedG !== undefined && {
            totalAppliedG: decimal(v.totalAppliedG),
          }),
          ...(v.additiveName !== undefined && {
            additiveName: v.additiveName as string,
          }),
          ...(v.additiveSupplier !== undefined && {
            additiveSupplier: v.additiveSupplier as string | null,
          }),
          ...(v.appliedAt instanceof Date && { appliedAt: v.appliedAt }),
          ...(v.notes !== undefined && { notes: v.notes as string | null }),
        },
      });
    }
    return {
      changes,
      resource: { type: 'enological_treatment', id: row.id },
      label: `el tratamiento ${row.additiveName} del tanque ${row.fermentationTank.tankCode}`,
    };
  }

  private assertWithinTank(
    field: string,
    value: Date,
    tankStart: Date,
    clock: DbClock,
  ): void {
    assertInstantNotFuture(field, value, clock);
    if (value < tankStart) {
      throw breaksRules([
        dateViolation(
          field,
          'La fecha es anterior al inicio del tanque',
          value.toISOString(),
          { minimum: tankStart.toISOString() },
        ),
      ]);
    }
  }

  // ── Crianza ───────────────────────────────────────────────────────────────

  private async amendAging(tx: Tx, ctx: Context): Promise<Applied> {
    const row = await tx.wineAgingBatch.findFirst({
      where: { id: ctx.targetId, wineryId: ctx.wineryId, lotId: ctx.lot.id },
      include: {
        fermentationTank: { select: { startDate: true, endDate: true } },
      },
    });
    if (!row) throw targetNotFound('La crianza');
    if (row.agingStatus === AgingStatusEnum.DISCARDED || row.discardedAt) {
      throw sourceDiscarded('La crianza');
    }
    const v = ctx.values;
    const currentStart = row.startDate
      ? dateOnly(row.startDate)
      : laPazDate(row.createdAt);
    const changes = diff({ ...row, startDate: currentStart }, v);
    const startDay = (v.startDate as string | undefined) ?? currentStart;
    if (typeof v.startDate === 'string') {
      assertDayNotFuture('changes.startDate', v.startDate, ctx.clock);
      const minimum = laPazDate(
        row.fermentationTank.endDate ?? row.fermentationTank.startDate,
      );
      if (v.startDate < minimum) {
        throw breaksRules([
          dateViolation(
            'changes.startDate',
            'La crianza no puede empezar antes que el tanque',
            v.startDate,
            { minimum },
          ),
        ]);
      }
    }
    const plannedMonths =
      (v.plannedMonths as number | undefined) ?? row.plannedMonths;
    // El candado se recalcula: inicio + meses (nunca menos que el mínimo)
    const unlockDate = addMonths(
      startDay,
      Math.max(plannedMonths, ctx.lot.rules.wine.minAgingMonths),
    );
    await tx.wineAgingBatch.update({
      where: { id: row.id },
      data: {
        ...(v.plannedMonths !== undefined && { plannedMonths }),
        ...(v.volumeLiters !== undefined && {
          volumeLiters: decimal(v.volumeLiters),
        }),
        startDate: toDbDate(startDay),
        lockUntilDate: toDbDate(unlockDate),
      },
    });
    if (dateOnly(row.lockUntilDate) !== unlockDate) {
      changes.push({
        field: 'unlockDate',
        before: dateOnly(row.lockUntilDate),
        after: unlockDate,
      });
    }
    return {
      changes,
      resource: { type: 'wine_aging_batch', id: row.id },
      label: `la crianza en ${row.containerType}`,
    };
  }

  // ── Destilación ───────────────────────────────────────────────────────────

  private async amendDistillation(tx: Tx, ctx: Context): Promise<Applied> {
    const row = await tx.productionBatch.findFirst({
      where: { id: ctx.targetId, wineryId: ctx.wineryId, lotId: ctx.lot.id },
      include: {
        fermentationTank: { select: { startDate: true, endDate: true } },
      },
    });
    if (!row) throw targetNotFound('La destilación');
    if (row.restStatus === RestStatusEnum.DISCARDED || row.discardedAt) {
      throw sourceDiscarded('La destilación');
    }
    const v = ctx.values;
    const closed = row.processEndDate !== null;
    for (const field of [
      'headsLiters',
      'heartLiters',
      'tailsLiters',
      'vinasseLiters',
      'heartAbvPercent',
      'processEndDate',
    ] as const) {
      if (v[field] !== undefined && !closed) {
        throw notCorrectableNow(
          field,
          `La destilación sigue abierta: ${field} se registra al cerrarla (POST /v1/production-batches/{id}/close)`,
        );
      }
    }
    const current = {
      inputVolumeLiters: row.inputVolumeLiters,
      headsLiters: row.headsLiters,
      heartLiters: row.heartLiters ?? row.outputVolumeLiters,
      tailsLiters: row.tailsLiters,
      vinasseLiters: row.vinasseLiters,
      heartAbvPercent: row.heartAbvPercent ?? row.initialAlcoholPercentage,
      processStartDate: dateOnly(row.processStartDate),
      processEndDate: row.processEndDate ? dateOnly(row.processEndDate) : null,
    };
    const changes = diff(current, v);
    const startDay =
      (v.processStartDate as string | undefined) ?? current.processStartDate;
    const endDay =
      (v.processEndDate as string | undefined) ?? current.processEndDate;
    const details: ErrorDetail[] = [];
    if (typeof v.processStartDate === 'string') {
      assertDayNotFuture('changes.processStartDate', startDay, ctx.clock);
      const minimum = laPazDate(
        row.fermentationTank.endDate ?? row.fermentationTank.startDate,
      );
      if (startDay < minimum) {
        details.push(
          dateViolation(
            'changes.processStartDate',
            'La destilación no puede empezar antes que el tanque',
            startDay,
            { minimum },
          ),
        );
      }
    }
    if (typeof v.processEndDate === 'string') {
      assertDayNotFuture('changes.processEndDate', v.processEndDate, ctx.clock);
    }
    if (endDay && endDay < startDay) {
      details.push(
        dateViolation(
          v.processEndDate !== undefined
            ? 'changes.processEndDate'
            : 'changes.processStartDate',
          'La destilación no puede terminar antes de empezar',
          endDay,
          { minimum: startDay },
        ),
      );
    }
    if (details.length > 0) throw breaksRules(details);

    const heart =
      (v.heartLiters as number | undefined) ?? num(current.heartLiters);
    const heads =
      (v.headsLiters as number | undefined) ?? num(current.headsLiters);
    const tails =
      (v.tailsLiters as number | undefined) ?? num(current.tailsLiters);
    const restUntil = endDay
      ? addDays(endDay, ctx.lot.rules.singani.minRestDays)
      : null;
    const cutsTouched = ['headsLiters', 'heartLiters', 'tailsLiters'].some(
      (f) => v[f] !== undefined,
    );
    await tx.productionBatch.update({
      where: { id: row.id },
      data: {
        ...(v.inputVolumeLiters !== undefined && {
          inputVolumeLiters: decimal(v.inputVolumeLiters),
        }),
        ...(v.headsLiters !== undefined && {
          headsLiters: decimal(v.headsLiters),
        }),
        ...(v.heartLiters !== undefined && {
          heartLiters: decimal(v.heartLiters),
        }),
        ...(v.tailsLiters !== undefined && {
          tailsLiters: decimal(v.tailsLiters),
        }),
        ...(v.vinasseLiters !== undefined && {
          vinasseLiters: decimal(v.vinasseLiters),
        }),
        ...(v.heartAbvPercent !== undefined && {
          heartAbvPercent: decimal(v.heartAbvPercent),
        }),
        // Campos anteriores a la Ola 2, coherentes con los cortes vigentes
        ...(cutsTouched && {
          outputVolumeLiters: decimal(heart),
          wasteVolumeLiters: decimal(round3((heads ?? 0) + (tails ?? 0))),
        }),
        ...(typeof v.processStartDate === 'string' && {
          processStartDate: toDbDate(startDay),
        }),
        ...(typeof v.processEndDate === 'string' && {
          processEndDate: toDbDate(v.processEndDate),
        }),
        ...(restUntil && { mandatoryRestUntil: toDbDate(restUntil) }),
      },
    });
    const storedRest = row.mandatoryRestUntil
      ? dateOnly(row.mandatoryRestUntil)
      : null;
    if (restUntil && storedRest !== restUntil) {
      changes.push({
        field: 'mandatoryRestUntil',
        before: storedRest,
        after: restUntil,
      });
    }
    return {
      changes,
      resource: { type: 'production_batch', id: row.id },
      label: `la destilación en ${row.equipmentIdentifier}`,
    };
  }

  // ── Embotellado ───────────────────────────────────────────────────────────

  private async amendBottling(tx: Tx, ctx: Context): Promise<Applied> {
    const row = await tx.bottlingBatch.findFirst({
      where: { id: ctx.targetId, wineryId: ctx.wineryId, lotId: ctx.lot.id },
    });
    if (!row) throw targetNotFound('El embotellado');
    const v = ctx.values;
    const leftover: LeftoverValue | null =
      row.leftoverLiters !== null
        ? {
            liters: row.leftoverLiters.toNumber(),
            disposition:
              row.leftoverDisposition === 'DISCARDED'
                ? 'DISCARDED'
                : 'RETAINED',
            notes: row.leftoverNotes,
          }
        : null;
    const changes = diff(
      {
        finalAlcoholAbv: row.finalAlcoholAbv,
        bottleType: row.bottleType,
        leftover,
      },
      v,
    );
    const next = v.leftover as LeftoverValue | null | undefined;
    await tx.bottlingBatch.update({
      where: { id: row.id },
      data: {
        ...(v.finalAlcoholAbv !== undefined && {
          finalAlcoholAbv: new Prisma.Decimal(v.finalAlcoholAbv as number),
        }),
        ...(v.bottleType !== undefined && {
          bottleType: v.bottleType as string | null,
        }),
        ...(next !== undefined && {
          leftoverLiters: next ? new Prisma.Decimal(next.liters) : null,
          leftoverDisposition: next?.disposition ?? null,
          leftoverNotes: next?.notes ?? null,
        }),
      },
    });
    // El aviso del grado etiquetado de los análisis depende del embotellado
    if (v.finalAlcoholAbv !== undefined) {
      const analyses = await tx.batchLabAnalysis.findMany({
        where: { bottlingBatchId: row.id, voidedAt: null },
      });
      for (const analysis of analyses) {
        await recomputeConformity(tx, ctx.lot, analysis.id);
      }
    }
    return {
      changes,
      resource: { type: 'bottling_batch', id: row.id },
      label: `el embotellado ${row.internationalLotCode}`,
    };
  }

  // ── Laboratorio ───────────────────────────────────────────────────────────

  private async correctLabAnalysis(tx: Tx, ctx: Context): Promise<Applied> {
    const row = await tx.batchLabAnalysis.findFirst({
      where: {
        id: ctx.targetId,
        lotId: ctx.lot.id,
        bottlingBatch: { wineryId: ctx.wineryId },
      },
      include: { bottlingBatch: { select: { bottlingDate: true } } },
    });
    if (!row) throw targetNotFound('El análisis de laboratorio');
    assertNotVoided(row.voidedAt);
    const label = `el análisis de ${row.certifiedLaboratoryName}`;
    const resource = { type: 'lab_analysis', id: row.id };
    if (ctx.kind === 'VOID') {
      await tx.batchLabAnalysis.update({
        where: { id: row.id },
        data: {
          voidedAt: ctx.clock.now,
          supersededAt: row.supersededAt ?? ctx.clock.now,
        },
      });
      // Si era el vigente, vuelve a serlo el último análisis sin anular
      const current = await tx.batchLabAnalysis.findFirst({
        where: {
          bottlingBatchId: row.bottlingBatchId,
          voidedAt: null,
          supersededAt: null,
        },
        select: { id: true },
      });
      if (!current) {
        const previous = await tx.batchLabAnalysis.findFirst({
          where: { bottlingBatchId: row.bottlingBatchId, voidedAt: null },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { id: true },
        });
        if (previous) {
          await tx.batchLabAnalysis.update({
            where: { id: previous.id },
            data: { supersededAt: null },
          });
        }
      }
      return { changes: [], resource, label };
    }

    const v = ctx.values;
    const changes = diff(
      { ...row, testPerformedAt: dateOnly(row.testPerformedAt) },
      v,
    );
    if (typeof v.testPerformedAt === 'string') {
      assertDayNotFuture(
        'changes.testPerformedAt',
        v.testPerformedAt,
        ctx.clock,
      );
      const minimum = dateOnly(row.bottlingBatch.bottlingDate);
      if (v.testPerformedAt < minimum) {
        throw breaksRules([
          dateViolation(
            'changes.testPerformedAt',
            'El ensayo no puede ser anterior al embotellado',
            v.testPerformedAt,
            { minimum },
          ),
        ]);
      }
    }
    // Metanol: el valor en mg/100 mL a.a. sigue al de mg/L y al grado (§8.2)
    const abv =
      (v.actualAlcoholAbv as number | undefined) ??
      row.actualAlcoholAbv.toNumber();
    const mgL =
      v.methanolContentMgL !== undefined
        ? (v.methanolContentMgL as number | null)
        : num(row.methanolContentMgL);
    const fromMgL = mgL !== null ? methanolToAnhydrous(mgL, abv) : null;
    let methanolAa: number | null;
    if (v.methanolMg100mlAa !== undefined) {
      methanolAa = v.methanolMg100mlAa as number | null;
      if (
        methanolAa !== null &&
        fromMgL !== null &&
        Math.abs(fromMgL - methanolAa) > Math.max(fromMgL, methanolAa) * 0.01
      ) {
        throw ValidationException.forField(
          'changes.methanolMg100mlAa',
          `El metanol en mg/L (${mgL}) equivale a ${fromMgL} mg/100 mL a.a. con ${abv} % vol: no coincide con ${methanolAa}`,
        );
      }
    } else if (
      v.methanolContentMgL !== undefined ||
      (v.actualAlcoholAbv !== undefined && mgL !== null)
    ) {
      methanolAa = fromMgL;
    } else {
      methanolAa = num(row.methanolMg100mlAa);
    }
    const previousAa = num(row.methanolMg100mlAa);
    if (
      v.methanolMg100mlAa === undefined &&
      !sameValue(previousAa, methanolAa)
    ) {
      changes.push({
        field: 'methanolMg100mlAa',
        before: previousAa,
        after: methanolAa,
      });
    }
    const numeric: Record<string, Prisma.Decimal | null> = {};
    for (const field of LAB_NUMERIC_FIELDS) {
      if (v[field] !== undefined) numeric[field] = decimal(v[field]);
    }
    await tx.batchLabAnalysis.update({
      where: { id: row.id },
      data: {
        ...(numeric as Prisma.BatchLabAnalysisUncheckedUpdateInput),
        methanolMg100mlAa: decimal(methanolAa),
        ...(typeof v.testPerformedAt === 'string' && {
          testPerformedAt: toDbDate(v.testPerformedAt),
        }),
      },
    });
    const status = await recomputeConformity(tx, ctx.lot, row.id);
    if (status !== row.conformityStatus) {
      changes.push({
        field: 'conformityStatus',
        before: row.conformityStatus,
        after: status,
      });
    }
    return { changes, resource, label };
  }
}

// ── Utilidades ───────────────────────────────────────────────────────────────

const LAB_NUMERIC_FIELDS = [
  'actualAlcoholAbv',
  'totalAlcoholAbv',
  'totalAcidityTartaricGl',
  'volatileAcidityAceticGl',
  'freeSulfurDioxideMgL',
  'totalSulfurDioxideMgL',
  'reducingSugarsGl',
  'totalDryExtractGl',
  'sugarFreeDryExtractGl',
  'overpressureBar',
  'methanolContentMgL',
  'copperContentMgL',
] as const;

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const min = (a: string, b: string): string => (a <= b ? a : b);
const max = (a: string, b: string): string => (a >= b ? a : b);

function decimal(value: CorrectionValue | undefined): Prisma.Decimal | null {
  return typeof value === 'number' ? new Prisma.Decimal(value) : null;
}

/**
 * Valida el cuerpo de una corrección: `VOID` solo en los registros que se
 * pueden anular y sin `changes`; `AMEND` con `changes` de la lista cerrada.
 */
function parseBody(
  type: CorrectionTargetType,
  kind: CorrectionKind,
  changes: Record<string, unknown> | undefined,
): Values {
  if (kind === 'VOID') {
    if (!VOIDABLE_TARGETS.includes(type)) {
      throw ruleError(
        ErrorCode.TRC_CORRECTION_FIELD_NOT_CORRECTABLE,
        'Este registro no se anula: se corrige campo a campo (AMEND)',
        [
          violation(
            ErrorCode.TRC_CORRECTION_FIELD_NOT_CORRECTABLE,
            `Un registro ${type} no admite VOID`,
            {
              field: 'kind',
              meta: { field: 'kind', voidable: VOIDABLE_TARGETS },
            },
          ),
        ],
      );
    }
    if (changes && Object.keys(changes).length > 0) {
      throw ValidationException.forField(
        'changes',
        'Una anulación (VOID) no lleva cambios',
      );
    }
    return {};
  }
  if (!changes || Object.keys(changes).length === 0) {
    throw ValidationException.forField(
      'changes',
      'Indica al menos un campo con su valor corregido',
    );
  }
  const parsed = parseCorrectionChanges(type, changes);
  if (parsed.notCorrectable.length > 0) {
    throw ruleError(
      ErrorCode.TRC_CORRECTION_FIELD_NOT_CORRECTABLE,
      parsed.notCorrectable[0].message,
      parsed.notCorrectable,
    );
  }
  if (parsed.invalid.length > 0) throw new ValidationException(parsed.invalid);
  return parsed.values;
}

/** Cambios efectivos: los campos cuyo valor nuevo difiere del vigente. */
function diff(current: object, values: Values): CorrectionChange[] {
  const row = current as Record<string, unknown>;
  const changes: CorrectionChange[] = [];
  for (const [field, after] of Object.entries(values)) {
    if (sameValue(row[field], after)) continue;
    changes.push({
      field,
      before: toChangeValue(row[field]),
      after: toChangeValue(after),
    });
  }
  return changes;
}

/** 422 `TRC_CORRECTION_BREAKS_RULES` con los detalles de la regla incumplida. */
function breaksRules(details: ErrorDetail[]) {
  return ruleError(
    ErrorCode.TRC_CORRECTION_BREAKS_RULES,
    `La corrección incumple una regla del lote: ${details[0]?.message ?? ''}`.trim(),
    details,
  );
}

function dateViolation(
  field: string,
  message: string,
  actual: string,
  limit: { minimum?: string; maximum?: string },
): ErrorDetail {
  return violation(ErrorCode.TRC_DATE_BEFORE_PREVIOUS_STAGE, message, {
    field,
    expected: limit.minimum ?? limit.maximum,
    actual,
    meta: { field, ...limit },
  });
}

function notCorrectableNow(field: string, message: string) {
  return ruleError(ErrorCode.TRC_CORRECTION_FIELD_NOT_CORRECTABLE, message, [
    violation(ErrorCode.TRC_CORRECTION_FIELD_NOT_CORRECTABLE, message, {
      field: `changes.${field}`,
      meta: { field },
    }),
  ]);
}

function targetNotFound(label: string): NotFoundException {
  return new NotFoundException(`${label} no existe en este lote`);
}

function assertNotVoided(voidedAt: Date | null): void {
  if (!voidedAt) return;
  throw new AppException(
    409,
    ErrorCode.CONFLICT,
    'El registro está anulado: ya no admite correcciones',
  );
}

function sourceDiscarded(label: string) {
  return stateError(
    ErrorCode.TRC_INVALID_STAGE,
    `${label} está descartada: ya no admite correcciones`,
    [
      violation(ErrorCode.TRC_INVALID_STAGE, 'Fuente descartada', {
        meta: { status: 'DISCARDED' },
      }),
    ],
  );
}

/**
 * Recalcula la conformidad de un análisis contra la instantánea del lote
 * (§8.3) con sus valores vigentes y el grado etiquetado del embotellado.
 */
async function recomputeConformity(
  tx: Tx,
  lot: LockedLot,
  analysisId: string,
): Promise<string> {
  const row = await tx.batchLabAnalysis.findUniqueOrThrow({
    where: { id: analysisId },
    include: {
      bottlingBatch: { select: { finalAlcoholAbv: true, productType: true } },
    },
  });
  const productType: LotProductType | null =
    lot.productType ??
    (row.bottlingBatch.productType === 'SINGANI'
      ? 'SINGANI'
      : row.bottlingBatch.productType === 'WINE'
        ? 'WINE'
        : null);
  const conformity = computeLabConformity({
    productType,
    values: {
      actualAlcoholAbv: row.actualAlcoholAbv.toNumber(),
      volatileAcidityAceticGl: row.volatileAcidityAceticGl.toNumber(),
      methanolMg100mlAa: num(row.methanolMg100mlAa),
      copperContentMgL: num(row.copperContentMgL),
    },
    limits: lot.rules.lab.limits,
    labeledAbv: row.bottlingBatch.finalAlcoholAbv.toNumber(),
    rulesTakenAt: lot.rules.takenAt,
  });
  await tx.batchLabAnalysis.update({
    where: { id: analysisId },
    data: {
      conformity: conformity as unknown as Prisma.InputJsonObject,
      conformityStatus: conformity.status,
      conformsToSenasagStandards: conformity.status === 'CONFORMING',
    },
  });
  return conformity.status;
}

/**
 * El embotellado guarda los litros disponibles de sus fuentes: si una
 * corrección cambia el volumen de una fuente ya embotellada, el balance del
 * embotellado sigue a los valores vigentes.
 */
async function syncBottlingAvailable(tx: Tx, lotId: string): Promise<void> {
  const bottling = await tx.bottlingBatch.findUnique({
    where: { lotId },
    select: { id: true, availableLiters: true },
  });
  if (!bottling) return;
  const [agings, distillations] = await Promise.all([
    tx.wineAgingBatch.findMany({
      where: { lotId, agingStatus: AgingStatusEnum.BOTTLED },
      select: { volumeLiters: true },
    }),
    tx.productionBatch.findMany({
      where: { lotId, restStatus: RestStatusEnum.BOTTLED },
      select: { heartLiters: true, outputVolumeLiters: true },
    }),
  ]);
  const liters = [
    ...agings.map((a) => num(a.volumeLiters)),
    ...distillations.map(
      (p) => num(p.heartLiters) ?? num(p.outputVolumeLiters),
    ),
  ];
  if (liters.length === 0 || liters.some((l) => l === null)) return;
  const available = round3((liters as number[]).reduce((s, l) => s + l, 0));
  if (sameValue(bottling.availableLiters, available)) return;
  await tx.bottlingBatch.update({
    where: { id: bottling.id },
    data: { availableLiters: new Prisma.Decimal(available) },
  });
}

/**
 * Tras una corrección de fechas o de meses, el estado persistido de los
 * candados sigue al cálculo: lo que ya no está cumplido vuelve a
 * `AGING`/`RESTING`, y lo que pasa a estarlo se libera (`LOCK_RELEASED`).
 */
async function syncLockStatuses(
  tx: Tx,
  lot: LockedLot,
  clock: DbClock,
  audit: AuditService,
): Promise<void> {
  const agings = await tx.wineAgingBatch.findMany({
    where: { lotId: lot.id, agingStatus: AgingStatusEnum.READY },
    select: {
      id: true,
      startDate: true,
      createdAt: true,
      plannedMonths: true,
      lockUntilDate: true,
    },
  });
  for (const a of agings) {
    const lock = agingLock(
      {
        id: a.id,
        startDate: a.startDate ? dateOnly(a.startDate) : laPazDate(a.createdAt),
        plannedMonths: a.plannedMonths,
        storedUnlockDate: dateOnly(a.lockUntilDate),
      },
      lot.rules,
      clock.today,
    );
    if (!lock.released) {
      await tx.wineAgingBatch.update({
        where: { id: a.id },
        data: { agingStatus: AgingStatusEnum.AGING },
      });
    }
  }
  const distillations = await tx.productionBatch.findMany({
    where: { lotId: lot.id, restStatus: RestStatusEnum.READY },
    select: { id: true, processEndDate: true, mandatoryRestUntil: true },
  });
  for (const p of distillations) {
    const lock = restLock(
      {
        id: p.id,
        processEndDate: p.processEndDate ? dateOnly(p.processEndDate) : null,
        storedUnlockDate: p.mandatoryRestUntil
          ? dateOnly(p.mandatoryRestUntil)
          : null,
      },
      lot.rules,
      clock.today,
    );
    if (!lock || !lock.released) {
      await tx.productionBatch.update({
        where: { id: p.id },
        data: { restStatus: RestStatusEnum.RESTING },
      });
    }
  }
  await releaseDueLocks(tx, lot, clock, audit);
}

/** Marca como corregidos los eventos de la línea de tiempo del registro. */
async function markCorrected(
  tx: Tx,
  lotId: string,
  applied: Applied,
): Promise<void> {
  if (applied.readingsDay === undefined) {
    await tx.lotEvent.updateMany({
      where: {
        lotId,
        resourceType: applied.resource.type,
        resourceId: applied.resource.id,
        type: { not: 'CORRECTION' },
      },
      data: { corrected: true },
    });
    return;
  }
  // Lecturas: solo el evento del día de la lectura corregida
  const events = await tx.lotEvent.findMany({
    where: {
      lotId,
      type: 'FERMENTATION_READINGS',
      resourceId: applied.resource.id,
    },
    select: { id: true, data: true },
  });
  const event = events.find(
    (e) => (e.data as Record<string, unknown>)?.day === applied.readingsDay,
  );
  if (event) {
    await tx.lotEvent.update({
      where: { id: event.id },
      data: { corrected: true },
    });
  }
}

function toCorrectionView(
  row: Prisma.TraceCorrectionGetPayload<object>,
  actors: Map<string, TraceActor>,
): CorrectionView {
  return {
    id: row.id,
    lotId: row.lotId,
    target: { type: row.targetType as CorrectionTargetType, id: row.targetId },
    kind: row.kind as CorrectionKind,
    changes: (Array.isArray(row.changes)
      ? row.changes
      : []) as unknown as CorrectionChange[],
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
    createdBy: actorOf(actors, row.createdByMembershipId),
  };
}
