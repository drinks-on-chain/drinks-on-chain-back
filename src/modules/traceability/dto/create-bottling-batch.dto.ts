import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsUUID,
  IsNumber,
  IsPositive,
  IsInt,
  Min,
  IsString,
  IsDateString,
  IsUrl,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BeverageTypeEnum } from '@prisma/client';

export class CreateBottlingBatchDto {
  @ApiPropertyOptional({
    example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
    description: 'ID del lote de crianza en barrica (para vinos)',
  })
  @IsOptional()
  @IsUUID()
  wineAgingBatchId?: string;

  @ApiPropertyOptional({
    example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
    description:
      'ID del lote de destilación/producción (para Singani o licores)',
  })
  @IsOptional()
  @IsUUID()
  productionBatchId?: string;

  @ApiProperty({
    enum: BeverageTypeEnum,
    example: BeverageTypeEnum.SINGANI,
    description: 'Tipo de bebida final embotellada',
  })
  @IsEnum(BeverageTypeEnum)
  @IsNotEmpty()
  productType!: BeverageTypeEnum;

  @ApiProperty({
    example: 40.0,
    description: 'Graduación alcohólica final comercial (% ABV)',
  })
  @IsNumber()
  @IsPositive()
  finalAlcoholAbv!: number;

  @ApiPropertyOptional({
    example: 1321.0,
    description: 'Volumen de agua osmotizada agregada para dilución (litros)',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  waterDilutionLiters?: number;

  @ApiProperty({
    example: 4080,
    description: 'Cantidad total de botellas envasadas',
  })
  @IsInt()
  @IsPositive()
  totalBottlesPackaged!: number;

  @ApiProperty({
    example: 75,
    description:
      'Formato o volumen nominal de la botella en centilitros (cL: 75, 70, 50, 37, 33)',
  })
  @IsInt()
  @IsPositive()
  packagingFormatCl!: number;

  @ApiPropertyOptional({
    example: 'Vidrio Extra-Flint 750ml con grabado',
    description: 'Tipo o referencia de botella de vidrio',
  })
  @IsOptional()
  @IsString()
  bottleType?: string;

  @ApiPropertyOptional({
    example:
      'https://storage.drinksonchain.com/labels/singani-anniversary-750.png',
    description: 'URL del arte o diseño de etiqueta aprobado',
  })
  @IsOptional()
  @IsUrl({ require_tld: false })
  labelDesignUrl?: string;

  @ApiProperty({
    example: '2026-10-01',
    description: 'Fecha oficial de fraccionamiento y embotellado (YYYY-MM-DD)',
  })
  @IsDateString()
  @IsNotEmpty()
  bottlingDate!: string;
}
