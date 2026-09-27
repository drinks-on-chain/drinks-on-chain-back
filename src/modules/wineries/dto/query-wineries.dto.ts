import { IsOptional, IsString, IsEnum, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { WineryStatusEnum, WineryCategoryEnum } from '@prisma/client';

export class QueryWineriesDto {
  @ApiPropertyOptional({
    enum: WineryStatusEnum,
    description:
      'Filtrar por estado de certificación (PENDING, ACTIVE, SUSPENDED, REVOKED)',
  })
  @IsOptional()
  @IsEnum(WineryStatusEnum)
  status?: WineryStatusEnum;

  @ApiPropertyOptional({
    enum: WineryCategoryEnum,
    description: 'Filtrar por categoría (WINERY, DISTILLERY, BREWERY)',
  })
  @IsOptional()
  @IsEnum(WineryCategoryEnum)
  beverageCategory?: WineryCategoryEnum;

  @ApiPropertyOptional({
    description: 'Búsqueda por nombre legal o comercial',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    default: 50,
    description: 'Límite de resultados por página',
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
