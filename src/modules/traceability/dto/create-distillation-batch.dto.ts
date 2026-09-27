import { Prisma } from '@prisma/client';
import {
  IsUUID,
  IsNotEmpty,
  IsString,
  IsOptional,
  IsNumber,
  IsPositive,
  IsDateString,
  IsBoolean,
  IsObject,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateDistillationBatchDto {
  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
    description: 'ID del tanque de vino base fermentado a destilar',
  })
  @IsUUID()
  @IsNotEmpty()
  fermentationTankId!: string;

  @ApiProperty({
    example: 'Alambique de Cobre Charentais AL-01 (1,500 L)',
    description: 'Identificador del equipo de destilación',
  })
  @IsString()
  @IsNotEmpty()
  equipmentIdentifier!: string;

  @ApiProperty({
    example: '2026-04-01',
    description: 'Fecha de inicio del ciclo de destilación (YYYY-MM-DD)',
  })
  @IsDateString()
  @IsNotEmpty()
  processStartDate!: string;

  @ApiPropertyOptional({
    example: '2026-04-03',
    description: 'Fecha de finalización y corte definitivo (YYYY-MM-DD)',
  })
  @IsOptional()
  @IsDateString()
  processEndDate?: string;

  @ApiPropertyOptional({
    example: 10000.0,
    description: 'Volumen total de vino base cargado al alambique (litros)',
  })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  inputVolumeLiters?: number;

  @ApiPropertyOptional({
    example: 1750.0,
    description: 'Volumen obtenido de corazón noble de destilado (litros)',
  })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  outputVolumeLiters?: number;

  @ApiPropertyOptional({
    example: 570.0,
    description: 'Volumen total de descarte (cabezas + colas) en litros',
  })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  wasteVolumeLiters?: number;

  @ApiPropertyOptional({
    example: 70.2,
    description: 'Graduación alcohólica del corazón de destilación (% ABV)',
  })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  initialAlcoholPercentage?: number;

  @ApiPropertyOptional({
    example: true,
    description: 'Elegible para Denominación de Origen Singani',
  })
  @IsOptional()
  @IsBoolean()
  isDoEligible?: boolean;

  @ApiPropertyOptional({
    example: {
      headDiscardLiters: 120,
      heartYieldLiters: 1750,
      tailDiscardLiters: 450,
      vaporTempC: 84.5,
    },
    description: 'Parámetros técnicos de corte y balance térmico',
  })
  @IsOptional()
  @IsObject()
  additionalParams?: Prisma.InputJsonObject;

  @ApiPropertyOptional({
    example:
      'Destilación lenta a fuego directo con separación estricta de cabezas',
    description: 'Notas del maestro destilador',
  })
  @IsOptional()
  @IsString()
  notes?: string;
}
