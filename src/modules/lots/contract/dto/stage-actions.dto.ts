import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

// ── Tanques: transiciones (§4.2) ───────────────────────────────────────────

export class StartFermentationTankDto {
  @ApiPropertyOptional({
    example: '2026-03-14T08:00:00.000Z',
    description: 'Inicio de la fermentación; por defecto, ahora. No futura',
  })
  @IsOptional()
  @IsDateString()
  startedAt?: string;
}

export class CompleteFermentationTankDto {
  @ApiProperty({ example: '2026-03-28', description: 'Fin de la fermentación' })
  @IsDateString()
  endDate!: string;

  @ApiProperty({
    example: 12100,
    description: '≤ `volumeFilledLiters` del tanque',
  })
  @IsNumber()
  @IsPositive()
  finalVolumeLiters!: number;

  @ApiProperty({
    enum: ['WINE_AGING', 'SINGANI_DIST'],
    description:
      'Bifurcación (§4.3): debe coincidir con `productType` del lote si ya existe; si no, lo fija',
  })
  @IsIn(['WINE_AGING', 'SINGANI_DIST'])
  destination!: 'WINE_AGING' | 'SINGANI_DIST';
}

export class CleanFermentationTankDto {
  @ApiPropertyOptional({
    example: '2026-04-02T10:00:00.000Z',
    description: 'Por defecto, ahora. Libera el `tankCode`',
  })
  @IsOptional()
  @IsDateString()
  cleanedAt?: string;
}

// ── Crianza y destilación (§5.1, §5.2) ─────────────────────────────────────

export class DiscardWineAgingDto {
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Transform(trim)
  @IsString()
  @Length(3, 500)
  reason!: string;

  @ApiPropertyOptional({
    example: 225,
    description: 'Litros descartados; por defecto, todo lo disponible',
  })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  discardedLiters?: number;
}

export class DistillationCutsDto {
  @ApiProperty({ example: 120, description: 'Cabezas (L)' })
  @IsNumber()
  @Min(0)
  headsLiters!: number;

  @ApiProperty({ example: 1500, description: 'Corazón (L)' })
  @IsNumber()
  @IsPositive()
  heartLiters!: number;

  @ApiProperty({ example: 210, description: 'Colas (L)' })
  @IsNumber()
  @Min(0)
  tailsLiters!: number;
}

export class CloseDistillationDto {
  @ApiProperty({ example: '2026-04-10' })
  @IsDateString()
  processEndDate!: string;

  @ApiProperty({
    type: () => DistillationCutsDto,
    description:
      'Balance de masa: cabezas + corazón + colas (+ vinaza) ≤ `inputVolumeLiters`',
  })
  @ValidateNested()
  @Type(() => DistillationCutsDto)
  cuts!: DistillationCutsDto;

  @ApiProperty({ example: 60, description: 'Grado del corazón (% v/v)' })
  @IsNumber()
  @IsPositive()
  @Max(100)
  heartAbvPercent!: number;

  @ApiPropertyOptional({ example: 10270, description: 'Vinaza (L)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  vinasseLiters?: number;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class DiscardProductionBatchDto {
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Transform(trim)
  @IsString()
  @Length(3, 500)
  reason!: string;
}
