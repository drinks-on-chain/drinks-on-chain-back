import {
  IsEnum,
  IsNotEmpty,
  IsString,
  IsNumber,
  IsPositive,
  IsOptional,
  IsDateString,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TreatmentTypeEnum } from '@prisma/client';

export class CreateEnologicalTreatmentDto {
  @ApiProperty({
    enum: TreatmentTypeEnum,
    example: TreatmentTypeEnum.SO2_ADDITION,
    description: 'Tipo de tratamiento enológico regulado',
  })
  @IsEnum(TreatmentTypeEnum)
  @IsNotEmpty()
  treatmentType!: TreatmentTypeEnum;

  @ApiProperty({
    example: 'Metabisulfito de potasio grado alimentario',
    description: 'Nombre comercial o químico del aditivo',
  })
  @IsString()
  @IsNotEmpty()
  additiveName!: string;

  @ApiPropertyOptional({
    example: 'Laffort Oenologie',
    description: 'Fabricante o proveedor del insumo enológico',
  })
  @IsOptional()
  @IsString()
  additiveSupplier?: string;

  @ApiProperty({
    example: 30.0,
    description: 'Dosis aplicada en gramos por hectolitro (g/hL) o mg/L',
  })
  @IsNumber()
  @IsPositive()
  dosageAppliedGPerHl!: number;

  @ApiPropertyOptional({
    example: 3030.0,
    description: 'Total absoluto aplicado en gramos (g)',
  })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  totalAppliedG?: number;

  @ApiProperty({
    example: 'SENASAG-REG-ADD-2024-88',
    description: 'Código de autorización regulatoria SENASAG o norma técnica',
  })
  @IsString()
  @IsNotEmpty()
  regulatoryAuthCode!: string;

  @ApiProperty({
    example: '2026-03-15T15:00:00Z',
    description: 'Fecha y hora de aplicación del tratamiento',
  })
  @IsDateString()
  @IsNotEmpty()
  appliedAt!: string;

  @ApiPropertyOptional({
    example: 'Sulfitado inicial para protección antioxidante y antimicrobiana',
    description: 'Justificación o notas del enólogo',
  })
  @IsOptional()
  @IsString()
  notes?: string;
}
