import {
  IsNumber,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsDateString,
  IsPositive,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateFermentationLogDto {
  @ApiProperty({
    example: 15.5,
    description: 'Temperatura del mosto/líquido en grados Celsius (°C)',
  })
  @IsNumber()
  @IsNotEmpty()
  temperatureCelsius!: number;

  @ApiPropertyOptional({
    example: 1.045,
    description: 'Densidad relativa o gravedad específica (Specific Gravity)',
  })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  specificGravity?: number;

  @ApiPropertyOptional({
    example: 3.42,
    description: 'Valor de pH registrado en la toma',
  })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  phValue?: number;

  @ApiPropertyOptional({
    example: 'Desprendimiento vigoroso de CO2, aroma floral intenso',
    description: 'Observaciones cualitativas de la fermentación',
  })
  @IsOptional()
  @IsString()
  co2Observations?: string;

  @ApiProperty({
    example: '2026-03-16T08:00:00Z',
    description: 'Fecha y hora exacta de la lectura',
  })
  @IsDateString()
  @IsNotEmpty()
  recordedAt!: string;

  @ApiPropertyOptional({
    example: 'Remontado de 15 minutos efectuado tras la medición',
    description: 'Notas operativas de bodega',
  })
  @IsOptional()
  @IsString()
  notes?: string;
}
