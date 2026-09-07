import { IsOptional, IsEnum, IsUUID, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ProductionProcessEnum, RestStatusEnum } from '@prisma/client';

export class QueryProductionBatchesDto {
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

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 50;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number = 0;
}
