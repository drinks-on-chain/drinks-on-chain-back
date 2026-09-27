import { IsOptional, IsEnum, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationQueryDto } from '@shared/dto/pagination-query.dto';
import { ProductionProcessEnum, RestStatusEnum } from '@prisma/client';

export class QueryProductionBatchesDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ProductionProcessEnum })
  @IsOptional()
  @IsEnum(ProductionProcessEnum)
  processType?: ProductionProcessEnum;

  @ApiPropertyOptional({ enum: RestStatusEnum })
  @IsOptional()
  @IsEnum(RestStatusEnum)
  restStatus?: RestStatusEnum;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  fermentationTankId?: string;
}
