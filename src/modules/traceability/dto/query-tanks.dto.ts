import { IsOptional, IsEnum, IsUUID, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { TankStatusEnum, DestinationTypeEnum } from '@prisma/client';

export class QueryTanksDto {
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
