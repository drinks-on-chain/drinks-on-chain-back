import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import {
  LOT_PRODUCT_TYPES,
  LOT_STAGES,
  LotLockDto,
  LotSummaryDto,
} from '@modules/lots/dto/lot.dto';

const PHYTO_STATUSES = [
  'PENDING_INSPECTION',
  'APPROVED',
  'REJECTED',
  'QUARANTINE',
] as const;
const LAB_STATUSES = [
  'NOT_RECORDED',
  'CONFORMING',
  'NON_CONFORMING',
  'INCOMPLETE',
] as const;

// ── Panel de la bodega (§11.2) ─────────────────────────────────────────────

/** `Record<LotStage, number>`: una propiedad entera por etapa. */
export class LotsByStageDto {
  @ApiProperty({ type: 'integer', minimum: 0 }) ORIGIN!: number;
  @ApiProperty({ type: 'integer', minimum: 0 }) HARVEST!: number;
  @ApiProperty({ type: 'integer', minimum: 0 }) FERMENTING!: number;
  @ApiProperty({ type: 'integer', minimum: 0 }) AGING!: number;
  @ApiProperty({ type: 'integer', minimum: 0 }) DISTILLING!: number;
  @ApiProperty({ type: 'integer', minimum: 0 }) RESTING!: number;
  @ApiProperty({ type: 'integer', minimum: 0 }) BOTTLED!: number;
  @ApiProperty({ type: 'integer', minimum: 0 }) CERTIFIED!: number;
  @ApiProperty({ type: 'integer', minimum: 0 }) ANCHORED!: number;
  @ApiProperty({ type: 'integer', minimum: 0 }) REJECTED!: number;
  @ApiProperty({ type: 'integer', minimum: 0 }) DISCARDED!: number;
}

export class LockDueSoonDto {
  @ApiProperty({ format: 'uuid' })
  lotId!: string;

  @ApiProperty({ example: 'CVJ-L2026-004' })
  reference!: string;

  @ApiProperty({ example: 'Singani Gran Reserva 2026' })
  name!: string;

  @ApiProperty({ type: () => LotLockDto })
  lock!: LotLockDto;
}

export class FermentationAlertDto {
  @ApiProperty({ format: 'uuid' })
  tankId!: string;

  @ApiProperty({ example: 'T-04' })
  tankCode!: string;

  @ApiProperty({ format: 'uuid' })
  lotId!: string;

  @ApiProperty({
    enum: ['HIGH_TEMPERATURE', 'NO_READING'],
    description:
      '`HIGH_TEMPERATURE`: última lectura > 32 °C; `NO_READING`: 48 h sin lecturas en `FERMENTING` (S-18)',
  })
  kind!: 'HIGH_TEMPERATURE' | 'NO_READING';

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 33.5,
    description: 'Temperatura de la última lectura (°C)',
  })
  value!: number | null;

  @ApiProperty({ type: String, nullable: true })
  lastReadingAt!: string | null;
}

export class PendingPhytoDto {
  @ApiProperty({ format: 'uuid' })
  harvestBatchId!: string;

  @ApiProperty({ example: 'HARV-2026-CINTI02-001' })
  harvestBatchCode!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  lotId!: string | null;

  @ApiProperty({ example: '2026-03-12' })
  intakeDate!: string;

  @ApiProperty({ enum: PHYTO_STATUSES })
  status!: (typeof PHYTO_STATUSES)[number];
}

export class TraceDashboardTokenizationDto {
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description:
      'Solicitudes abiertas (enviadas, en revisión o con cambios pedidos)',
  })
  openRequests!: number;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: 'Solicitudes que esperan cambios de la bodega',
  })
  changesRequested!: number;

  @ApiProperty({ type: 'integer', minimum: 0 })
  collectionsPublished!: number;
}

export class TraceDashboardDto {
  @ApiProperty({ type: () => LotsByStageDto })
  lotsByStage!: LotsByStageDto;

  @ApiProperty({
    type: () => LockDueSoonDto,
    isArray: true,
    description: 'Desbloqueo en ≤ 14 días',
  })
  locksDueSoon!: LockDueSoonDto[];

  @ApiProperty({ type: () => FermentationAlertDto, isArray: true })
  fermentationAlerts!: FermentationAlertDto[];

  @ApiProperty({ type: () => PendingPhytoDto, isArray: true })
  pendingPhyto!: PendingPhytoDto[];

  @ApiProperty({ type: () => LotSummaryDto, isArray: true })
  bottledWithoutLab!: LotSummaryDto[];

  @ApiProperty({ type: () => LotSummaryDto, isArray: true })
  readyToClose!: LotSummaryDto[];

  @ApiProperty({ type: 'integer', minimum: 0 })
  complianceIssuesOpen!: number;

  @ApiProperty({ type: 'integer', minimum: 0 })
  unassignedHarvestBatches!: number;

  @ApiProperty({
    type: () => TraceDashboardTokenizationDto,
    description: 'Tokenización de la bodega (contrato O3 §11)',
  })
  tokenization!: TraceDashboardTokenizationDto;
}

// ── Reporte de producción (§11.4) ──────────────────────────────────────────

export class ProductionReportQueryDto {
  @ApiPropertyOptional({
    example: '2026-01-01',
    description:
      'Desde (YYYY-MM-DD, America/La_Paz, inclusive), sobre la fecha de creación del lote',
  })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({
    example: '2026-12-31',
    description: 'Hasta (YYYY-MM-DD, America/La_Paz, inclusive)',
  })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ enum: LOT_PRODUCT_TYPES })
  @IsOptional()
  @IsIn(LOT_PRODUCT_TYPES)
  productType?: (typeof LOT_PRODUCT_TYPES)[number];

  @ApiPropertyOptional({
    description: `Una o varias etapas separadas por coma (${LOT_STAGES.join(', ')})`,
    example: 'BOTTLED,CERTIFIED',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  stage?: string;

  @ApiPropertyOptional({
    enum: ['json', 'csv'],
    default: 'json',
    description:
      '`csv`: `text/csv; charset=utf-8` con las mismas columnas (máx. 10 000 filas)',
  })
  @IsOptional()
  @IsIn(['json', 'csv'])
  format?: 'json' | 'csv';

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Solo personal de plataforma: bodega sobre la que se consulta',
  })
  @IsOptional()
  @IsUUID('all', { message: 'wineryId debe ser un UUID' })
  wineryId?: string;
}

export class LossPercentByStageDto {
  @ApiProperty({ type: Number, nullable: true, example: 0 })
  fermentation!: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 0 })
  transfer!: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 0 })
  distillation!: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 1.67 })
  bottling!: number | null;
}

export class ProductionReportRowDto {
  @ApiProperty({ format: 'uuid' })
  lotId!: string;

  @ApiProperty({ example: 'CVJ-L2026-004' })
  reference!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'CVJ-2026-SINGANI-004',
  })
  lotCode!: string | null;

  @ApiProperty({ example: 'Singani Gran Reserva 2026' })
  name!: string;

  @ApiProperty({ enum: LOT_PRODUCT_TYPES, nullable: true })
  productType!: 'WINE' | 'SINGANI' | null;

  @ApiProperty({ type: 'integer', example: 2026 })
  harvestYear!: number;

  @ApiProperty({ enum: LOT_STAGES })
  stage!: string;

  @ApiProperty({ example: 18400, description: 'Kilos netos de uva' })
  netKg!: number;

  @ApiProperty({ type: Number, nullable: true, example: 12100 })
  mustLiters!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 12100,
    description: 'Vino base (final de la fermentación)',
  })
  baseWineLiters!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 1500,
    description: 'Solo singani',
  })
  heartLiters!: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 2212.5 })
  bottledLiters!: number | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 2950 })
  bottles!: number | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 75 })
  formatCl!: number | null;

  @ApiProperty({ type: () => LossPercentByStageDto })
  lossPercentByStage!: LossPercentByStageDto;

  @ApiProperty({ type: Number, nullable: true, example: 0.658 })
  litersPerKg!: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 160.33 })
  bottlesPerTonne!: number | null;

  @ApiProperty({ type: String, nullable: true, example: '2026-10-01' })
  bottlingDate!: string | null;

  @ApiProperty({ enum: LAB_STATUSES })
  labStatus!: (typeof LAB_STATUSES)[number];
}

/** Totales de un tipo de producto: sumas de las filas y ratios agregados. */
export class ProductionReportTotalsDto {
  @ApiProperty({ type: 'integer', minimum: 0, description: 'Lotes sumados' })
  lots!: number;

  @ApiProperty({ example: 18400 })
  netKg!: number;

  @ApiProperty({ example: 12100 })
  mustLiters!: number;

  @ApiProperty({ example: 12100 })
  baseWineLiters!: number;

  @ApiProperty({ example: 1500, description: '0 en vino' })
  heartLiters!: number;

  @ApiProperty({ example: 2212.5 })
  bottledLiters!: number;

  @ApiProperty({ type: 'integer', minimum: 0, example: 2950 })
  bottles!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Σ mosto ÷ Σ kilos (`null` sin kilos)',
  })
  litersPerKg!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Σ botellas ÷ (Σ kilos ÷ 1000) (`null` sin kilos)',
  })
  bottlesPerTonne!: number | null;
}

/**
 * Totales por tipo de producto. `UNDECIDED` agrupa los lotes aún sin tipo
 * (antes de la bifurcación); con `?productType=` solo trae datos esa clave y
 * las demás llegan en cero.
 */
export class ProductionReportTotalsByTypeDto {
  @ApiProperty({ type: () => ProductionReportTotalsDto })
  WINE!: ProductionReportTotalsDto;

  @ApiProperty({ type: () => ProductionReportTotalsDto })
  SINGANI!: ProductionReportTotalsDto;

  @ApiProperty({
    type: () => ProductionReportTotalsDto,
    description: 'Lotes sin tipo de producto decidido',
  })
  UNDECIDED!: ProductionReportTotalsDto;
}

export class ProductionReportDto {
  @ApiProperty({ type: () => ProductionReportRowDto, isArray: true })
  rows!: ProductionReportRowDto[];

  @ApiProperty({ type: () => ProductionReportTotalsByTypeDto })
  totals!: ProductionReportTotalsByTypeDto;
}
