import { PartialType } from '@nestjs/swagger';
import { CreateTerroirDto } from './create-terroir.dto';
import { IsBoolean, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateTerroirDto extends PartialType(CreateTerroirDto) {
  @ApiPropertyOptional({
    example: true,
    description: 'Estado de actividad operativa de la parcela',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
