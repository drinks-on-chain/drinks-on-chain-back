import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '@shared/prisma/prisma.service';

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

  async buildDagForBottlingBatch(identifier: string): Promise<DagGraphResult> {
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        identifier,
      );

    const batch = await this.prisma.bottlingBatch.findFirst({
      where: isUuid ? { id: identifier } : { internationalLotCode: identifier },
      include: {
        winery: true,
        labAnalysis: true,
        wineAgingBatch: {
          include: {
            fermentationTank: {
              include: {
                harvestBatch: {
                  include: { terroir: true },
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
                  include: { terroir: true },
                },
              },
            },
          },
        },
      },
    });

    if (!batch) {
      throw new NotFoundException(
        `Lote de embotellado con identificador "${identifier}" no encontrado`,
      );
    }

    const wineryName = batch.winery.commercialName;
    const nodes: DagNode[] = [];

    // Resolver cadena hacia atrás
    const intermediate = batch.wineAgingBatch ?? batch.productionBatch;
    const tank = intermediate?.fermentationTank;
    const harvest = tank?.harvestBatch;
    const terroir = harvest?.terroir;

    let plotHash = '';
    let harvestHash = '';
    let vinificationHash = '';
    let intermediateHash = '';
    let bottlingHash = '';

    // 0. Nodo Parcela (Stage::Plot = 0)
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
        isCertified: terroir.isDoEligible,
        operator: {
          name: 'Ingeniero Agrónomo',
          role: 'Agronomist',
          wineryName,
        },
        details: plotDetails,
      });
    }

    // 1. Nodo Vendimia (Stage::Harvest = 1)
    if (harvest) {
      harvestHash = this.computeHash(`HARVEST-${harvest.id}`);
      const harvestDetails = {
        harvestBatchCode: harvest.harvestBatchCode,
        grossWeightKg: Number(harvest.grossWeightKg),
        tareWeightKg: Number(harvest.tareWeightKg),
        netWeightKg: Number(harvest.netWeightKg),
        brixDegrees: Number(harvest.brixDegrees),
        initialPh: Number(harvest.initialPh),
        initialAcidityGl: Number(harvest.initialAcidityGl),
        phytosanitaryStatus: harvest.phytosanitaryStatus,
      };
      nodes.push({
        batchId: harvestHash,
        stage: 1,
        stageName: 'Harvest',
        parents: plotHash ? [plotHash] : [],
        timestamp: harvest.intakeDate.toISOString(),
        volumeOrUnits: Number(harvest.netWeightKg),
        metrics: [
          Math.round(Number(harvest.brixDegrees) * 100),
          Math.round(Number(harvest.initialPh) * 100),
          Math.round(Number(harvest.initialAcidityGl) * 100),
        ],
        metadataHash: this.computeMetadataHash(harvestDetails),
        isCertified: harvest.phytosanitaryStatus === 'APPROVED',
        operator: {
          name: 'Jefe de Báscula',
          role: 'Weigher',
          wineryName,
        },
        details: harvestDetails,
      });
    }

    // 2. Nodo Vinificación (Stage::Vinification = 2)
    if (tank) {
      vinificationHash = this.computeHash(`TANK-${tank.id}`);
      const tankDetails = {
        tankCode: tank.tankCode,
        material: tank.material,
        volumeFilledLiters: Number(tank.volumeFilledLiters ?? 0),
        destinationType: tank.destinationType,
      };
      nodes.push({
        batchId: vinificationHash,
        stage: 2,
        stageName: 'Vinification',
        parents: harvestHash ? [harvestHash] : [],
        timestamp: tank.startDate.toISOString(),
        volumeOrUnits: Number(tank.volumeFilledLiters ?? 0),
        metrics: [1280, 28], // Estimado vino base estándar (12.80% ABV, 0.28 g/L acidez)
        metadataHash: this.computeMetadataHash(tankDetails),
        isCertified: true,
        operator: {
          name: 'Enólogo de Planta',
          role: 'Oenologist',
          wineryName,
        },
        details: tankDetails,
      });
    }

    // 3 o 4. Nodo Crianza (Stage::Aging = 3) o Destilación (Stage::Distillation = 4)
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
        timestamp: aging.createdAt.toISOString(),
        volumeOrUnits: Number(aging.volumeLiters ?? 0),
        metrics: [aging.plannedMonths * 100],
        metadataHash: this.computeMetadataHash(agingDetails),
        isCertified: true,
        operator: {
          name: 'Maestro de Cava',
          role: 'Oenologist',
          wineryName,
        },
        details: agingDetails,
      });
    } else if (batch.productionBatch) {
      const prod = batch.productionBatch;
      intermediateHash = this.computeHash(`DISTILLATION-${prod.id}`);
      const distDetails = {
        equipmentIdentifier: prod.equipmentIdentifier,
        inputVolumeLiters: Number(prod.inputVolumeLiters ?? 0),
        outputVolumeLiters: Number(prod.outputVolumeLiters ?? 0),
        wasteVolumeLiters: Number(prod.wasteVolumeLiters ?? 0),
        initialAlcoholPercentage: Number(prod.initialAlcoholPercentage ?? 0),
        restStatus: prod.restStatus,
      };
      nodes.push({
        batchId: intermediateHash,
        stage: 4,
        stageName: 'Distillation',
        parents: vinificationHash ? [vinificationHash] : [],
        timestamp: prod.processStartDate.toISOString(),
        volumeOrUnits: Number(prod.outputVolumeLiters ?? 0),
        metrics: [
          Math.round(Number(prod.initialAlcoholPercentage ?? 70.2) * 100),
        ],
        metadataHash: this.computeMetadataHash(distDetails),
        isCertified: prod.isDoEligible,
        operator: {
          name: 'Maestro Destilador',
          role: 'Distiller',
          wineryName,
        },
        details: distDetails,
      });
    }

    // 5. Nodo Embotellado (Stage::Bottling = 5)
    bottlingHash = this.computeHash(`BOTTLING-${batch.id}`);
    const bottlingDetails = {
      internationalLotCode: batch.internationalLotCode,
      productType: batch.productType,
      finalAlcoholAbv: Number(batch.finalAlcoholAbv),
      waterDilutionLiters: Number(batch.waterDilutionLiters ?? 0),
      totalBottlesPackaged: batch.totalBottlesPackaged,
      packagingFormatCl: batch.packagingFormatCl,
      qrBatchUrl: batch.qrBatchUrl,
    };

    const isCertified = Boolean(
      batch.labAnalysis && batch.labAnalysis.conformsToSenasagStandards,
    );

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
      isCertified,
      operator: {
        name: 'Supervisor de Envasado',
        role: 'Packer',
        wineryName,
      },
      details: {
        ...bottlingDetails,
        labAnalysis: batch.labAnalysis
          ? {
              certifiedLaboratoryName:
                batch.labAnalysis.certifiedLaboratoryName,
              accreditedLabCertificationCode:
                batch.labAnalysis.accreditedLabCertificationCode,
              actualAlcoholAbv: Number(batch.labAnalysis.actualAlcoholAbv),
              methanolContentMgL: Number(
                batch.labAnalysis.methanolContentMgL ?? 0,
              ),
              conformsToSenasagStandards:
                batch.labAnalysis.conformsToSenasagStandards,
            }
          : null,
      },
    });

    this.logger.log(
      `Grafo DAG reconstruido exitosamente para el lote ${batch.internationalLotCode} (${nodes.length} nodos)`,
    );

    return {
      rootBatchId: bottlingHash,
      internationalLotCode: batch.internationalLotCode,
      productType: batch.productType,
      nodes,
    };
  }
}
