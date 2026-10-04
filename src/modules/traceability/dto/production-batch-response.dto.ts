import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CorrectableResponseDto } from '@modules/lots/dto/correction-marks.dto';
import { LotLockDto } from '@modules/lots/dto/lot.dto';
import { ProductionProcessEnum, RestStatusEnum } from '@prisma/client';
import { FermentationTankResponseDto } from './fermentation-tank-response.dto';
import { BottlingBatchResponseDto } from './bottling-batch-response.dto';

export class ProductionBatchResponseDto extends CorrectableResponseDto {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' })
  id!: string;

  @ApiProperty({ example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' })
  wineryId!: string;

  @ApiProperty({ example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' })
  fermentationTankId!: string;

  @ApiProperty({
    enum: ProductionProcessEnum,
    example: ProductionProcessEnum.SINGANI_DISTILLATION,
  })
  processType!: ProductionProcessEnum;

  @ApiProperty({ example: 'Alambique de Cobre Charentais AL-01' })
  equipmentIdentifier!: string;

  @ApiProperty({ example: '2026-04-01' })
  processStartDate!: Date;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    example: '2026-04-03',
  })
  processEndDate?: Date | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 10000.0 })
  inputVolumeLiters?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 1750.0 })
  outputVolumeLiters?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 570.0 })
  wasteVolumeLiters?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 70.2 })
  initialAlcoholPercentage?: number | null;

  @ApiProperty({
    example: true,
    description:
      'D.O. del lote calculada en el servidor (EA-03); en la entrada se ignora',
  })
  isDoEligible!: boolean;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    example: '2026-09-30',
  })
  mandatoryRestUntil?: Date | null;

  @ApiProperty({ enum: RestStatusEnum, example: RestStatusEnum.RESTING })
  restStatus!: RestStatusEnum;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    nullable: true,
  })
  additionalParams?: Record<string, unknown> | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Destilación simple discontinua',
  })
  notes?: string | null;

  @ApiProperty({ example: '2026-04-01T10:00:00.000Z' })
  createdAt!: Date;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Lote (Ola 2)',
  })
  lotId!: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 120,
    description: 'Cabezas (L)',
  })
  headsLiters!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 1500,
    description: 'Corazón (L)',
  })
  heartLiters!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 210,
    description: 'Colas (L)',
  })
  tailsLiters!: number | null;

  @ApiProperty({ type: Number, nullable: true, description: 'Vinaza (L)' })
  vinasseLiters!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 60,
    description: 'Grado del corazón (% v/v)',
  })
  heartAbvPercent!: number | null;

  @ApiPropertyOptional({
    type: () => LotLockDto,
    nullable: true,
    description:
      'Candado de reposo con la instantánea del lote (rutas de destilación)',
  })
  lock?: LotLockDto | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description:
      'Alcohol puro del corazón: litros × grado (rutas de destilación)',
  })
  pureAlcoholLiters?: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description: 'Corazón aún sin embotellar (rutas de destilación)',
  })
  availableLiters?: number | null;

  @ApiPropertyOptional({
    type: () => FermentationTankResponseDto,
    description: 'En la lista y el detalle',
  })
  fermentationTank?: FermentationTankResponseDto;

  @ApiPropertyOptional({
    type: () => BottlingBatchResponseDto,
    isArray: true,
    description: 'Solo en el detalle',
  })
  bottlingBatches?: BottlingBatchResponseDto[];
}

/** Estado del reposo inerte obligatorio (D.O. Singani, 180 días). */
export class RestStatusResponseDto {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' })
  id!: string;

  @ApiProperty({ enum: RestStatusEnum, example: RestStatusEnum.RESTING })
  restStatus!: RestStatusEnum;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: '2026-04-03T00:00:00.000Z',
  })
  processEndDate!: Date | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: '2026-09-30T00:00:00.000Z',
  })
  mandatoryRestUntil!: Date | null;

  @ApiProperty({ example: 42, minimum: 0 })
  daysElapsed!: number;

  @ApiProperty({ example: 138, minimum: 0 })
  daysRemaining!: number;

  @ApiProperty({ example: false })
  isRestCompleted!: boolean;
}
