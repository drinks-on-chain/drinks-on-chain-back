import { IsOptional, IsString, IsBoolean } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationQueryDto } from '@shared/dto/pagination-query.dto';

export class QueryTerroirsDto extends PaginationQueryDto {
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
}
