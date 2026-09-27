import {
  Injectable,
  NotFoundException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '@shared/prisma/prisma.service';
import { AuditService } from '@shared/audit/audit.service';
import { AuditAction } from '@shared/audit/audit.actions';
import { CreateBatchLabAnalysisDto } from '../dto/create-batch-lab-analysis.dto';
import { Prisma, BatchLabAnalysis } from '@prisma/client';

@Injectable()
export class LabAnalysesService {
  private readonly logger = new Logger(LabAnalysesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(
    wineryId: string,
    userId: string,
    dto: CreateBatchLabAnalysisDto,
  ): Promise<BatchLabAnalysis> {
    const bottlingBatch = await this.prisma.bottlingBatch.findFirst({
      where: { id: dto.bottlingBatchId, wineryId },
      include: { labAnalysis: true },
    });

    if (!bottlingBatch) {
      throw new NotFoundException(
        `Lote de embotellado con ID ${dto.bottlingBatchId} no encontrado en esta bodega`,
      );
    }

    if (bottlingBatch.labAnalysis) {
      throw new ConflictException(
        `El lote ${bottlingBatch.internationalLotCode} ya cuenta con un certificado de laboratorio oficial registrado`,
      );
    }

    // Validación toxicológica automatizada (SENASAG / Norma Boliviana NB 324001)
    let conformsToSenasag = dto.conformsToSenasagStandards ?? true;
    if (
      dto.methanolContentMgL !== undefined &&
      dto.methanolContentMgL > 200.0
    ) {
      conformsToSenasag = false;
      this.logger.warn(
        `Alerta toxicológica: Metanol de ${dto.methanolContentMgL} mg/100ml excede límite legal (<200 mg/100ml)`,
      );
    }

    if (dto.copperContentMgL !== undefined && dto.copperContentMgL > 0.05) {
      conformsToSenasag = false;
      this.logger.warn(
        `Alerta toxicológica: Cobre de ${dto.copperContentMgL} mg/L excede límite legal (<0.05 mg/L)`,
      );
    }

    let reviewedByMemberId: string | null = null;
    const member = await this.prisma.wineryMember.findFirst({
      where: { userId, wineryId, isActive: true },
    });
    if (member) {
      reviewedByMemberId = member.id;
    }

    this.logger.log(
      `Registrando informe de laboratorio "${dto.accreditedLabCertificationCode}" por ${dto.certifiedLaboratoryName}`,
    );

    return this.audit.transaction(
      (tx) =>
        tx.batchLabAnalysis.create({
          data: {
            bottlingBatchId: dto.bottlingBatchId,
            certifiedLaboratoryName: dto.certifiedLaboratoryName,
            accreditedLabCertificationCode: dto.accreditedLabCertificationCode,
            analysisRequestDate: dto.analysisRequestDate
              ? new Date(dto.analysisRequestDate)
              : null,
            testPerformedAt: new Date(dto.testPerformedAt),
            actualAlcoholAbv: new Prisma.Decimal(dto.actualAlcoholAbv),
            totalAlcoholAbv:
              dto.totalAlcoholAbv !== undefined
                ? new Prisma.Decimal(dto.totalAlcoholAbv)
                : null,
            totalAcidityTartaricGl: new Prisma.Decimal(
              dto.totalAcidityTartaricGl,
            ),
            volatileAcidityAceticGl: new Prisma.Decimal(
              dto.volatileAcidityAceticGl,
            ),
            freeSulfurDioxideMgL:
              dto.freeSulfurDioxideMgL !== undefined
                ? new Prisma.Decimal(dto.freeSulfurDioxideMgL)
                : null,
            totalSulfurDioxideMgL:
              dto.totalSulfurDioxideMgL !== undefined
                ? new Prisma.Decimal(dto.totalSulfurDioxideMgL)
                : null,
            reducingSugarsGl:
              dto.reducingSugarsGl !== undefined
                ? new Prisma.Decimal(dto.reducingSugarsGl)
                : null,
            totalDryExtractGl:
              dto.totalDryExtractGl !== undefined
                ? new Prisma.Decimal(dto.totalDryExtractGl)
                : null,
            sugarFreeDryExtractGl:
              dto.sugarFreeDryExtractGl !== undefined
                ? new Prisma.Decimal(dto.sugarFreeDryExtractGl)
                : null,
            overpressureBar:
              dto.overpressureBar !== undefined
                ? new Prisma.Decimal(dto.overpressureBar)
                : null,
            methanolContentMgL:
              dto.methanolContentMgL !== undefined
                ? new Prisma.Decimal(dto.methanolContentMgL)
                : null,
            copperContentMgL:
              dto.copperContentMgL !== undefined
                ? new Prisma.Decimal(dto.copperContentMgL)
                : null,
            additionalParams: dto.additionalParams ?? Prisma.DbNull,
            laboratoryReportPdfUrl: dto.laboratoryReportPdfUrl,
            conformsToSenasagStandards: conformsToSenasag,
            conformsToEuStandards: dto.conformsToEuStandards ?? false,
            conformsToUsaStandards: dto.conformsToUsaStandards ?? false,
            reviewedByMemberId,
          },
        }),
      (created) => ({
        action: AuditAction.LAB_ANALYSIS_CREATED,
        resource: { type: 'lab_analysis', id: created.id },
        organizationId: wineryId,
        after: created,
      }),
    );
  }

  async findByBatchId(
    wineryId: string | undefined,
    bottlingBatchId: string,
  ): Promise<BatchLabAnalysis> {
    const batch = await this.prisma.bottlingBatch.findFirst({
      where: {
        id: bottlingBatchId,
        ...(wineryId && { wineryId }),
      },
      include: { labAnalysis: true },
    });

    if (!batch || !batch.labAnalysis) {
      throw new NotFoundException(
        `Certificado de laboratorio para el lote ${bottlingBatchId} no encontrado`,
      );
    }

    return batch.labAnalysis;
  }
}
