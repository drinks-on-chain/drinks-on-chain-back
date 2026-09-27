import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProductionProcessEnum, RestStatusEnum } from '@prisma/client';
import { FermentationTankResponseDto } from './fermentation-tank-response.dto';
import { BottlingBatchResponseDto } from './bottling-batch-response.dto';

export class ProductionBatchResponseDto {
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

  @ApiProperty({ example: true })
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
