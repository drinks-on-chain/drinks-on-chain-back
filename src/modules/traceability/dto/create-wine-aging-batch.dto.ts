import {
  IsUUID,
  IsNotEmpty,
  IsString,
  IsOptional,
  IsNumber,
  IsPositive,
  IsInt,
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

  @ApiPropertyOptional({
    example: 225.0,
    description: 'Volumen transferido a crianza en litros',
  })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  volumeLiters?: number;

  @ApiProperty({
    example: 12,
    description: 'Meses planificados de crianza en madera',
  })
  @IsInt()
  @Min(1)
  plannedMonths!: number;

  @ApiPropertyOptional({
    example: 'Crianza en barricas de primer uso en cava subterránea a 14°C',
    description: 'Observaciones de guarda',
  })
  @IsOptional()
  @IsString()
  notes?: string;
}
