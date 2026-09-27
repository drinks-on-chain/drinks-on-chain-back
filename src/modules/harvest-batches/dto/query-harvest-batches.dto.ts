import { IsOptional, IsInt, IsUUID, IsEnum } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { WineryScopedPaginationQueryDto } from '@shared/dto/pagination-query.dto';
import { PhytoStatusEnum } from '@prisma/client';

export class QueryHarvestBatchesDto extends WineryScopedPaginationQueryDto {
  @ApiPropertyOptional({
    example: 2026,
    description: 'Filtrar por año de vendimia',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  harvestYear?: number;

  @ApiPropertyOptional({
    description: 'Filtrar por ID de la parcela de origen',
  })
  @IsOptional()
  @IsUUID()
  terroirId?: string;

  @ApiPropertyOptional({
    enum: PhytoStatusEnum,
    description: 'Filtrar por estado fitosanitario',
  })
  @IsOptional()
  @IsEnum(PhytoStatusEnum)
  phytosanitaryStatus?: PhytoStatusEnum;
}
