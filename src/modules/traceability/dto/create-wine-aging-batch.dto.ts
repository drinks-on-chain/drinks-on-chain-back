import {
  IsUUID,
  IsNotEmpty,
  IsString,
  IsOptional,
  IsNumber,
  IsPositive,
  IsInt,
  IsDateString,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateWineAgingBatchDto {
  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
    description: 'ID del tanque de fermentación de origen',
  })
  @IsUUID()
  @IsNotEmpty()
  fermentationTankId!: string;

  @ApiProperty({
    example: 'Barrica',
    description: 'Tipo de contenedor (Barrica, Tonel, Ánfora, etc.)',
  })
  @IsString()
  @IsNotEmpty()
  containerType!: string;

  @ApiPropertyOptional({
    example: 'Roble Francés tostado medio (Allier)',
    description: 'Material o tipo de madera',
  })
  @IsOptional()
  @IsString()
  containerMaterial?: string;

  @ApiPropertyOptional({
    example: 'BAR-FR-2024-01',
    description: 'Identificador o código físico de la barrica/lote de barricas',
  })
  @IsOptional()
  @IsString()
  containerCode?: string;

  @ApiPropertyOptional({
    example: 1,
    description: 'Ciclo de uso de la barrica (1 = primer uso, 2 = segundo uso)',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  barrelUseCycle?: number;

  @ApiProperty({
    example: 225.0,
    description:
      'Volumen transferido a crianza en litros: **obligatorio** (Ola 2) y ≤ lo disponible del tanque; la diferencia queda como merma de trasiego',
  })
  @IsNumber()
  @IsPositive()
  volumeLiters!: number;

  @ApiPropertyOptional({
    example: 12,
    description: 'Barricas o contenedores que agrupa la crianza',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  containerCount?: number;

  @ApiProperty({
    example: 12,
    description:
      'Meses planificados de crianza (≥ mínimo de la instantánea del lote, `trazabilidad.vino.crianzaMinimaMeses`); el candado es inicio + meses de calendario',
  })
  @IsInt()
  @Min(1)
  plannedMonths!: number;

  @ApiPropertyOptional({
    example: '2025-01-15T00:00:00Z',
    description:
      'Fecha de ingreso a barrica (por defecto hoy en La Paz); no futura ni anterior al inicio del tanque',
  })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({
    example: 'Crianza en barricas de primer uso en cava subterránea a 14°C',
    description: 'Observaciones de guarda',
  })
  @IsOptional()
  @IsString()
  notes?: string;
}
