import { IsOptional, IsEnum, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationQueryDto } from '@shared/dto/pagination-query.dto';
import { TankStatusEnum, DestinationTypeEnum } from '@prisma/client';

export class QueryTanksDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: TankStatusEnum })
  @IsOptional()
  @IsEnum(TankStatusEnum)
  status?: TankStatusEnum;

  @ApiPropertyOptional({ enum: DestinationTypeEnum })
  @IsOptional()
  @IsEnum(DestinationTypeEnum)
  destinationType?: DestinationTypeEnum;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  harvestBatchId?: string;
}
