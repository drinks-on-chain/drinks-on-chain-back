import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ErrorDetailDto } from '@shared/dto/api-error-response.dto';

// ── Balance del embotellado (§6.1) ─────────────────────────────────────────

export class BottlingPureAlcoholDto {
  @ApiProperty({ example: 900, description: 'Alcohol puro del corazón (L)' })
  availableLiters!: number;

  @ApiProperty({ example: 885, description: 'Alcohol puro embotellado (L)' })
  bottledLiters!: number;
}

export class BottlingBalanceDto {
  @ApiProperty({ example: 1500, description: 'Σ litros de las fuentes' })
  availableLiters!: number;

  @ApiProperty({ example: 750 })
  waterDilutionLiters!: number;

  @ApiProperty({ example: 2212.5, description: 'Botellas × cL / 100' })
  bottledLiters!: number;

  @ApiProperty({ example: 0 })
  leftoverLiters!: number;

  @ApiProperty({
    example: 37.5,
    description: 'Disponible + agua − embotellado − remanente',
  })
  lossLiters!: number;

  @ApiProperty({ example: 1.67 })
  lossPercent!: number;

  @ApiProperty({ example: 5, description: '`rules.bottling.maxLossPercent`' })
  maxLossPercent!: number;

  @ApiProperty({
    type: () => BottlingPureAlcoholDto,
    nullable: true,
    description: 'Solo singani',
  })
  pureAlcohol!: BottlingPureAlcoholDto | null;

  @ApiProperty({
    type: 'integer',
    example: 3000,
    description: 'Botellas que caben sin superar lo disponible',
  })
  maxBottles!: number;
}

// ── Entrada (§6.1) ─────────────────────────────────────────────────────────

export class LotBottlingSourceDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Crianza de origen (vino); uno de los dos ids',
  })
  @IsOptional()
  @IsUUID()
  wineAgingBatchId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Destilación de origen (singani); uno de los dos ids',
  })
  @IsOptional()
  @IsUUID()
  productionBatchId?: string;

  @ApiProperty({
    example: 1500,
    description: 'Litros que se toman de la fuente',
  })
  @IsNumber()
  @IsPositive()
  liters!: number;
}

export class BottlingLeftoverDto {
  @ApiProperty({ example: 10 })
  @IsNumber()
  @Min(0)
  liters!: number;

  @ApiProperty({ enum: ['RETAINED', 'DISCARDED'] })
  @IsIn(['RETAINED', 'DISCARDED'])
  disposition!: 'RETAINED' | 'DISCARDED';

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class CreateLotBottlingDto {
  @ApiPropertyOptional({
    type: () => LotBottlingSourceDto,
    isArray: true,
    description:
      'Por defecto: todas las fuentes abiertas del lote con su volumen disponible',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => LotBottlingSourceDto)
  sources?: LotBottlingSourceDto[];

  @ApiProperty({ example: '2026-10-01', description: 'No futura' })
  @IsDateString()
  bottlingDate!: string;

  @ApiProperty({ type: 'integer', minimum: 5, maximum: 300, example: 75 })
  @IsInt()
  @Min(5)
  @Max(300)
  packagingFormatCl!: number;

  @ApiProperty({ type: 'integer', minimum: 1, maximum: 100000, example: 2950 })
  @IsInt()
  @Min(1)
  @Max(100000)
  totalBottlesPackaged!: number;

  @ApiProperty({ example: 40, description: '% v/v de la botella' })
  @IsNumber()
  @IsPositive()
  @Max(100)
  finalAlcoholAbv!: number;

  @ApiPropertyOptional({
    example: 750,
    description: 'Solo singani; en vino → 422 `TRC_DILUTION_NOT_ALLOWED`',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  waterDilutionLiters?: number;

  @ApiPropertyOptional({ type: () => BottlingLeftoverDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => BottlingLeftoverDto)
  leftover?: BottlingLeftoverDto;

  @ApiPropertyOptional({ example: 'Vidrio Extra-Flint 750ml', maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  bottleType?: string;

  @ApiPropertyOptional({
    example: 'uploads/2026/10/etiqueta.png',
    description: '`key` de `POST /v1/uploads`',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  labelDesignKey?: string;
}

// ── Vista previa (§6.1) ────────────────────────────────────────────────────

export class BottlingPreviewDto {
  @ApiProperty({
    description: '`true` si el embotellado cumple todas las reglas',
  })
  valid!: boolean;

  @ApiProperty({ type: () => BottlingBalanceDto })
  balance!: BottlingBalanceDto;

  @ApiProperty({
    type: () => ErrorDetailDto,
    isArray: true,
    description: 'Una por regla incumplida (`code` `TRC_…`, `rule`, `meta`)',
  })
  violations!: ErrorDetailDto[];
}
