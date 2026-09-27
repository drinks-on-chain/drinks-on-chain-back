import {
  Terroir,
  HarvestBatch,
  FermentationTank,
  FermentationLog,
  WineAgingBatch,
  ProductionBatch,
} from '@prisma/client';

export enum OnchainStageEnum {
  Plot = 0,
  Harvest = 1,
  Vinification = 2,
  Aging = 3,
  Distillation = 4,
  Bottling = 5,
  Export = 6,
}

export interface BatchValidationResult {
  isValid: boolean;
  errors: string[];
  warnings?: string[];
}

export interface ITraceabilityStrategy {
  readonly beverageType: string;

  /**
   * Valida la idoneidad agronómica y orográfica de la parcela y la vendimia
   */
  validatePlotAndHarvest(
    terroir: Terroir,
    harvest: HarvestBatch,
  ): BatchValidationResult;

  /**
   * Valida el proceso de fermentación y cinética térmica/densimétrica
   */
  validateFermentation(
    tank: FermentationTank,
    logs: FermentationLog[],
  ): BatchValidationResult;

  /**
   * Valida el proceso intermedio (crianza en roble o destilación en alambique)
   */
  validateAgingOrDistillation(
    processData: WineAgingBatch | ProductionBatch,
  ): BatchValidationResult;

  /**
   * Valida si el lote está formalmente habilitado para fraccionamiento y embotellado
   */
  validateBottlingEligibility(
    sourceBatch: WineAgingBatch | ProductionBatch,
  ): BatchValidationResult;

  /**
   * Calcula el vector de métricas enteras escaladas (x100) para el contrato Soroban
   */
  computeOnchainMetrics(
    stage: OnchainStageEnum,
    data: Record<string, any>,
  ): number[];
}
