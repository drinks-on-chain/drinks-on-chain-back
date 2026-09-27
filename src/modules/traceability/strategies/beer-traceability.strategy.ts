import { Injectable } from '@nestjs/common';
import {
  ITraceabilityStrategy,
  BatchValidationResult,
  OnchainStageEnum,
} from './interfaces/traceability-strategy.interface';
import {
  Terroir,
  HarvestBatch,
  FermentationTank,
  FermentationLog,
  ProductionBatch,
  WineAgingBatch,
} from '@prisma/client';

@Injectable()
export class BeerTraceabilityStrategy implements ITraceabilityStrategy {
  readonly beverageType = 'BEER';

  validatePlotAndHarvest(
    terroir: Terroir,
    _harvest: HarvestBatch,
  ): BatchValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (
      !terroir.rawMaterialType.toLowerCase().includes('cebada') &&
      !terroir.rawMaterialType.toLowerCase().includes('lupulo') &&
      !terroir.rawMaterialType.toLowerCase().includes('cereal')
    ) {
      warnings.push(
        `Materia prima inusual para cerveza: ${terroir.rawMaterialType}`,
      );
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  validateFermentation(
    tank: FermentationTank,
    logs: FermentationLog[],
  ): BatchValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (logs.length === 0) {
      warnings.push('Sin registros térmicos de fermentación primaria.');
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  validateAgingOrDistillation(
    processData: WineAgingBatch | ProductionBatch,
  ): BatchValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    const prod = processData as ProductionBatch;
    if (prod.processType !== 'BEER_MATURATION') {
      errors.push(`Proceso inválido para cerveza: ${prod.processType}`);
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  validateBottlingEligibility(
    _sourceBatch: WineAgingBatch | ProductionBatch,
  ): BatchValidationResult {
    return {
      isValid: true,
      errors: [],
    };
  }

  computeOnchainMetrics(
    stage: OnchainStageEnum,
    data: Record<string, unknown>,
  ): number[] {
    switch (stage) {
      case OnchainStageEnum.Plot:
        return [Math.round(Number(data.altitudeMasl ?? 0) * 100)];
      case OnchainStageEnum.Harvest:
        return [Math.round(Number(data.grossWeightKg ?? 0) * 100)];
      case OnchainStageEnum.Vinification:
        return [Math.round(Number(data.alcoholAbv ?? 5.5) * 100)];
      case OnchainStageEnum.Bottling:
        return [
          Math.round(Number(data.finalAlcoholAbv ?? 5.5) * 100),
          Math.round(Number(data.packagingFormatCl ?? 33) * 10),
        ];
      default:
        return [];
    }
  }
}
