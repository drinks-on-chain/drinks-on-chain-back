import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '@shared/prisma/prisma.service';
import { AUDIT_TX_OPTIONS, AuditService } from '@shared/audit/audit.service';
import { AuditAction } from '@shared/audit/audit.actions';
import { ValidationException } from '@shared/exceptions/validation.exception';
import { CreateBatchLabAnalysisDto } from '../dto/create-batch-lab-analysis.dto';
import { Prisma, BatchLabAnalysis } from '@prisma/client';
import { lockLot } from '@modules/lots/lot-records';
import { appendLotEvent } from '@modules/lots/lot-events';
import { actorMembership, dbClock } from '@modules/lots/trace-db';
import { ensureHarvestLot } from '@modules/lots/chain';
import {
  actorOf,
  resolveTraceActors,
  TraceActor,
} from '@modules/lots/trace-actors';
import {
  computeLabConformity,
  LAB_UNITS,
  LabConformity,
  methanolToAnhydrous,
} from '@modules/lots/domain/lab-conformity';
import type { LotProductType } from '@modules/lots/domain/lot-stage';
import { calendarDay } from '@modules/lots/domain/dates';
import { ruleError, violation } from '@modules/lots/domain/trace-errors';
import { ErrorCode } from '@shared/exceptions/error-codes';

export type LabAnalysisView = Omit<BatchLabAnalysis, 'conformity'> & {
  conformity: LabConformity | null;
  units: typeof LAB_UNITS;
  current: boolean;
  recordedBy: TraceActor | null;
  report: { key: string; sha256: string | null; url: string | null } | null;
};

@Injectable()
export class LabAnalysesService {
  private readonly logger = new Logger(LabAnalysesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Análisis de laboratorio (contrato O2 §8, EA-08): la conformidad se
   * calcula en el servidor contra los límites y unidades de la instantánea
   * del lote (`conformsToSenasagStandards` de la entrada se ignora); falta un
   * parámetro exigido → `INCOMPLETE` y no conforme. Un análisis nuevo
   * sustituye al anterior (reanálisis): ya no hay 409.
   */
  async create(
    wineryId: string,
    userId: string,
    dto: CreateBatchLabAnalysisDto,
  ): Promise<LabAnalysisView> {
    const abv = dto.actualAlcoholAbv;
    const fromMgL =
      dto.methanolContentMgL !== undefined
        ? methanolToAnhydrous(dto.methanolContentMgL, abv)
        : null;
    if (
      dto.methanolMg100mlAa !== undefined &&
      fromMgL !== null &&
      Math.abs(fromMgL - dto.methanolMg100mlAa) >
        Math.max(fromMgL, dto.methanolMg100mlAa) * 0.01
    ) {
      throw ValidationException.forField(
        'methanolMg100mlAa',
        `El metanol en mg/L (${dto.methanolContentMgL}) equivale a ${fromMgL} mg/100 mL a.a. con ${abv} % vol: no coincide con ${dto.methanolMg100mlAa}`,
      );
    }
    const methanolAa = dto.methanolMg100mlAa ?? fromMgL;

    const id = await this.prisma.$transaction(async (tx) => {
      const bottling = await tx.bottlingBatch.findFirst({
        where: { id: dto.bottlingBatchId, wineryId },
        include: {
          wineAgingBatch: {
            select: { fermentationTank: { select: { harvestBatchId: true } } },
          },
          productionBatch: {
            select: { fermentationTank: { select: { harvestBatchId: true } } },
          },
        },
      });
      if (!bottling) {
        throw new NotFoundException(
          `Lote de embotellado con ID ${dto.bottlingBatchId} no encontrado en esta bodega`,
        );
      }
      const harvestBatchId =
        bottling.wineAgingBatch?.fermentationTank.harvestBatchId ??
        bottling.productionBatch?.fermentationTank.harvestBatchId ??
        null;
      const lotId =
        bottling.lotId ??
        (harvestBatchId ? await ensureHarvestLot(tx, harvestBatchId) : null);
      const lot = lotId
        ? await lockLot(tx, lotId, wineryId, { writable: true })
        : null;
      const clock = await dbClock(tx);
      const testDay = calendarDay(dto.testPerformedAt);
      if (testDay > clock.today) {
        throw ruleError(
          ErrorCode.TRC_DATE_IN_FUTURE,
          'La fecha del ensayo no puede ser futura',
          [
            violation(ErrorCode.TRC_DATE_IN_FUTURE, 'Fecha futura', {
              field: 'testPerformedAt',
              expected: clock.today,
              actual: testDay,
            }),
          ],
        );
      }
      const productType: LotProductType | null =
        lot?.productType ??
        (bottling.productType === 'SINGANI'
          ? 'SINGANI'
          : bottling.productType === 'WINE'
            ? 'WINE'
            : null);
      const conformity = lot
        ? computeLabConformity({
            productType,
            values: {
              actualAlcoholAbv: abv,
              volatileAcidityAceticGl: dto.volatileAcidityAceticGl,
              methanolMg100mlAa: methanolAa,
              copperContentMgL: dto.copperContentMgL ?? null,
            },
            limits: lot.rules.lab.limits,
            labeledAbv: bottling.finalAlcoholAbv.toNumber(),
            rulesTakenAt: lot.rules.takenAt,
          })
        : null;
      const membership = await actorMembership(tx, userId, wineryId);
      const legacyMember = membership
        ? await tx.wineryMember.findUnique({
            where: { id: membership.id },
            select: { id: true },
          })
        : null;

      // Reanálisis: el anterior deja de ser el vigente
      await tx.batchLabAnalysis.updateMany({
        where: { bottlingBatchId: bottling.id, supersededAt: null },
        data: { supersededAt: clock.now },
      });
      const decimal = (v: number | undefined | null) =>
        v !== undefined && v !== null ? new Prisma.Decimal(v) : null;
      this.logger.log(
        `Registrando informe de laboratorio "${dto.accreditedLabCertificationCode}" por ${dto.certifiedLaboratoryName}: ${conformity?.status ?? 'sin lote'}`,
      );
      const created = await tx.batchLabAnalysis.create({
        data: {
          bottlingBatchId: bottling.id,
          certifiedLaboratoryName: dto.certifiedLaboratoryName,
          accreditedLabCertificationCode: dto.accreditedLabCertificationCode,
          analysisRequestDate: dto.analysisRequestDate
            ? new Date(dto.analysisRequestDate)
            : null,
          testPerformedAt: new Date(`${testDay}T00:00:00.000Z`),
          actualAlcoholAbv: new Prisma.Decimal(dto.actualAlcoholAbv),
          totalAlcoholAbv: decimal(dto.totalAlcoholAbv),
          totalAcidityTartaricGl: new Prisma.Decimal(
            dto.totalAcidityTartaricGl,
          ),
          volatileAcidityAceticGl: new Prisma.Decimal(
            dto.volatileAcidityAceticGl,
          ),
          freeSulfurDioxideMgL: decimal(dto.freeSulfurDioxideMgL),
          totalSulfurDioxideMgL: decimal(dto.totalSulfurDioxideMgL),
          reducingSugarsGl: decimal(dto.reducingSugarsGl),
          totalDryExtractGl: decimal(dto.totalDryExtractGl),
          sugarFreeDryExtractGl: decimal(dto.sugarFreeDryExtractGl),
          overpressureBar: decimal(dto.overpressureBar),
          methanolContentMgL: decimal(dto.methanolContentMgL),
          methanolMg100mlAa: decimal(methanolAa),
          copperContentMgL: decimal(dto.copperContentMgL),
          additionalParams: dto.additionalParams ?? Prisma.DbNull,
          laboratoryReportPdfUrl: dto.laboratoryReportPdfUrl,
          // Calculada (EA-08): el valor enviado se ignora
          conformsToSenasagStandards: conformity?.status === 'CONFORMING',
          conformsToEuStandards: dto.conformsToEuStandards ?? false,
          conformsToUsaStandards: dto.conformsToUsaStandards ?? false,
          reviewedByMemberId: legacyMember?.id ?? null,
          lotId: lot?.id ?? null,
          conformity: conformity
            ? (conformity as unknown as Prisma.InputJsonObject)
            : Prisma.DbNull,
          conformityStatus: conformity?.status ?? 'INCOMPLETE',
          createdByMembershipId: membership?.id ?? null,
        },
      });
      if (lot) {
        await appendLotEvent(tx, lot.id, {
          type: 'LAB_REGISTERED',
          occurredAt: created.testPerformedAt,
          stage: lot.stage,
          actorMembershipId: membership?.id ?? null,
          summary: `Análisis de ${dto.certifiedLaboratoryName}: ${conformity?.status}`,
          data: {
            conformity: conformity?.status,
            laboratory: dto.certifiedLaboratoryName,
          },
          resource: { type: 'lab_analysis', id: created.id },
        });
        await tx.lot.update({
          where: { id: lot.id },
          data: { updatedAt: clock.now },
        });
      }
      await this.audit.record(tx, {
        action: AuditAction.LAB_ANALYSIS_CREATED,
        resource: { type: 'lab_analysis', id: created.id },
        organizationId: wineryId,
        after: { ...created, conformity: conformity?.status ?? null },
      });
      return created.id;
    }, AUDIT_TX_OPTIONS);
    const row = await this.prisma.batchLabAnalysis.findUniqueOrThrow({
      where: { id },
    });
    const actors = await resolveTraceActors(this.prisma, [
      row.createdByMembershipId,
    ]);
    return toLabView(row, actors);
  }

  /** Análisis vigente del embotellado (el último sin sustituir). */
  async findByBatchId(
    wineryId: string | undefined,
    bottlingBatchId: string,
  ): Promise<LabAnalysisView> {
    const batch = await this.prisma.bottlingBatch.findFirst({
      where: {
        id: bottlingBatchId,
        ...(wineryId && { wineryId }),
      },
      include: { labAnalyses: { orderBy: { createdAt: 'desc' } } },
    });
    const current =
      batch?.labAnalyses.find((l) => l.supersededAt === null) ??
      batch?.labAnalyses[0];
    if (!batch || !current) {
      throw new NotFoundException(
        `Certificado de laboratorio para el lote ${bottlingBatchId} no encontrado`,
      );
    }
    const actors = await resolveTraceActors(this.prisma, [
      current.createdByMembershipId,
    ]);
    return toLabView(current, actors);
  }
}

export function toLabView(
  row: BatchLabAnalysis,
  actors: Map<string, TraceActor>,
): LabAnalysisView {
  return {
    ...row,
    conformity: (row.conformity as unknown as LabConformity | null) ?? null,
    units: LAB_UNITS,
    current: row.supersededAt === null,
    recordedBy: actorOf(actors, row.createdByMembershipId),
    report: row.laboratoryReportKey
      ? { key: row.laboratoryReportKey, sha256: null, url: null }
      : row.laboratoryReportPdfUrl
        ? {
            key: row.laboratoryReportPdfUrl,
            sha256: null,
            url: row.laboratoryReportPdfUrl,
          }
        : null,
  };
}
