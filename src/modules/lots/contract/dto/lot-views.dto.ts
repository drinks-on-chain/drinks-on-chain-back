import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  LOT_PRODUCT_TYPES,
  LOT_STAGES,
  LotLockDto,
  TraceActorDto,
} from '@modules/lots/dto/lot.dto';
import { BottlingBalanceDto } from './lot-bottling.dto';

/** Tipos de evento de la línea de tiempo del lote (contrato O2 §11.1). */
export const LOT_EVENT_TYPES = [
  'LOT_CREATED',
  'ESTIMATE_CHANGED',
  'HARVEST_WEIGHED',
  'MATURITY_ANALYZED',
  'PHYTO_DECIDED',
  'TANK_FILLED',
  'FERMENTATION_STARTED',
  'FERMENTATION_READINGS',
  'TREATMENT_APPLIED',
  'FERMENTATION_COMPLETED',
  'PRODUCT_DECIDED',
  'AGING_STARTED',
  'DISTILLATION_STARTED',
  'DISTILLATION_CLOSED',
  'LOCK_RELEASED',
  'BOTTLED',
  'BOTTLE_CODES_GENERATED',
  'BOTTLE_CODE_VOIDED',
  'LAB_REGISTERED',
  'CORRECTION',
  'FILE_ATTACHED',
  'DOSSIER_CLOSED',
  'LOT_REJECTED',
  'LOT_DISCARDED',
  // Ola 3 (contrato O3 §11): tokenización y anclaje
  'TOKENIZATION_AUTHORIZED',
  'NFT_MINTED',
  'COLLECTION_PUBLISHED',
  'DOSSIER_ANCHORED',
  'TOKENS_REDEEMABLE',
  'SHORTFALL_DETECTED',
] as const;
export type LotEventType = (typeof LOT_EVENT_TYPES)[number];

// ── Línea de tiempo (§11.1) ────────────────────────────────────────────────

export class LotEventResourceDto {
  @ApiProperty({ example: 'harvest_batch', description: 'Tipo del registro' })
  type!: string;

  @ApiProperty({ format: 'uuid' })
  id!: string;
}

export class LotEventDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ type: 'integer', minimum: 1, example: 3 })
  seq!: number;

  @ApiProperty({ enum: LOT_EVENT_TYPES })
  type!: LotEventType;

  @ApiProperty({
    example: '2026-03-12T14:00:00.000Z',
    description: 'Fecha del hecho (declarada)',
  })
  occurredAt!: string;

  @ApiProperty({ example: '2026-03-12T14:05:00.000Z' })
  recordedAt!: string;

  @ApiProperty({
    description: 'Registrado más de 7 días después del hecho (S-9)',
  })
  lateEntry!: boolean;

  @ApiProperty({
    enum: LOT_STAGES,
    description: 'Etapa del lote tras el evento',
  })
  stage!: string;

  @ApiProperty({
    type: () => TraceActorDto,
    nullable: true,
    description: '`null` = sistema (tarea diaria)',
  })
  actor!: TraceActorDto | null;

  @ApiProperty({ example: 'Pesaje de 18.400 kg desde Parcela Cinti 02' })
  summary!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'Cifras del evento con su unidad',
    example: { netKg: 18400, unit: 'kg' },
  })
  data!: Record<string, unknown>;

  @ApiProperty({ type: () => LotEventResourceDto })
  resource!: LotEventResourceDto;

  @ApiProperty({
    enum: ['PUBLIC', 'INTERNAL'],
    description: '`PUBLIC` es lo que muestra el pasaporte (§12)',
  })
  visibility!: 'PUBLIC' | 'INTERNAL';

  @ApiProperty()
  corrected!: boolean;
}

export class LotTimelineDto {
  @ApiProperty({ type: () => LotEventDto, isArray: true })
  events!: LotEventDto[];

  @ApiProperty({ type: () => LotLockDto, isArray: true })
  locks!: LotLockDto[];

  @ApiProperty({ type: String, nullable: true, example: '2026-10-13' })
  estimatedReadyDate!: string | null;

  @ApiProperty({
    enum: ['LOCK', 'DECLARED'],
    nullable: true,
    description: '`LOCK` = candado calculado; `DECLARED` = `targetReadyDate`',
  })
  estimatedReadyBasis!: 'LOCK' | 'DECLARED' | null;
}

// ── Grafo (§11.3) ──────────────────────────────────────────────────────────

export class LotGraphNodeQuantityDto {
  @ApiProperty({ example: 18400 })
  value!: number;

  @ApiProperty({ enum: ['kg', 'L', 'bottles'] })
  unit!: 'kg' | 'L' | 'bottles';
}

export class LotGraphEdgeQuantityDto {
  @ApiProperty({ example: 12100 })
  value!: number;

  @ApiProperty({ enum: ['kg', 'L'] })
  unit!: 'kg' | 'L';
}

export class LotGraphMetricDto {
  @ApiProperty({ example: 'brixDegrees' })
  key!: string;

  @ApiProperty({ example: 'Grados Brix' })
  label!: string;

  @ApiProperty({
    nullable: true,
    oneOf: [{ type: 'number' }, { type: 'string' }],
    description: '`null` = no registrado',
    example: 23.4,
  })
  value!: number | string | null;

  @ApiProperty({ type: String, nullable: true, example: '°Bx' })
  unit!: string | null;
}

export class LotGraphNodeDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    enum: [
      'TERROIR',
      'HARVEST_BATCH',
      'TANK',
      'WINE_AGING',
      'DISTILLATION',
      'BOTTLING',
      'LAB_ANALYSIS',
    ],
  })
  type!: string;

  @ApiProperty({ example: 'HARV-2026-CINTI02-001' })
  label!: string;

  @ApiProperty({ example: '2026-03-12T14:00:00.000Z' })
  occurredAt!: string;

  @ApiProperty({ example: '2026-03-12T14:05:00.000Z' })
  recordedAt!: string;

  @ApiProperty({ type: () => LotGraphNodeQuantityDto, nullable: true })
  quantity!: LotGraphNodeQuantityDto | null;

  @ApiProperty({ type: () => LotGraphMetricDto, isArray: true })
  metrics!: LotGraphMetricDto[];

  @ApiProperty({ type: () => TraceActorDto, nullable: true })
  actor!: TraceActorDto | null;

  @ApiProperty({ example: 'APPROVED', description: 'Estado del registro' })
  status!: string;

  @ApiProperty()
  corrected!: boolean;
}

export class LotGraphEdgeDto {
  @ApiProperty({ format: 'uuid', description: 'Id del nodo de origen' })
  from!: string;

  @ApiProperty({ format: 'uuid', description: 'Id del nodo de destino' })
  to!: string;

  @ApiProperty({ type: () => LotGraphEdgeQuantityDto, nullable: true })
  quantity!: LotGraphEdgeQuantityDto | null;
}

export class LotGraphDto {
  @ApiProperty({ format: 'uuid' })
  lotId!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'CVJ-2026-SINGANI-004',
  })
  lotCode!: string | null;

  @ApiProperty({ enum: LOT_PRODUCT_TYPES, nullable: true })
  productType!: 'WINE' | 'SINGANI' | null;

  @ApiProperty({ type: () => LotGraphNodeDto, isArray: true })
  nodes!: LotGraphNodeDto[];

  @ApiProperty({ type: () => LotGraphEdgeDto, isArray: true })
  edges!: LotGraphEdgeDto[];
}

// ── Balance kilos → litros → botellas (§11.3) ──────────────────────────────

export class LotBalanceHarvestDto {
  @ApiProperty({ example: 18400 })
  netKg!: number;

  @ApiProperty({ example: 18400 })
  approvedKg!: number;

  @ApiProperty({ example: 0 })
  rejectedKg!: number;

  @ApiProperty({ example: 0 })
  pendingKg!: number;
}

export class LotBalanceMustDto {
  @ApiProperty({ example: 12100 })
  filledLiters!: number;

  @ApiProperty({ type: Number, nullable: true, example: 0.658 })
  litersPerKg!: number | null;
}

export class LotBalanceFermentationDto {
  @ApiProperty({ type: Number, nullable: true, example: 12100 })
  finalLiters!: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 0 })
  lossLiters!: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 0 })
  lossPercent!: number | null;
}

export class LotBalanceAgingDto {
  @ApiProperty({ example: 2200 })
  liters!: number;

  @ApiProperty({ example: 25 })
  lossLiters!: number;
}

export class LotBalanceDistillationDto {
  @ApiProperty({ example: 12100 })
  inputLiters!: number;

  @ApiProperty({ example: 120 })
  headsLiters!: number;

  @ApiProperty({ example: 1500 })
  heartLiters!: number;

  @ApiProperty({ example: 210 })
  tailsLiters!: number;

  @ApiProperty({ type: Number, nullable: true, example: 60 })
  heartAbvPercent!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 900,
    description: 'Corazón × grado',
  })
  pureAlcoholLiters!: number | null;
}

export class LotBalanceProjectionDto {
  @ApiProperty({ type: 'integer', nullable: true, example: 2950 })
  bottles!: number | null;

  @ApiProperty({
    enum: ['DECLARED', 'MUST', 'BASE_WINE', 'DISTILLATE', 'BOTTLED'],
    description: 'Etapa de la que sale la proyección (S-19)',
  })
  basis!: 'DECLARED' | 'MUST' | 'BASE_WINE' | 'DISTILLATE' | 'BOTTLED';
}

export class LotBalanceDto {
  @ApiProperty({ type: () => LotBalanceHarvestDto })
  harvest!: LotBalanceHarvestDto;

  @ApiProperty({ type: () => LotBalanceMustDto })
  must!: LotBalanceMustDto;

  @ApiProperty({ type: () => LotBalanceFermentationDto })
  fermentation!: LotBalanceFermentationDto;

  @ApiPropertyOptional({
    type: () => LotBalanceAgingDto,
    description: 'Solo vino',
  })
  aging?: LotBalanceAgingDto;

  @ApiPropertyOptional({
    type: () => LotBalanceDistillationDto,
    description: 'Solo singani',
  })
  distillation?: LotBalanceDistillationDto;

  @ApiProperty({ type: () => BottlingBalanceDto, nullable: true })
  bottling!: BottlingBalanceDto | null;

  @ApiProperty({ type: () => LotBalanceProjectionDto })
  projection!: LotBalanceProjectionDto;
}
