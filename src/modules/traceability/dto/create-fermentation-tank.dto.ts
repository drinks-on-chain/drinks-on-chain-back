import {
  IsUUID,
  IsNotEmpty,
  IsString,
  IsOptional,
  IsNumber,
  IsPositive,
  IsEnum,
  IsDateString,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DestinationTypeEnum, TankStatusEnum } from '@prisma/client';

export class CreateFermentationTankDto {
  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
    description: 'ID del lote de vendimia ingresado a la cuba',
  })
  @IsUUID()
  @IsNotEmpty()
  harvestBatchId!: string;

  @ApiProperty({
    example: 'TK-03',
    description: 'Código físico o identificador del tanque de fermentación',
  })
  @IsString()
  @IsNotEmpty()
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
    description: 'Volumen efectivo de mosto/líquido cargado en litros',
  })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  volumeFilledLiters?: number;

  @ApiPropertyOptional({
    enum: DestinationTypeEnum,
    example: DestinationTypeEnum.SINGANI_DIST,
    description: 'Destino del proceso (WINE_AGING, SINGANI_DIST, BEER_MATURATION, etc.)',
  })
  @IsOptional()
  @IsEnum(DestinationTypeEnum)
  destinationType?: DestinationTypeEnum;

  @ApiPropertyOptional({
    enum: TankStatusEnum,
    default: TankStatusEnum.FILLING,
    description: 'Estado inicial del tanque',
  })
  @IsOptional()
  @IsEnum(TankStatusEnum)
  status?: TankStatusEnum;

  @ApiProperty({
    example: '2026-03-15T14:30:00Z',
    description: 'Fecha y hora de inicio del llenado/fermentación',
  })
  @IsDateString()
  @IsNotEmpty()
  startDate!: string;
}
