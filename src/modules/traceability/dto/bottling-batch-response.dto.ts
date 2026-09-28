import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BeverageTypeEnum } from '@prisma/client';
import { BatchLabAnalysisResponseDto } from './batch-lab-analysis-response.dto';
import { WineAgingResponseDto } from './wine-aging-response.dto';
import { ProductionBatchResponseDto } from './production-batch-response.dto';
import { BottlingBalanceDto } from '@modules/lots/contract/dto/lot-bottling.dto';

export class BottlingLeftoverResponseDto {
  @ApiProperty({ example: 12.5 }) liters!: number;
  @ApiProperty({ enum: ['RETAINED', 'DISCARDED'] }) disposition!: string;
  @ApiProperty({ type: String, nullable: true }) notes!: string | null;
}

export class BottleCodesSummaryDto {
  @ApiProperty({ example: 2950 }) total!: number;
  @ApiProperty({ example: 2950 }) active!: number;
  @ApiProperty({ example: 0 }) voided!: number;
  @ApiProperty({ type: Number, nullable: true, example: 1 }) firstSerial!:
    number | null;
  @ApiProperty({ type: Number, nullable: true, example: 2950 }) lastSerial!:
    number | null;
}

export class LabelDesignDto {
  @ApiProperty() key!: string;
  @ApiProperty({ type: String, nullable: true }) url!: string | null;
}

export class BottlingBatchResponseDto {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' })
  id!: string;

  @ApiProperty({ example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' })
  wineryId!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
  })
  wineAgingBatchId?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
  })
  productionBatchId?: string | null;

  @ApiProperty({ enum: BeverageTypeEnum, example: BeverageTypeEnum.SINGANI })
  productType!: BeverageTypeEnum;

  @ApiProperty({ example: 'KHL-2026-SINGANI-001' })
  internationalLotCode!: string;

  @ApiProperty({ example: 40.0 })
  finalAlcoholAbv!: number;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 1321.0 })
  waterDilutionLiters?: number | null;

  @ApiProperty({ example: 4080 })
  totalBottlesPackaged!: number;

  @ApiProperty({ example: 75 })
  packagingFormatCl!: number;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Vidrio Extra-Flint 750ml',
  })
  bottleType?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'https://storage.drinksonchain.com/labels/singani.png',
  })
  labelDesignUrl?: string | null;

  @ApiProperty({ example: '2026-10-01' })
  bottlingDate!: Date;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
  })
  releasedByMemberId?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '0x1234abcd...',
  })
  blockchainAnchorTxHash?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: null,
    description:
      'Obsoleto: `null` en los embotellados de la Ola 2 (el hash válido es el del expediente, §10)',
  })
  blockchainDataHash?: string | null;

  @ApiProperty({ example: false })
  isAnchoredOnChain!: boolean;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    nullable: true,
    example: '2026-10-01T12:00:00.000Z',
  })
  anchoredAt?: Date | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'https://app.drinksonchain.bo/b/CVJ-2026-SINGANI-004',
    description: '`{PASSPORT_BASE_URL}/b/{lotCode}` (OP-06)',
  })
  qrBatchUrl?: string | null;

  @ApiProperty({ example: '2026-10-01T12:00:00.000Z' })
  createdAt!: Date;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Lote (Ola 2)',
  })
  lotId!: string | null;

  @ApiPropertyOptional({
    example: 'CVJ-2026-SINGANI-004',
    description:
      'Código de lote (= `internationalLotCode`; rutas de embotellado)',
  })
  lotCode?: string;

  @ApiPropertyOptional({
    type: () => BottlingBalanceDto,
    nullable: true,
    description:
      'Balance con la merma de la instantánea (rutas de embotellado)',
  })
  balance?: BottlingBalanceDto | null;

  @ApiPropertyOptional({
    type: () => BottlingLeftoverResponseDto,
    nullable: true,
  })
  leftover?: BottlingLeftoverResponseDto | null;

  @ApiPropertyOptional({
    type: () => BottleCodesSummaryDto,
    description: 'Códigos de botella (rutas de embotellado)',
  })
  bottleCodes?: BottleCodesSummaryDto;

  @ApiPropertyOptional({ type: () => LabelDesignDto, nullable: true })
  labelDesign?: LabelDesignDto | null;

  @ApiPropertyOptional({
    type: () => BatchLabAnalysisResponseDto,
    nullable: true,
    description:
      'Análisis vigente (reanálisis: el último); en la lista y el detalle',
  })
  labAnalysis?: BatchLabAnalysisResponseDto | null;

  @ApiPropertyOptional({
    type: () => WineAgingResponseDto,
    nullable: true,
    description: 'Solo en el detalle',
  })
  wineAgingBatch?: WineAgingResponseDto | null;

  @ApiPropertyOptional({
    type: () => ProductionBatchResponseDto,
    nullable: true,
    description: 'Solo en el detalle',
  })
  productionBatch?: ProductionBatchResponseDto | null;
}
