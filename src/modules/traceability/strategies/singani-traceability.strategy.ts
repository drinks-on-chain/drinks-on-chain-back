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
export class SinganiTraceabilityStrategy implements ITraceabilityStrategy {
  readonly beverageType = 'SINGANI';

  validatePlotAndHarvest(
    terroir: Terroir,
    harvest: HarvestBatch,
  ): BatchValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    const altitude = Number(terroir.altitudeMasl);
    if (altitude < 1600) {
      errors.push(
        `D.O. Singani exige una altitud mínima de 1,600 m.s.n.m. Parcela actual: ${altitude} m.s.n.m.`,
      );
    }

    const variety = terroir.varietyName.toLowerCase();
    if (!variety.includes('moscatel') || !variety.includes('alejandr')) {
      errors.push(
        `D.O. Singani exige 100% uva Moscatel de Alejandría. Variedad registrada: "${terroir.varietyName}"`,
      );
    }

    const brix = Number(harvest.brixDegrees);
    if (brix < 19.0) {
      warnings.push(
        `Madurez de uva baja (${brix} °Bx), potencial aromático reducido.`,
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
        'No se han registrado lecturas térmicas diarias durante la vinificación.',
      );
    }

    // Singani tradicional se vinifica como vino blanco aromático en tanques neutros
    if (
      tank.material &&
      !tank.material.toUpperCase().includes('INOX') &&
      !tank.material.toUpperCase().includes('ACERO')
    ) {
      warnings.push(
        'Se recomienda fermentación en acero inoxidable para preservar terpenos florales.',
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

    const prod = processData as ProductionBatch;
    if (prod.processType !== 'SINGANI_DISTILLATION') {
      errors.push(`Tipo de proceso inválido para Singani: ${prod.processType}`);
    }

    const initialAbv = Number(prod.initialAlcoholPercentage ?? 0);
    if (initialAbv < 65.0 || initialAbv > 74.0) {
      warnings.push(
        `Graduación alcohólica del corazón de destilación fuera del rango estándar (65% - 74% ABV): ${initialAbv}% ABV`,
      );
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

    const prod = sourceBatch as ProductionBatch;
    if (!prod.processEndDate) {
      errors.push(
        'La destilación aún no ha sido marcada como concluida con fecha de fin.',
      );
      return { isValid: false, errors };
    }

    const endDate = new Date(prod.processEndDate);
    const now = new Date();
    const diffMs = now.getTime() - endDate.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays < 180) {
      errors.push(
        `D.O. Singani exige un reposo inerte obligatorio mínimo de 180 días (6 meses). Días transcurridos: ${diffDays} / 180 días.`,
      );
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }

  computeOnchainMetrics(
    stage: OnchainStageEnum,
    data: Record<string, any>,
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
          Math.round(Number(data.alcoholAbv ?? 12.8) * 100),
          Math.round(Number(data.volatileAcidity ?? 0.28) * 100),
        ];
      case OnchainStageEnum.Distillation:
        return [
          Math.round(Number(data.initialAlcoholPercentage ?? 70.2) * 100),
        ];
      case OnchainStageEnum.Bottling:
        return [
          Math.round(Number(data.finalAlcoholAbv ?? 40.0) * 100),
          Math.round(Number(data.packagingFormatCl ?? 75) * 10),
        ];
      default:
        return [];
    }
  }
}
