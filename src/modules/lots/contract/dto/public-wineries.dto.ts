import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { WineryCategoryEnum } from '@prisma/client';
import { PaginationQueryDto } from '@shared/dto/pagination-query.dto';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** `GET /v1/public/wineries?region=&category=` (contrato O2 §12.1, O2-WEB-1). */
export class PublicWineriesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: 'Región (coincidencia parcial, sin distinguir mayúsculas)',
    example: 'Tarija',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  region?: string;

  @ApiPropertyOptional({ enum: WineryCategoryEnum, enumName: 'WineryCategory' })
  @IsOptional()
  @IsEnum(WineryCategoryEnum, { message: 'Categoría no válida' })
  category?: WineryCategoryEnum;
}
