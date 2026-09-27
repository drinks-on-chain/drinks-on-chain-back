import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TankStatusEnum, DestinationTypeEnum } from '@prisma/client';

export class FermentationTankResponseDto {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' })
  id!: string;

  @ApiProperty({ example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' })
  wineryId!: string;

  @ApiProperty({ example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' })
  harvestBatchId!: string;

  @ApiProperty({ example: 'TK-03' })
  tankCode!: string;

  @ApiPropertyOptional({ example: 15000.0 })
  capacityLiters?: number | null;

  @ApiPropertyOptional({ example: 'Acero inoxidable AISI 316' })
  material?: string | null;

  @ApiPropertyOptional({ example: 10100.0 })
  volumeFilledLiters?: number | null;

  @ApiPropertyOptional({
    enum: DestinationTypeEnum,
    example: DestinationTypeEnum.SINGANI_DIST,
  })
  destinationType?: DestinationTypeEnum | null;

  @ApiProperty({ enum: TankStatusEnum, example: TankStatusEnum.FERMENTING })
  status!: TankStatusEnum;

  @ApiProperty({ example: '2026-03-15T14:30:00.000Z' })
  startDate!: Date;

  @ApiPropertyOptional({ example: '2026-03-29T14:30:00.000Z' })
  endDate?: Date | null;

  @ApiProperty({ example: '2026-03-15T14:30:00.000Z' })
  createdAt!: Date;
}
