import { IsOptional, IsEnum, IsBoolean } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationQueryDto } from '@shared/dto/pagination-query.dto';
import { BeverageTypeEnum } from '@prisma/client';

export class QueryBottlingBatchesDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: BeverageTypeEnum })
  @IsOptional()
  @IsEnum(BeverageTypeEnum)
  productType?: BeverageTypeEnum;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  isAnchoredOnChain?: boolean;
}
