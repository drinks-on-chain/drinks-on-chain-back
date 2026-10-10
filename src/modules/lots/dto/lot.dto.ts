import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ErrorDetailDto } from '@shared/dto/api-error-response.dto';
import { JSON_VALUE_NOT_NULL_SCHEMA } from '@shared/dto/json-value.schema';
import { WineryScopedPaginationQueryDto } from '@shared/dto/pagination-query.dto';
import {
  LOT_TOKENIZATION_STATES,
  type LotTokenizationState,
} from '@modules/tokenization/tokenization.constants';

export const LOT_STAGES = [
  'ORIGIN',
  'HARVEST',
  'FERMENTING',
  'AGING',
  'DISTILLING',
  'RESTING',
  'BOTTLED',
  'CERTIFIED',
  'ANCHORED',
  'REJECTED',
  'DISCARDED',
] as const;
export const LOT_PRODUCT_TYPES = ['WINE', 'SINGANI'] as const;
export const WINERY_ROLES = [
  'OWNER',
  'ENOLOGIST',
  'AGRONOMIST',
  'OPERATOR',
  'ACCOUNTANT',
] as const;

// ── Tipos comunes ──────────────────────────────────────────────────────────

export class TraceActorDto {
  @ApiProperty({ format: 'uuid' })
  membershipId!: string;

  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty({ example: 'Lic. Valeria Soliz' })
  fullName!: string;

  @ApiProperty({ example: 'ENOLOGIST', description: 'Rol en la bodega' })
  role!: string;
}

export class LotLockRuleDto {
  @ApiProperty({ example: 'trazabilidad.singani.reposoMinimoDias' })
  settingKey!: string;

  @ApiProperty({ example: 180, description: 'Mínimo de la instantánea' })
  minimum!: number;

  @ApiProperty({ example: 180, description: 'Valor aplicado (≥ mínimo)' })
  applied!: number;

  @ApiProperty({ enum: ['meses', 'días'] })
  unit!: 'meses' | 'días';

  @ApiProperty({
    description:
      'El mínimo aplicado está bajo el mínimo legal por excepción (A-31)',
  })
  legalException!: boolean;
}

export class LotLockDto {
  @ApiProperty({ enum: ['AGING', 'REST'] })
  kind!: 'AGING' | 'REST';

  @ApiProperty({
    format: 'uuid',
    description: 'wineAgingBatchId | productionBatchId',
  })
  sourceId!: string;

  @ApiProperty({
    example: '2026-10-13',
    description: 'YYYY-MM-DD en America/La_Paz',
  })
  unlockDate!: string;

  @ApiProperty({ description: 'Liberado según el reloj de la base' })
  released!: boolean;

  @ApiProperty({ example: 15, minimum: 0 })
  daysRemaining!: number;

  @ApiProperty({ type: () => LotLockRuleDto })
  rule!: LotLockRuleDto;
}

export class DoCheckDto {
  @ApiProperty({ enum: ['ALTITUDE', 'VARIETY'] })
  rule!: 'ALTITUDE' | 'VARIETY';

  @ApiProperty({ example: 'trazabilidad.singani.altitudMinimaMsnm' })
  settingKey!: string;

  @ApiProperty({ ...JSON_VALUE_NOT_NULL_SCHEMA, example: 1600 })
  required!: number | string[];

  @ApiProperty({ ...JSON_VALUE_NOT_NULL_SCHEMA, example: 1600 })
  legalMinimum!: number | string[];

  @ApiProperty({ ...JSON_VALUE_NOT_NULL_SCHEMA, example: 2350 })
  actual!: number | string;

  @ApiProperty()
  pass!: boolean;

  @ApiProperty({ format: 'uuid' })
  terroirId!: string;
}

export class DoEvaluationDto {
  @ApiProperty({
    enum: [
      'ELIGIBLE',
      'ELIGIBLE_BY_EXCEPTION',
      'NOT_ELIGIBLE',
      'NOT_APPLICABLE',
    ],
    description:
      '`NOT_APPLICABLE` en vino o sin parcelas que evaluar; `ELIGIBLE_BY_EXCEPTION` = cumple por un valor bajo el mínimo legal autorizado (A-31)',
  })
  status!: string;

  @ApiProperty({ type: () => DoCheckDto, isArray: true })
  checks!: DoCheckDto[];

  @ApiProperty({ enum: ['LOT_SNAPSHOT', 'EFFECTIVE_SETTINGS'] })
  rulesSource!: string;

  @ApiProperty({ example: '2026-09-27T12:00:00.000Z' })
  evaluatedAt!: string;
}

export class ComplianceIssueDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'TRC_BOTTLING_EXCEEDS_VOLUME' })
  code!: string;

  @ApiProperty()
  message!: string;

  @ApiProperty({ enum: ['MIGRATION', 'CORRECTION', 'RULES_REEVALUATION'] })
  source!: string;

  @ApiProperty({ type: () => ErrorDetailDto, isArray: true })
  details!: ErrorDetailDto[];

  @ApiProperty({ example: '2026-09-27T12:00:00.000Z' })
  detectedAt!: string;

  @ApiProperty({ type: String, nullable: true })
  resolvedAt!: string | null;
}

export class LabLimitDto {
  @ApiPropertyOptional({ example: 200 })
  max?: number;

  @ApiPropertyOptional()
  min?: number;

  @ApiProperty({ example: 'mg/100 ml a.a.' })
  unidad!: string;
}

class LotRulesSinganiDto {
  @ApiProperty({ example: 1600 })
  minAltitudeMasl!: number;

  @ApiProperty({
    type: String,
    isArray: true,
    example: ['Moscatel de Alejandría'],
  })
  requiredVarieties!: string[];

  @ApiProperty({ example: 180 })
  minRestDays!: number;
}

class LotRulesWineDto {
  @ApiProperty({ example: 0 })
  minAgingMonths!: number;
}

class LotRulesPhytoDto {
  @ApiProperty({ example: true })
  requireApproved!: boolean;
}

class LotRulesBottlingDto {
  @ApiProperty({ example: 5 })
  maxLossPercent!: number;
}

class LotRulesLabDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: { $ref: '#/components/schemas/LabLimitDto' },
    example: { metanol: { max: 200, unidad: 'mg/100 ml a.a.' } },
  })
  limits!: Record<string, LabLimitDto>;
}

export class LotRulesDto {
  @ApiProperty({ example: '2026-09-27T12:00:00.000Z' })
  takenAt!: string;

  @ApiProperty({
    enum: ['LOT_CREATION', 'MIGRATION'],
    description:
      '`MIGRATION`: lote anterior a la Ola 2 (reglas fijadas al migrar)',
  })
  origin!: string;

  @ApiProperty({ type: () => LotRulesSinganiDto })
  singani!: LotRulesSinganiDto;

  @ApiProperty({ type: () => LotRulesWineDto })
  wine!: LotRulesWineDto;

  @ApiProperty({ type: () => LotRulesPhytoDto })
  phytosanitary!: LotRulesPhytoDto;

  @ApiProperty({ type: () => LotRulesBottlingDto })
  bottling!: LotRulesBottlingDto;

  @ApiProperty({ type: () => LotRulesLabDto })
  lab!: LotRulesLabDto;

  @ApiProperty({ type: String, isArray: true })
  legalExceptions!: string[];

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string', enum: ['GLOBAL', 'WINERY'] },
  })
  sources!: Record<string, 'GLOBAL' | 'WINERY'>;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'Copia literal de la instantánea',
  })
  values!: Record<string, unknown>;
}

class LotPhytoCountsDto {
  @ApiProperty({ minimum: 0 }) pending!: number;
  @ApiProperty({ minimum: 0 }) quarantine!: number;
  @ApiProperty({ minimum: 0 }) approved!: number;
  @ApiProperty({ minimum: 0 }) rejected!: number;
}

export class LotTokenizationMarkDto {
  @ApiProperty({
    enum: LOT_TOKENIZATION_STATES,
    enumName: 'LotTokenizationState',
    example: 'NONE',
  })
  state!: LotTokenizationState;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: 'Cuota autorizada vigente (0 sin colección)',
  })
  quota!: number;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: 'NFT emitidos confirmados',
  })
  minted!: number;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  collectionId!: string | null;
}

export class LotSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  wineryId!: string;

  @ApiProperty({
    example: 'CVJ-L2026-004',
    description: 'Referencia interna desde la creación',
  })
  reference!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'CVJ-2026-SINGANI-004',
    description: 'Código de lote de la etiqueta (al embotellar)',
  })
  lotCode!: string | null;

  @ApiProperty({ example: 'Singani Gran Reserva 2026' })
  name!: string;

  @ApiProperty({ enum: LOT_PRODUCT_TYPES, nullable: true })
  productType!: 'WINE' | 'SINGANI' | null;

  @ApiProperty({ enum: LOT_STAGES })
  stage!: string;

  @ApiProperty({ example: '2026-09-27T12:00:00.000Z' })
  stageChangedAt!: string;

  @ApiProperty({
    description: 'FERMENTING con tanques completados sin destino decidido',
  })
  awaitingBifurcation!: boolean;

  @ApiProperty({ example: 2026 })
  harvestYear!: number;

  @ApiProperty({ type: Number, nullable: true, example: 3000 })
  estimatedBottles!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Calculada por el servidor (§11.3)',
  })
  projectedBottles!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Botellas con código activo',
  })
  bottles!: number | null;

  @ApiProperty({ type: () => LotLockDto, nullable: true })
  nextLock!: LotLockDto | null;

  @ApiProperty({ type: () => LotPhytoCountsDto })
  phyto!: LotPhytoCountsDto;

  @ApiProperty({
    enum: ['NOT_RECORDED', 'CONFORMING', 'NON_CONFORMING', 'INCOMPLETE'],
  })
  labStatus!: string;

  @ApiProperty({ enum: ['OPEN', 'CLOSED'] })
  dossierStatus!: string;

  @ApiProperty({ minimum: 0 })
  complianceIssuesOpen!: number;

  @ApiProperty({
    type: () => LotTokenizationMarkDto,
    description:
      'Marca de tokenización (contrato O3 §5.3); no es una etapa. Sin solicitud ni colección: ' +
      '`{ state: NONE, quota: 0, minted: 0, collectionId: null }`',
  })
  tokenization!: LotTokenizationMarkDto;

  @ApiProperty({ example: '2026-09-27T12:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ example: '2026-09-27T12:00:00.000Z' })
  updatedAt!: string;
}

class EstimateHistoryEntryDto {
  @ApiProperty({ example: 3000 })
  value!: number;

  @ApiProperty({ example: '2026-09-27T12:00:00.000Z' })
  at!: string;

  @ApiProperty({ type: () => TraceActorDto, nullable: true })
  by!: TraceActorDto | null;

  @ApiProperty({ type: String, nullable: true })
  reason!: string | null;
}

class LotLinksDto {
  @ApiProperty({ type: String, isArray: true }) harvestBatchIds!: string[];
  @ApiProperty({ type: String, isArray: true }) tankIds!: string[];
  @ApiProperty({ type: String, isArray: true }) wineAgingBatchIds!: string[];
  @ApiProperty({ type: String, isArray: true }) productionBatchIds!: string[];
  @ApiProperty({ type: String, nullable: true }) bottlingBatchId!:
    string | null;
  @ApiProperty({ type: String, isArray: true }) labAnalysisIds!: string[];
}

class LotDiscardedDto {
  @ApiProperty() at!: string;
  @ApiProperty({ type: () => TraceActorDto, nullable: true })
  by!: TraceActorDto | null;
  @ApiProperty() reason!: string;
}

export class LotDto extends LotSummaryDto {
  @ApiProperty({
    type: String,
    isArray: true,
    description: 'Origen previsto (opcional)',
  })
  plannedTerroirIds!: string[];

  @ApiProperty({ type: Number, nullable: true, example: 75 })
  plannedFormatCl!: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 40 })
  targetAbvPercent!: number | null;

  @ApiProperty({ type: String, nullable: true, example: '2027-03-01' })
  targetReadyDate!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '2026-10-13' })
  estimatedReadyDate!: string | null;

  @ApiProperty({ enum: ['LOCK', 'DECLARED'], nullable: true })
  estimatedReadyBasis!: 'LOCK' | 'DECLARED' | null;

  @ApiProperty({ type: () => EstimateHistoryEntryDto, isArray: true })
  estimatedBottlesHistory!: EstimateHistoryEntryDto[];

  @ApiProperty({ type: () => LotLockDto, isArray: true })
  locks!: LotLockDto[];

  @ApiProperty({ type: () => LotRulesDto })
  rules!: LotRulesDto;

  @ApiProperty({ type: () => DoEvaluationDto })
  denomination!: DoEvaluationDto;

  @ApiProperty({ type: () => ComplianceIssueDto, isArray: true })
  complianceIssues!: ComplianceIssueDto[];

  @ApiProperty({ type: () => LotLinksDto })
  links!: LotLinksDto;

  @ApiProperty({ type: () => LotDiscardedDto, nullable: true })
  discarded!: LotDiscardedDto | null;

  @ApiProperty({ type: String, nullable: true })
  notes!: string | null;

  @ApiProperty({
    type: () => TraceActorDto,
    nullable: true,
    description: '`null` en los lotes creados por el sistema (migración)',
  })
  createdBy!: TraceActorDto | null;
}

// ── Entradas ───────────────────────────────────────────────────────────────

export class CreateLotDto {
  @ApiProperty({
    minLength: 3,
    maxLength: 120,
    example: 'Singani Gran Reserva 2026',
  })
  @IsString()
  @Length(3, 120)
  name!: string;

  @ApiProperty({ minimum: 2000, example: 2026, description: '2000–año actual' })
  @IsInt()
  @Min(2000)
  @Max(2100)
  harvestYear!: number;

  @ApiPropertyOptional({
    enum: LOT_PRODUCT_TYPES,
    description:
      'Declarado ya (preventa, D.O. temprana) o decidido en la bifurcación',
  })
  @IsOptional()
  @IsString()
  productType?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100000, example: 3000 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100000)
  estimatedBottles?: number;

  @ApiPropertyOptional({ minimum: 5, maximum: 300, example: 75 })
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(300)
  plannedFormatCl?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 80, example: 40 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(80)
  targetAbvPercent?: number;

  @ApiPropertyOptional({
    type: String,
    isArray: true,
    description: 'Si productType = SINGANI, se evalúa la D.O. al crear',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  plannedTerroirIds?: string[];

  @ApiPropertyOptional({
    example: '2027-03-01',
    description: 'YYYY-MM-DD, informativa',
  })
  @IsOptional()
  @IsDateString()
  targetReadyDate?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class UpdateLotDto {
  @ApiPropertyOptional({ minLength: 3, maxLength: 120 })
  @IsOptional()
  @IsString()
  @Length(3, 120)
  name?: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 100000,
    description: 'Exige `reason`',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100000)
  estimatedBottles?: number;

  @ApiPropertyOptional({ minimum: 5, maximum: 300 })
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(300)
  plannedFormatCl?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 80 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(80)
  targetAbvPercent?: number;

  @ApiPropertyOptional({ example: '2027-03-01' })
  @IsOptional()
  @IsDateString()
  targetReadyDate?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @ApiPropertyOptional({
    minLength: 3,
    maxLength: 500,
    description:
      'Obligatorio si cambia `estimatedBottles` (queda en su historial)',
  })
  @IsOptional()
  @IsString()
  @Length(3, 500)
  reason?: string;
}

export class DiscardLotDto {
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @IsString()
  @Length(3, 500)
  reason!: string;
}

export class QueryLotsDto extends WineryScopedPaginationQueryDto {
  @ApiPropertyOptional({
    description: `Una o varias etapas separadas por coma (${LOT_STAGES.join(', ')})`,
    example: 'RESTING,AGING',
  })
  @IsOptional()
  @IsString()
  stage?: string;

  @ApiPropertyOptional({ enum: LOT_PRODUCT_TYPES })
  @IsOptional()
  @IsIn(LOT_PRODUCT_TYPES as unknown as string[])
  productType?: 'WINE' | 'SINGANI';

  @ApiPropertyOptional({ example: 2026 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  harvestYear?: number;

  @ApiPropertyOptional({
    description: 'Busca en nombre, referencia y código de lote',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ enum: ['true', 'false'] })
  @IsOptional()
  @IsIn(['true', 'false'])
  hasComplianceIssues?: 'true' | 'false';

  @ApiPropertyOptional({
    description: 'Candado que se libera en ≤ N días',
    example: 14,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(3650)
  lockDueWithinDays?: number;
}
