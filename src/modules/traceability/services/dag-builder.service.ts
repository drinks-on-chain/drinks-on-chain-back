import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '@shared/prisma/prisma.service';
import { AppException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';
import type { AuthenticatedUser } from '@shared/decorators/current-user.decorator';
import { PLATFORM_WINERY_READERS } from '@modules/organizations/organization.constants';
import { resolveTraceActors, TraceActor } from '@modules/lots/trace-actors';
import { distillationHeart, num } from '@modules/lots/domain/sources';

export interface DagNode {
  batchId: string;
  stage: number;
  stageName: string;
  parents: string[];
  timestamp: string;
  volumeOrUnits: number;
  metrics: number[];
  metadataHash: string;
  isCertified: boolean;
  operator: {
    name: string;
    role: string;
    wineryName: string;
  };
  details: Record<string, unknown>;
}

export interface DagGraphResult {
  rootBatchId: string;
  internationalLotCode: string;
  productType: string;
  nodes: DagNode[];
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Operador sin registrar (datos anteriores a la Ola 2): nada inventado (EA-05). */
const NOT_RECORDED = 'No registrado';

const DAG_INCLUDE = {
  winery: true,
  lot: { select: { dossier: { select: { status: true } } } },
  labAnalyses: { orderBy: { createdAt: 'desc' as const } },
  wineAgingBatch: {
    include: {
      fermentationTank: {
        include: {
          harvestBatch: {
            include: {
              terroir: true,
              maturityAnalyses: {
                where: { voidedAt: null },
                orderBy: { measuredAt: 'desc' as const },
                take: 1,
              },
            },
          },
        },
      },
    },
  },
  productionBatch: {
    include: {
      fermentationTank: {
        include: {
          harvestBatch: {
            include: {
              terroir: true,
              maturityAnalyses: {
                where: { voidedAt: null },
                orderBy: { measuredAt: 'desc' as const },
                take: 1,
              },
            },
          },
        },
      },
    },
  },
};

@Injectable()
export class DagBuilderService {
  private readonly logger = new Logger(DagBuilderService.name);

  constructor(private readonly prisma: PrismaService) {}

  private computeHash(input: string): string {
    return '0x' + crypto.createHash('sha256').update(input).digest('hex');
  }

  private computeMetadataHash(metadata: Record<string, unknown>): string {
    const canonical = JSON.stringify(metadata, Object.keys(metadata).sort());
    return '0x' + crypto.createHash('sha256').update(canonical).digest('hex');
  }

  /**
   * Grafo del embotellado para una sesión (SE-07): solo los miembros de la
   * bodega dueña y el personal de plataforma que lee bodegas; cualquier otra
   * sesión → 404 (nunca 403: no se revela que existe).
   */
  async buildDagForUser(
    user: AuthenticatedUser,
    bottlingBatchId: string,
  ): Promise<DagGraphResult> {
    const owner = await this.prisma.bottlingBatch.findUnique({
      where: { id: bottlingBatchId },
      select: { wineryId: true },
    });
    const isOwnerMember =
      user.organizationType === 'WINERY' &&
      owner !== null &&
      user.organizationId === owner.wineryId;
    const isPlatformReader =
      user.organizationType === 'PLATFORM' &&
      (PLATFORM_WINERY_READERS as readonly string[]).includes(user.role ?? '');
    if (!owner || !(isOwnerMember || isPlatformReader)) {
      throw new AppException(
        404,
        ErrorCode.NOT_FOUND,
        `Lote de embotellado con identificador "${bottlingBatchId}" no encontrado`,
      );
    }
    return this.buildDag({ id: bottlingBatchId });
  }

  /**
   * Pasaporte legado por código de lote (`/traceability/public/{lotCode}`,
   * hasta H2): solo por código de lote, nunca por id (que se saltaba SE-07).
   */
  async buildPublicDag(lotCode: string): Promise<DagGraphResult> {
    if (UUID_RE.test(lotCode)) {
      throw new NotFoundException(
        `Lote de embotellado con código "${lotCode}" no encontrado`,
      );
    }
    return this.buildDag({ internationalLotCode: lotCode });
  }

  /**
   * Grafo con datos reales (EA-05): sin métricas de relleno, operador desde
   * la membresía que registró cada etapa ("No registrado" si falta) e
   * `isCertified` = expediente del lote cerrado.
   */
  private async buildDag(
    where: { id: string } | { internationalLotCode: string },
  ): Promise<DagGraphResult> {
    const batch = await this.prisma.bottlingBatch.findFirst({
      where,
      include: DAG_INCLUDE,
    });

    if (!batch) {
      throw new NotFoundException(
        `Lote de embotellado con identificador "${'id' in where ? where.id : where.internationalLotCode}" no encontrado`,
      );
    }

    const wineryName = batch.winery.commercialName;
    const certified = batch.lot?.dossier?.status === 'CLOSED';
    const nodes: DagNode[] = [];

    const intermediate = batch.wineAgingBatch ?? batch.productionBatch;
    const tank = intermediate?.fermentationTank;
    const harvest = tank?.harvestBatch;
    const terroir = harvest?.terroir;
    const maturity = harvest?.maturityAnalyses[0];
    const lab =
      batch.labAnalyses.find((l) => l.supersededAt === null) ??
      batch.labAnalyses[0] ??
      null;

    const actors = await resolveTraceActors(this.prisma, [
      harvest?.createdByMembershipId,
      tank?.createdByMembershipId,
      batch.wineAgingBatch?.createdByMembershipId,
      batch.productionBatch?.createdByMembershipId,
      batch.createdByMembershipId,
      batch.releasedByMemberId,
    ]);
    const operator = (...ids: (string | null | undefined)[]) => {
      const actor = ids
        .map((id) => (id ? actors.get(id) : undefined))
        .find((a): a is TraceActor => !!a);
      return actor
        ? { name: actor.fullName, role: actor.role, wineryName }
        : { name: NOT_RECORDED, role: 'NOT_RECORDED', wineryName };
    };

    let plotHash = '';
    let harvestHash = '';
    let vinificationHash = '';
    let intermediateHash = '';

    // 0. Parcela
    if (terroir) {
      plotHash = this.computeHash(`TERROIR-${terroir.id}`);
      const plotDetails = {
        parcelName: terroir.parcelName,
        varietyName: terroir.varietyName,
        altitudeMasl: Number(terroir.altitudeMasl),
        surfaceHectares: Number(terroir.surfaceHectares),
        isDoEligible: terroir.isDoEligible,
      };
      nodes.push({
        batchId: plotHash,
        stage: 0,
        stageName: 'Plot',
        parents: [],
        timestamp: terroir.createdAt.toISOString(),
        volumeOrUnits: Number(terroir.surfaceHectares),
        metrics: [Math.round(Number(terroir.altitudeMasl) * 100)],
        metadataHash: this.computeMetadataHash(plotDetails),
        isCertified: certified,
        operator: operator(),
        details: plotDetails,
      });
    }

    // 1. Vendimia (madurez del último análisis; sin análisis, sin métricas)
    if (harvest) {
      harvestHash = this.computeHash(`HARVEST-${harvest.id}`);
      const harvestDetails = {
        harvestBatchCode: harvest.harvestBatchCode,
        grossWeightKg: Number(harvest.grossWeightKg),
        tareWeightKg: Number(harvest.tareWeightKg),
        netWeightKg: Number(harvest.netWeightKg),
        brixDegrees: maturity ? maturity.brixDegrees.toNumber() : null,
        initialPh: maturity ? maturity.ph.toNumber() : null,
        initialAcidityGl: maturity ? maturity.acidityGl.toNumber() : null,
        phytosanitaryStatus: harvest.phytosanitaryStatus,
      };
      nodes.push({
        batchId: harvestHash,
        stage: 1,
        stageName: 'Harvest',
        parents: plotHash ? [plotHash] : [],
        timestamp: harvest.intakeDate.toISOString(),
        volumeOrUnits: Number(harvest.netWeightKg),
        metrics: maturity
          ? [
              Math.round(maturity.brixDegrees.toNumber() * 100),
              Math.round(maturity.ph.toNumber() * 100),
              Math.round(maturity.acidityGl.toNumber() * 100),
            ]
          : [],
        metadataHash: this.computeMetadataHash(harvestDetails),
        isCertified: certified,
        operator: operator(
          harvest.createdByMembershipId,
          harvest.certifiedByMemberId,
        ),
        details: harvestDetails,
      });
    }

    // 2. Vinificación (no hay grado ni acidez registrados en el tanque: sin métricas)
    if (tank) {
      vinificationHash = this.computeHash(`TANK-${tank.id}`);
      const tankDetails = {
        tankCode: tank.tankCode,
        material: tank.material,
        volumeFilledLiters: num(tank.volumeFilledLiters),
        destinationType: tank.destinationType,
      };
      nodes.push({
        batchId: vinificationHash,
        stage: 2,
        stageName: 'Vinification',
        parents: harvestHash ? [harvestHash] : [],
        timestamp: tank.startDate.toISOString(),
        volumeOrUnits: Number(tank.volumeFilledLiters ?? 0),
        metrics: [],
        metadataHash: this.computeMetadataHash(tankDetails),
        isCertified: certified,
        operator: operator(tank.createdByMembershipId),
        details: tankDetails,
      });
    }

    // 3 o 4. Crianza o destilación
    if (batch.wineAgingBatch) {
      const aging = batch.wineAgingBatch;
      intermediateHash = this.computeHash(`AGING-${aging.id}`);
      const agingDetails = {
        containerType: aging.containerType,
        containerMaterial: aging.containerMaterial,
        plannedMonths: aging.plannedMonths,
        lockUntilDate: aging.lockUntilDate.toISOString().split('T')[0],
      };
      nodes.push({
        batchId: intermediateHash,
        stage: 3,
        stageName: 'Aging',
        parents: vinificationHash ? [vinificationHash] : [],
        timestamp: (aging.startDate ?? aging.createdAt).toISOString(),
        volumeOrUnits: Number(aging.volumeLiters ?? 0),
        metrics: [aging.plannedMonths * 100],
        metadataHash: this.computeMetadataHash(agingDetails),
        isCertified: certified,
        operator: operator(aging.createdByMembershipId),
        details: agingDetails,
      });
    } else if (batch.productionBatch) {
      const prod = batch.productionBatch;
      const heart = distillationHeart(prod);
      intermediateHash = this.computeHash(`DISTILLATION-${prod.id}`);
      const distDetails = {
        equipmentIdentifier: prod.equipmentIdentifier,
        inputVolumeLiters: num(prod.inputVolumeLiters),
        outputVolumeLiters: num(prod.outputVolumeLiters),
        wasteVolumeLiters: num(prod.wasteVolumeLiters),
        initialAlcoholPercentage: num(prod.initialAlcoholPercentage),
        restStatus: prod.restStatus,
      };
      nodes.push({
        batchId: intermediateHash,
        stage: 4,
        stageName: 'Distillation',
        parents: vinificationHash ? [vinificationHash] : [],
        timestamp: prod.processStartDate.toISOString(),
        volumeOrUnits: Number(heart.liters ?? 0),
        metrics: heart.abv !== null ? [Math.round(heart.abv * 100)] : [],
        metadataHash: this.computeMetadataHash(distDetails),
        isCertified: certified,
        operator: operator(prod.createdByMembershipId),
        details: distDetails,
      });
    }

    // 5. Embotellado
    const bottlingHash = this.computeHash(`BOTTLING-${batch.id}`);
    const bottlingDetails = {
      internationalLotCode: batch.internationalLotCode,
      productType: batch.productType,
      finalAlcoholAbv: Number(batch.finalAlcoholAbv),
      waterDilutionLiters: num(batch.waterDilutionLiters),
      totalBottlesPackaged: batch.totalBottlesPackaged,
      packagingFormatCl: batch.packagingFormatCl,
      qrBatchUrl: batch.qrBatchUrl,
    };
    nodes.push({
      batchId: bottlingHash,
      stage: 5,
      stageName: 'Bottling',
      parents: intermediateHash ? [intermediateHash] : [],
      timestamp: batch.bottlingDate.toISOString(),
      volumeOrUnits: batch.totalBottlesPackaged,
      metrics: [
        Math.round(Number(batch.finalAlcoholAbv) * 100),
        batch.packagingFormatCl * 10,
      ],
      metadataHash: this.computeMetadataHash(bottlingDetails),
      isCertified: certified,
      operator: operator(batch.createdByMembershipId, batch.releasedByMemberId),
      details: {
        ...bottlingDetails,
        labAnalysis: lab
          ? {
              certifiedLaboratoryName: lab.certifiedLaboratoryName,
              accreditedLabCertificationCode:
                lab.accreditedLabCertificationCode,
              actualAlcoholAbv: Number(lab.actualAlcoholAbv),
              methanolContentMgL: num(lab.methanolContentMgL),
              methanolMg100mlAa: num(lab.methanolMg100mlAa),
              conformityStatus: lab.conformityStatus,
              conformsToSenasagStandards: lab.conformsToSenasagStandards,
            }
          : null,
      },
    });

    this.logger.log(
      `Grafo DAG reconstruido para el lote ${batch.internationalLotCode} (${nodes.length} nodos)`,
    );

    return {
      rootBatchId: bottlingHash,
      internationalLotCode: batch.internationalLotCode,
      productType: batch.productType,
      nodes,
    };
  }
}
