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
export class WineTraceabilityStrategy implements ITraceabilityStrategy {
  readonly beverageType = 'WINE';

  validatePlotAndHarvest(
    terroir: Terroir,
    harvest: HarvestBatch,
  ): BatchValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    const brix = Number(harvest.brixDegrees);
    if (brix < 18.0) {
      warnings.push(
        `Grados Brix bajos para vinificación (${brix} °Bx), grado potencial inferior a 11% ABV.`,
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
      warnings.push(
        'Sin registros diarios de control de densidad y temperatura.',
      );
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

    const aging = processData as WineAgingBatch;
    if (aging.plannedMonths <= 0) {
      errors.push('Los meses planificados de crianza deben ser mayores a 0.');
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  validateBottlingEligibility(
    sourceBatch: WineAgingBatch | ProductionBatch,
  ): BatchValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    const aging = sourceBatch as WineAgingBatch;
    if (aging.lockUntilDate) {
      const lockDate = new Date(aging.lockUntilDate);
      const now = new Date();
      if (now < lockDate) {
        errors.push(
          `El vino se encuentra bloqueado por período de crianza hasta el ${lockDate.toISOString().split('T')[0]}.`,
        );
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
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
        return [
          Math.round(Number(data.brixDegrees ?? 0) * 100),
          Math.round(Number(data.initialPh ?? 0) * 100),
          Math.round(Number(data.initialAcidityGl ?? 0) * 100),
        ];
      case OnchainStageEnum.Vinification:
        return [
          Math.round(Number(data.alcoholAbv ?? 13.5) * 100),
          Math.round(Number(data.volatileAcidity ?? 0.35) * 100),
        ];
      case OnchainStageEnum.Aging:
        return [Math.round(Number(data.plannedMonths ?? 12) * 100)];
      case OnchainStageEnum.Bottling:
        return [
          Math.round(Number(data.finalAlcoholAbv ?? 13.5) * 100),
          Math.round(Number(data.packagingFormatCl ?? 75) * 10),
        ];
      default:
        return [];
    }
  }
}
