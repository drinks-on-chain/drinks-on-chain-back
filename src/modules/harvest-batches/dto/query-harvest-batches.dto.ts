import { IsOptional, IsInt, IsUUID, IsEnum, Matches } from 'class-validator';
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

  @ApiPropertyOptional({
    description:
      'Filtrar por lote (`none` = uva recibida sin lote, contrato O2 §2.5)',
    example: 'none',
  })
  @IsOptional()
  @Matches(
    /^(none|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
    {
      message: 'lotId debe ser un UUID o none',
    },
  )
  lotId?: string;
}
