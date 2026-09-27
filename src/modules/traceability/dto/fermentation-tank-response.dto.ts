import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TankStatusEnum, DestinationTypeEnum } from '@prisma/client';
import { HarvestBatchResponseDto } from '@modules/harvest-batches/dto/harvest-batch-response.dto';
import {
  EnologicalTreatmentResponseDto,
  FermentationLogResponseDto,
} from './fermentation-records-response.dto';

export class FermentationTankResponseDto {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' })
  id!: string;

  @ApiProperty({ example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' })
  wineryId!: string;

  @ApiProperty({ example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' })
  harvestBatchId!: string;

  @ApiProperty({ example: 'TK-03' })
  tankCode!: string;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 15000.0 })
  capacityLiters?: number | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Acero inoxidable AISI 316',
  })
  material?: string | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 10100.0 })
  volumeFilledLiters?: number | null;

  @ApiPropertyOptional({
    nullable: true,
    enum: DestinationTypeEnum,
    example: DestinationTypeEnum.SINGANI_DIST,
  })
  destinationType?: DestinationTypeEnum | null;

  @ApiProperty({ enum: TankStatusEnum, example: TankStatusEnum.FERMENTING })
  status!: TankStatusEnum;

  @ApiProperty({ example: '2026-03-15T14:30:00.000Z' })
  startDate!: Date;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    example: '2026-03-29T14:30:00.000Z',
  })
  endDate?: Date | null;

  @ApiProperty({ example: '2026-03-15T14:30:00.000Z' })
  createdAt!: Date;

  @ApiPropertyOptional({
    type: () => HarvestBatchResponseDto,
    description: 'En la lista y el detalle',
  })
  harvestBatch?: HarvestBatchResponseDto;

  @ApiPropertyOptional({
    type: () => FermentationLogResponseDto,
    isArray: true,
    description: 'Solo en el detalle',
  })
  logs?: FermentationLogResponseDto[];

  @ApiPropertyOptional({
    type: () => EnologicalTreatmentResponseDto,
    isArray: true,
    description: 'Solo en el detalle',
  })
  treatments?: EnologicalTreatmentResponseDto[];
}
