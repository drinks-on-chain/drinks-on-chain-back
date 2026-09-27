import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProductionProcessEnum, RestStatusEnum } from '@prisma/client';

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

  @ApiPropertyOptional({ example: '2026-04-03' })
  processEndDate?: Date | null;

  @ApiPropertyOptional({ example: 10000.0 })
  inputVolumeLiters?: number | null;

  @ApiPropertyOptional({ example: 1750.0 })
  outputVolumeLiters?: number | null;

  @ApiPropertyOptional({ example: 570.0 })
  wasteVolumeLiters?: number | null;

  @ApiPropertyOptional({ example: 70.2 })
  initialAlcoholPercentage?: number | null;

  @ApiProperty({ example: true })
  isDoEligible!: boolean;

  @ApiPropertyOptional({ example: '2026-09-30' })
  mandatoryRestUntil?: Date | null;

  @ApiProperty({ enum: RestStatusEnum, example: RestStatusEnum.RESTING })
  restStatus!: RestStatusEnum;

  @ApiPropertyOptional()
  additionalParams?: Record<string, unknown> | null;

  @ApiPropertyOptional({ example: 'Destilación simple discontinua' })
  notes?: string | null;

  @ApiProperty({ example: '2026-04-01T10:00:00.000Z' })
  createdAt!: Date;
}
