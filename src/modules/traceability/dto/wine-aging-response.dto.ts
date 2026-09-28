import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LotLockDto } from '@modules/lots/dto/lot.dto';
import { AgingStatusEnum } from '@prisma/client';
import { FermentationTankResponseDto } from './fermentation-tank-response.dto';
import { BottlingBatchResponseDto } from './bottling-batch-response.dto';

export class WineAgingResponseDto {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' })
  id!: string;

  @ApiProperty({ example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' })
  wineryId!: string;

  @ApiProperty({ example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' })
  fermentationTankId!: string;

  @ApiProperty({ example: 'Barrica' })
  containerType!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Roble Francés tostado medio',
  })
  containerMaterial?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'BAR-FR-2024-01',
  })
  containerCode?: string | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 1 })
  barrelUseCycle?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 225.0 })
  volumeLiters?: number | null;

  @ApiProperty({ example: 12 })
  plannedMonths!: number;

  @ApiProperty({ example: '2027-03-15' })
  lockUntilDate!: Date;

  @ApiProperty({ enum: AgingStatusEnum, example: AgingStatusEnum.AGING })
  agingStatus!: AgingStatusEnum;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Cava subterránea',
  })
  notes?: string | null;

  @ApiProperty({ example: '2026-03-15T14:30:00.000Z' })
  createdAt!: Date;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Lote (Ola 2)',
  })
  lotId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '2025-11-03',
    description: 'Inicio de la crianza (el candado se cuenta desde aquí)',
  })
  startDate!: Date | null;

  @ApiProperty({ type: Number, nullable: true, example: 12 })
  containerCount!: number | null;

  @ApiPropertyOptional({
    type: String,
    example: '2026-11-03',
    description:
      'Fin del candado con la instantánea del lote (rutas de crianza)',
  })
  unlockDate?: string;

  @ApiPropertyOptional({
    type: () => LotLockDto,
    nullable: true,
    description: 'Candado evaluado con el reloj de la base (rutas de crianza)',
  })
  lock?: LotLockDto | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description: 'Litros de la crianza aún sin embotellar (rutas de crianza)',
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
