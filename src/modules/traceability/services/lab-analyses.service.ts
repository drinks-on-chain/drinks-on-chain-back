import { Inject, Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '@shared/prisma/prisma.service';
import { AUDIT_TX_OPTIONS, AuditService } from '@shared/audit/audit.service';
import { AuditAction } from '@shared/audit/audit.actions';
import { ValidationException } from '@shared/exceptions/validation.exception';
import {
  PaginationQueryDto,
  toPage,
  toPrismaPage,
} from '@shared/dto/pagination-query.dto';
import type { Paginated } from '@shared/interfaces/api-response.interface';
import {
  ObjectStorage,
  STORAGE_SERVICE,
} from '@shared/storage/storage.interface';
import { Prisma, BatchLabAnalysis } from '@prisma/client';
import { CreateLotLabAnalysisDto } from '@modules/lots/contract/dto/lot-lab-analyses.dto';
import {
  CorrectionMarks,
  correctionMarks,
  withMarks,
} from '@modules/lots/correction-marks';
import { lockLot, LockedLot } from '@modules/lots/lot-records';
import { assertDossierOpen } from '@modules/lots/lot-dossier';
import { appendLotEvent } from '@modules/lots/lot-events';
import {
  actorMembership,
  dbClock,
  DbClock,
  lockLotRow,
} from '@modules/lots/trace-db';
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
import { calendarDay, dateOnly } from '@modules/lots/domain/dates';
import { assertDayNotFuture, assertNotBefore } from '@modules/lots/date-rules';
import { assertWineryFile, signedFileUrl } from '@modules/lots/trace-files';
import {
  lotNotFound,
  stateError,
  violation,
} from '@modules/lots/domain/trace-errors';
import { ErrorCode } from '@shared/exceptions/error-codes';

type Tx = Prisma.TransactionClient;

export type LabAnalysisView = Omit<BatchLabAnalysis, 'conformity'> &
  CorrectionMarks & {
    conformity: LabConformity | null;
    units: typeof LAB_UNITS;
    current: boolean;
    recordedBy: TraceActor | null;
    report: { key: string; sha256: string | null; url: string | null } | null;
  };

/** Valores de un análisis (sin el informe, que va con su huella). */
type LabValuesInput = Omit<CreateLotLabAnalysisDto, 'laboratoryReportKey'>;

interface BottlingRef {
  id: string;
  productType: string;
  finalAlcoholAbv: Prisma.Decimal;
  bottlingDate: Date;
}

@Injectable()
export class LabAnalysesService {
  private readonly logger = new Logger(LabAnalysesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(STORAGE_SERVICE) private readonly storage: ObjectStorage,
  ) {}

  /**
   * Análisis del lote (`POST /v1/lots/{id}/lab-analyses`, §8.1): solo con el
   * lote embotellado y el expediente abierto; el informe va por su `key` de
   * `POST /v1/uploads` y se guarda con su huella SHA-256. La conformidad se
   * calcula en el servidor contra los límites y las unidades de la
   * instantánea del lote (EA-08): falta un parámetro exigido → `INCOMPLETE`
   * y no conforme. Un análisis nuevo sustituye al vigente (reanálisis).
   */
  async createForLot(
    wineryId: string,
    userId: string,
    lotId: string,
    dto: CreateLotLabAnalysisDto,
  ): Promise<LabAnalysisView> {
    const methanolAa = resolveMethanol(dto);
    const reportSha256 = await assertWineryFile(
      this.storage,
      wineryId,
      dto.laboratoryReportKey,
      'laboratoryReportKey',
      'El informe del laboratorio no existe o no es de esta bodega',
    );
    const id = await this.prisma.$transaction(async (tx) => {
      await lockLotRow(tx, lotId);
      const row = await tx.lot.findFirst({
        where: { id: lotId, wineryId },
        select: {
          stage: true,
          bottlingBatch: {
            select: {
              id: true,
              productType: true,
              finalAlcoholAbv: true,
              bottlingDate: true,
            },
          },
        },
      });
      if (!row) throw lotNotFound();
      // Antes que la etapa terminal: el motivo exacto es el expediente
      await assertDossierOpen(tx, lotId);
      const lot = await lockLot(tx, lotId, wineryId, { writable: true });
      if (!row.bottlingBatch) {
        throw stateError(
          ErrorCode.TRC_LOT_NOT_BOTTLED,
          `El lote está en etapa ${lot.stage}: el análisis de laboratorio se registra tras el embotellado`,
          [
            violation(ErrorCode.TRC_LOT_NOT_BOTTLED, 'Lote sin embotellar', {
              meta: { stage: lot.stage },
            }),
          ],
        );
      }
      const clock = await dbClock(tx);
      const testDay = calendarDay(dto.testPerformedAt);
      assertDayNotFuture('testPerformedAt', testDay, clock);
      assertNotBefore(
        'testPerformedAt',
        testDay,
        dateOnly(row.bottlingBatch.bottlingDate),
        'El ensayo no puede ser anterior al embotellado',
      );
      return this.register(tx, {
        wineryId,
        userId,
        bottling: row.bottlingBatch,
        lot,
        clock,
        values: dto,
        methanolAa,
        report: { key: dto.laboratoryReportKey, sha256: reportSha256 },
        testDay,
      });
    }, AUDIT_TX_OPTIONS);
    return this.findView(id);
  }

  /** Todos los análisis del lote, el más reciente primero (§8.1). */
  async listForLot(
    wineryId: string | undefined,
    lotId: string,
    query: PaginationQueryDto,
  ): Promise<Paginated<LabAnalysisView>> {
    const lot = await this.prisma.lot.findFirst({
      where: { id: lotId, ...(wineryId && { wineryId }) },
      select: { id: true },
    });
    if (!lot) throw lotNotFound();
    const where = { lotId };
    const [rows, total] = await Promise.all([
      this.prisma.batchLabAnalysis.findMany({
        where,
        ...toPrismaPage(query),
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      }),
      this.prisma.batchLabAnalysis.count({ where }),
    ]);
    return toPage(await this.toViews(rows), total, query);
  }

  /** Análisis vigente del embotellado (el último sin sustituir ni anular). */
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
      batch?.labAnalyses.find(
        (l) => l.supersededAt === null && l.voidedAt === null,
      ) ??
      batch?.labAnalyses.find((l) => l.voidedAt === null) ??
      batch?.labAnalyses[0];
    if (!batch || !current) {
      throw new NotFoundException(
        `Certificado de laboratorio para el lote ${bottlingBatchId} no encontrado`,
      );
    }
    return (await this.toViews([current]))[0];
  }

  /**
   * Alta del análisis: fecha no futura, conformidad calculada, sustitución
   * del vigente, evento `LAB_REGISTERED` y bitácora.
   */
  private async register(
    tx: Tx,
    input: {
      wineryId: string;
      userId: string;
      bottling: BottlingRef;
      lot: LockedLot;
      clock: DbClock;
      values: LabValuesInput;
      methanolAa: number | null;
      report: { key: string; sha256: string };
      testDay: string;
    },
  ): Promise<string> {
    const { bottling, lot, clock, values: dto, testDay } = input;
    assertDayNotFuture('testPerformedAt', testDay, clock);
    const productType: LotProductType | null =
      lot.productType ??
      (bottling.productType === 'SINGANI'
        ? 'SINGANI'
        : bottling.productType === 'WINE'
          ? 'WINE'
          : null);
    const conformity = computeLabConformity({
      productType,
      values: {
        actualAlcoholAbv: dto.actualAlcoholAbv,
        volatileAcidityAceticGl: dto.volatileAcidityAceticGl,
        methanolMg100mlAa: input.methanolAa,
        copperContentMgL: dto.copperContentMgL ?? null,
      },
      limits: lot.rules.lab.limits,
      labeledAbv: bottling.finalAlcoholAbv.toNumber(),
      rulesTakenAt: lot.rules.takenAt,
    });
    const membership = await actorMembership(tx, input.userId, input.wineryId);
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
      `Registrando informe de laboratorio "${dto.accreditedLabCertificationCode}" por ${dto.certifiedLaboratoryName}: ${conformity.status}`,
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
        totalAcidityTartaricGl: new Prisma.Decimal(dto.totalAcidityTartaricGl),
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
        methanolMg100mlAa: decimal(input.methanolAa),
        copperContentMgL: decimal(dto.copperContentMgL),
        additionalParams:
          (dto.additionalParams as Prisma.InputJsonObject | undefined) ??
          Prisma.DbNull,
        // Columna anterior a la Ola 2 (obligatoria): guarda la misma `key`
        laboratoryReportPdfUrl: input.report.key,
        laboratoryReportKey: input.report.key,
        laboratoryReportSha256: input.report.sha256,
        // Calculada (EA-08): no es un dato de la entrada
        conformsToSenasagStandards: conformity.status === 'CONFORMING',
        conformsToEuStandards: dto.conformsToEuStandards ?? false,
        conformsToUsaStandards: dto.conformsToUsaStandards ?? false,
        reviewedByMemberId: legacyMember?.id ?? null,
        lotId: lot.id,
        conformity: conformity as unknown as Prisma.InputJsonObject,
        conformityStatus: conformity.status,
        createdByMembershipId: membership?.id ?? null,
      },
    });
    await appendLotEvent(tx, lot.id, {
      type: 'LAB_REGISTERED',
      occurredAt: created.testPerformedAt,
      stage: lot.stage,
      actorMembershipId: membership?.id ?? null,
      summary: `Análisis de ${dto.certifiedLaboratoryName}: ${conformity.status}`,
      data: {
        conformity: conformity.status,
        laboratory: dto.certifiedLaboratoryName,
      },
      resource: { type: 'lab_analysis', id: created.id },
    });
    await tx.lot.update({
      where: { id: lot.id },
      data: { updatedAt: clock.now },
    });
    await this.audit.record(tx, {
      action: AuditAction.LAB_ANALYSIS_CREATED,
      resource: { type: 'lab_analysis', id: created.id },
      organizationId: input.wineryId,
      after: { ...created, conformity: conformity.status },
    });
    return created.id;
  }

  private async findView(id: string): Promise<LabAnalysisView> {
    const row = await this.prisma.batchLabAnalysis.findUniqueOrThrow({
      where: { id },
    });
    return (await this.toViews([row]))[0];
  }

  /** Vistas con autor, marcas de corrección y URL firmada del informe. */
  private async toViews(rows: BatchLabAnalysis[]): Promise<LabAnalysisView[]> {
    const [actors, marks] = await Promise.all([
      resolveTraceActors(
        this.prisma,
        rows.map((r) => r.createdByMembershipId),
      ),
      correctionMarks(
        this.prisma,
        'LAB_ANALYSIS',
        rows.map((r) => r.id),
      ),
    ]);
    return Promise.all(
      rows.map(async (row) => {
        const view = withMarks(toLabView(row, actors), marks);
        if (view.report && row.laboratoryReportKey) {
          view.report.url = await signedFileUrl(
            this.storage,
            row.laboratoryReportKey,
          );
        }
        return view;
      }),
    );
  }
}

/**
 * Metanol en mg/100 mL de alcohol anhidro (§8.2): el enviado o el convertido
 * desde mg/L de producto (`10 × mgL / grado`); si llegan ambos y difieren más
 * de un 1 % → 422 `VALIDATION_ERROR`.
 */
export function resolveMethanol(dto: {
  actualAlcoholAbv: number;
  methanolContentMgL?: number;
  methanolMg100mlAa?: number;
}): number | null {
  const fromMgL =
    dto.methanolContentMgL !== undefined
      ? methanolToAnhydrous(dto.methanolContentMgL, dto.actualAlcoholAbv)
      : null;
  if (
    dto.methanolMg100mlAa !== undefined &&
    fromMgL !== null &&
    Math.abs(fromMgL - dto.methanolMg100mlAa) >
      Math.max(fromMgL, dto.methanolMg100mlAa) * 0.01
  ) {
    throw ValidationException.forField(
      'methanolMg100mlAa',
      `El metanol en mg/L (${dto.methanolContentMgL}) equivale a ${fromMgL} mg/100 mL a.a. con ${dto.actualAlcoholAbv} % vol: no coincide con ${dto.methanolMg100mlAa}`,
    );
  }
  return dto.methanolMg100mlAa ?? fromMgL;
}

export function toLabView(
  row: BatchLabAnalysis,
  actors: Map<string, TraceActor>,
): Omit<LabAnalysisView, keyof CorrectionMarks> {
  return {
    ...row,
    conformity: (row.conformity as unknown as LabConformity | null) ?? null,
    units: LAB_UNITS,
    current: row.supersededAt === null && row.voidedAt === null,
    recordedBy: actorOf(actors, row.createdByMembershipId),
    report: row.laboratoryReportKey
      ? {
          key: row.laboratoryReportKey,
          sha256: row.laboratoryReportSha256,
          url: null,
        }
      : row.laboratoryReportPdfUrl
        ? {
            key: row.laboratoryReportPdfUrl,
            sha256: null,
            url: row.laboratoryReportPdfUrl,
          }
        : null,
  };
}
