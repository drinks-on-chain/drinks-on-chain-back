import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PhytoStatusEnum } from '@prisma/client';
import { TerroirResponseDto } from '@modules/terroirs/dto/terroir-response.dto';
import { FermentationTankResponseDto } from '@modules/traceability/dto/fermentation-tank-response.dto';

export class HarvestBatchResponseDto {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' })
  id!: string;

  @ApiProperty({ example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' })
  wineryId!: string;

  @ApiProperty({ example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' })
  terroirId!: string;

  @ApiProperty({ example: 'HARV-2026-POTRERO-001' })
  harvestBatchCode!: string;

  @ApiProperty({ example: '2026-03-15' })
  intakeDate!: Date;

  @ApiProperty({ example: 2026 })
  harvestYear!: number;

  @ApiProperty({ example: 15000.0 })
  grossWeightKg!: number;

  @ApiProperty({ example: 150.0 })
  tareWeightKg!: number;

  @ApiProperty({ example: 14850.0 })
  netWeightKg!: number;

  @ApiProperty({ example: 22.4 })
  brixDegrees!: number;

  @ApiProperty({ example: 3.45 })
  initialPh!: number;

  @ApiProperty({ example: 6.8 })
  initialAcidityGl!: number;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 16.5 })
  temperatureAtIntakeC?: number | null;

  @ApiProperty({ enum: PhytoStatusEnum, example: PhytoStatusEnum.APPROVED })
  phytosanitaryStatus!: PhytoStatusEnum;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'https://storage.drinksonchain.com/inspections/phyto-01.pdf',
  })
  phytoInspectionPdfUrl?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
  })
  certifiedByMemberId?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Cosecha matutina manual',
  })
  notes?: string | null;

  @ApiProperty({ example: '2026-09-06T12:00:00.000Z' })
  createdAt!: Date;

  @ApiPropertyOptional({
    type: () => TerroirResponseDto,
    description: 'En la lista y el detalle',
  })
  terroir?: TerroirResponseDto;

  @ApiPropertyOptional({
    type: () => FermentationTankResponseDto,
    isArray: true,
    description: 'Solo en el detalle',
  })
  fermentationTanks?: FermentationTankResponseDto[];
}
