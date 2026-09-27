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
  IsEnum,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PhytoStatusEnum } from '@prisma/client';

export class CreateHarvestBatchDto {
  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
    description: 'ID de la parcela o terroir de procedencia de la uva',
  })
  @IsUUID()
  @IsNotEmpty()
  terroirId!: string;

  @ApiProperty({
    example: '2026-03-15',
    description: 'Fecha de ingreso y pesaje en báscula (YYYY-MM-DD)',
  })
  @IsDateString()
  @IsNotEmpty()
  intakeDate!: string;

  @ApiProperty({
    example: 2026,
    description: 'Año de la vendimia',
  })
  @IsInt()
  @Min(1900)
  @Max(2100)
  harvestYear!: number;

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

  @ApiProperty({
    example: 22.4,
    description: 'Grados Brix de madurez refractométrica (°Bx)',
  })
  @IsNumber()
  @IsPositive()
  brixDegrees!: number;

  @ApiProperty({
    example: 3.45,
    description: 'pH inicial del mosto en tolva',
  })
  @IsNumber()
  @IsPositive()
  initialPh!: number;

  @ApiProperty({
    example: 6.8,
    description: 'Acidez total inicial en g/L de ácido tartárico',
  })
  @IsNumber()
  @IsPositive()
  initialAcidityGl!: number;

  @ApiPropertyOptional({
    example: 16.5,
    description: 'Temperatura de la uva al momento de la descarga (°C)',
  })
  @IsOptional()
  @IsNumber()
  temperatureAtIntakeC?: number;

  @ApiPropertyOptional({
    enum: PhytoStatusEnum,
    default: PhytoStatusEnum.PENDING_INSPECTION,
    description: 'Estado fitosanitario inicial',
  })
  @IsOptional()
  @IsEnum(PhytoStatusEnum)
  phytosanitaryStatus?: PhytoStatusEnum;

  @ApiPropertyOptional({
    example:
      'Uva fresca en excelente estado sanitario, cosecha manual matutina.',
    description: 'Observaciones agronómicas y de recepción',
  })
  @IsOptional()
  @IsString()
  notes?: string;
}
