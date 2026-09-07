import { IsOptional, IsString, IsBoolean, IsInt, Min } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class QueryTerroirsDto {
  @ApiPropertyOptional({
    description: 'Filtrar por elegibilidad de Denominación de Origen',
  })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  isDoEligible?: boolean;

  @ApiPropertyOptional({
    description: 'Filtrar por variedad (ej: Moscatel de Alejandría)',
  })
  @IsOptional()
  @IsString()
  varietyName?: string;

  @ApiPropertyOptional({
    description: 'Filtrar por tipo de materia prima (ej: uva, cebada)',
  })
  @IsOptional()
  @IsString()
  rawMaterialType?: string;

  @ApiPropertyOptional({
    description: 'Filtrar por estado activo',
  })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    default: 50,
    description: 'Límite de resultados',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 50;

  @ApiPropertyOptional({
    default: 0,
    description: 'Desplazamiento para paginación',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number = 0;
}
