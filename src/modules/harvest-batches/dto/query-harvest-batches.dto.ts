import { IsOptional, IsInt, IsUUID, IsEnum, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PhytoStatusEnum } from '@prisma/client';

export class QueryHarvestBatchesDto {
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
