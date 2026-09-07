import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BeverageTypeEnum } from '@prisma/client';

export class BottlingBatchResponseDto {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' })
  id!: string;

  @ApiProperty({ example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' })
  wineryId!: string;

  @ApiPropertyOptional({ example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' })
  wineAgingBatchId?: string | null;

  @ApiPropertyOptional({ example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' })
  productionBatchId?: string | null;

  @ApiProperty({ enum: BeverageTypeEnum, example: BeverageTypeEnum.SINGANI })
  productType!: BeverageTypeEnum;

  @ApiProperty({ example: 'KHL-2026-SINGANI-001' })
  internationalLotCode!: string;

  @ApiProperty({ example: 40.0 })
  finalAlcoholAbv!: number;

  @ApiPropertyOptional({ example: 1321.0 })
  waterDilutionLiters?: number | null;

  @ApiProperty({ example: 4080 })
  totalBottlesPackaged!: number;

  @ApiProperty({ example: 75 })
  packagingFormatCl!: number;

  @ApiPropertyOptional({ example: 'Vidrio Extra-Flint 750ml' })
  bottleType?: string | null;

  @ApiPropertyOptional({ example: 'https://storage.drinksonchain.com/labels/singani.png' })
  labelDesignUrl?: string | null;

  @ApiProperty({ example: '2026-10-01' })
  bottlingDate!: Date;

  @ApiPropertyOptional({ example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d' })
  releasedByMemberId?: string | null;

  @ApiPropertyOptional({ example: '0x1234abcd...' })
  blockchainAnchorTxHash?: string | null;

  @ApiPropertyOptional({ example: 'a1b2c3d4e5f6...' })
  blockchainDataHash?: string | null;

  @ApiProperty({ example: false })
  isAnchoredOnChain!: boolean;

  @ApiPropertyOptional({ example: '2026-10-01T12:00:00.000Z' })
  anchoredAt?: Date | null;

  @ApiPropertyOptional({ example: 'https://drinksonchain.com/trace/batch/KHL-2026-SINGANI-001' })
  qrBatchUrl?: string | null;

  @ApiProperty({ example: '2026-10-01T12:00:00.000Z' })
  createdAt!: Date;
}
