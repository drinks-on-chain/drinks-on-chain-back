import {
  IsUUID,
  IsNotEmpty,
  IsDateString,
  IsInt,
  Min,
  Max,
  IsNumber,
  IsPositive,
  IsOptional,
  IsString,
  Allow,
  ValidateNested,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  ApiHideProperty,
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';
import { CreateLotDto } from '@modules/lots/dto/lot.dto';

/** Análisis de madurez (§3.3): Brix 0–40, pH 2–5, acidez 0–30 g/L. */
export class MaturityInputDto {
  @ApiProperty({ example: 22.4, minimum: 0, maximum: 40, description: '°Bx' })
  @IsNumber()
  @Min(0)
  @Max(40)
  brixDegrees!: number;

  @ApiProperty({ example: 3.45, minimum: 2, maximum: 5 })
  @IsNumber()
  @Min(2)
  @Max(5)
  ph!: number;

  @ApiProperty({
    example: 6.8,
    minimum: 0,
    maximum: 30,
    description: 'Acidez total en g/L de ácido tartárico',
  })
  @IsNumber()
  @Min(0)
  @Max(30)
  acidityGl!: number;

  @ApiPropertyOptional({
    example: '2026-03-15T09:00:00Z',
    description: 'Momento de la medición (por defecto, la fecha de ingreso)',
  })
  @IsOptional()
  @IsDateString()
  measuredAt?: string;
}

export class CreateHarvestBatchDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Lote al que entra la uva (o `newLot`, o ninguno: uva recibida sin lote, contrato O2 §2.4)',
  })
  @IsOptional()
  @IsUUID()
  lotId?: string;

  @ApiPropertyOptional({
    type: () => CreateLotDto,
    description: 'Crea el lote desde la vendimia (solo OWNER y ENOLOGIST)',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => CreateLotDto)
  newLot?: CreateLotDto;

  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
    description: 'ID de la parcela o terroir de procedencia de la uva',
  })
  @IsUUID()
  @IsNotEmpty()
  terroirId!: string;

  @ApiProperty({
    example: '2026-03-15',
    description: 'Fecha de ingreso y pesaje en báscula (YYYY-MM-DD); no futura',
  })
  @IsDateString()
  @IsNotEmpty()
  intakeDate!: string;

  @ApiPropertyOptional({
    example: 2026,
    description:
      'Año de la vendimia (por defecto, el del lote o el de `intakeDate`)',
  })
  @IsOptional()
  @IsInt()
  @Min(1900)
  @Max(2100)
  harvestYear?: number;

  @ApiProperty({
    example: 15000.0,
    description: 'Peso bruto del camión/tolva en kilogramos',
  })
  @IsNumber()
  @IsPositive()
  grossWeightKg!: number;

  @ApiProperty({
    example: 150.0,
    description: 'Tara de los bins/transporte en kilogramos',
  })
  @IsNumber()
  @Min(0)
  tareWeightKg!: number;

  @ApiPropertyOptional({
    example: 16.5,
    description: 'Temperatura de la uva al momento de la descarga (°C)',
  })
  @IsOptional()
  @IsNumber()
  temperatureAtIntakeC?: number;

  @ApiPropertyOptional({
    type: () => MaturityInputDto,
    description: 'Análisis de madurez opcional (se registra aparte, §3.3)',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => MaturityInputDto)
  maturity?: MaturityInputDto;

  /**
   * No es un campo del alta (retirado en H2; fuera del OpenAPI): se declara
   * solo para responder 422 `TRC_PHYTO_IN_CREATE` a quien intente dictaminar
   * al pesar (EA-04), en lugar de un error genérico de campo desconocido.
   */
  @ApiHideProperty()
  @IsOptional()
  @Allow()
  phytosanitaryStatus?: unknown;

  @ApiPropertyOptional({
    example:
      'Uva fresca en excelente estado sanitario, cosecha manual matutina.',
    description: 'Observaciones agronómicas y de recepción',
  })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;
}
