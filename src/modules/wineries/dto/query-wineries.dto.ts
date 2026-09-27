import { IsOptional, IsString, IsEnum } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationQueryDto } from '@shared/dto/pagination-query.dto';
import { WineryStatusEnum, WineryCategoryEnum } from '@prisma/client';

export class QueryWineriesDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: WineryStatusEnum,
    description:
      'Filtrar por estado de la bodega (INVITED, ACTIVE, SUSPENDED, REVOKED)',
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
}
