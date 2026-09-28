import {
  IsUUID,
  IsNotEmpty,
  IsString,
  IsOptional,
  IsNumber,
  IsPositive,
  IsEnum,
  IsDateString,
  IsBoolean,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  ValidateNested,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DestinationTypeEnum, TankStatusEnum } from '@prisma/client';
import { CreateLotDto } from '@modules/lots/dto/lot.dto';

/** Entrada de uva a un tanque (§4.1). */
export class TankInputDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  harvestBatchId!: string;

  @ApiPropertyOptional({
    example: 18400,
    description: 'Kilos del pesaje (por defecto, todo lo disponible)',
  })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  kg?: number;
}

export class CreateFermentationTankDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Lote del tanque (o `newLot`; si falta, el de las entradas)',
  })
  @IsOptional()
  @IsUUID()
  lotId?: string;

  @ApiPropertyOptional({
    type: () => CreateLotDto,
    description:
      'Crea el lote desde el tanque y lo asigna a las entradas sin lote',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => CreateLotDto)
  newLot?: CreateLotDto;

  @ApiPropertyOptional({
    type: () => TankInputDto,
    isArray: true,
    description: 'Pesajes que entran al tanque (≥ 1), todos del mismo lote',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => TankInputDto)
  inputs?: TankInputDto[];

  @ApiPropertyOptional({
    example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
    deprecated: true,
    description:
      'Legado hasta H2: equivale a `inputs: [{ harvestBatchId }]` (todo lo disponible)',
  })
  @IsOptional()
  @IsUUID()
  harvestBatchId?: string;

  @ApiProperty({
    example: 'TK-03',
    description:
      'Código físico del tanque; no se reutiliza hasta limpiarlo (S-7)',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  tankCode!: string;

  @ApiPropertyOptional({
    example: 15000.0,
    description: 'Capacidad total nominal del tanque en litros',
  })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  capacityLiters?: number;

  @ApiPropertyOptional({
    example: 'Acero inoxidable AISI 316',
    description: 'Material del contenedor (Inox, Cemento epoxilado, Roble)',
  })
  @IsOptional()
  @IsString()
  material?: string;

  @ApiPropertyOptional({
    example: 10100.0,
    description:
      'Mosto cargado en litros (≤ capacidad). Obligatorio desde H2; sin él, el balance del embotellado no se puede verificar',
  })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  volumeFilledLiters?: number;

  @ApiPropertyOptional({
    enum: ['WINE_AGING', 'SINGANI_DIST'],
    example: DestinationTypeEnum.SINGANI_DIST,
    description:
      'Legado: predeclara la bifurcación; debe coincidir con el tipo del lote (y lo fija si no lo tiene; singani exige la D.O.)',
  })
  @IsOptional()
  @IsEnum(DestinationTypeEnum)
  destinationType?: DestinationTypeEnum;

  @ApiPropertyOptional({
    description: '`true`: el tanque nace en `FERMENTING`',
  })
  @IsOptional()
  @IsBoolean()
  startFermentation?: boolean;

  @ApiPropertyOptional({
    enum: ['FILLING', 'FERMENTING'],
    default: TankStatusEnum.FILLING,
    deprecated: true,
    description:
      'Legado: estado inicial. `COMPLETED`, `TRANSFERRED` y `CLEANED` → 422 (el estado cambia solo por acciones)',
  })
  @IsOptional()
  @IsEnum(TankStatusEnum)
  status?: TankStatusEnum;

  @ApiProperty({
    example: '2026-03-15T14:30:00Z',
    description:
      'Inicio del llenado/fermentación: no futuro ni anterior al último ingreso de las entradas',
  })
  @IsDateString()
  @IsNotEmpty()
  startDate!: string;
}
