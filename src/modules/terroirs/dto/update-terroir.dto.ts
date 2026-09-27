import { PartialType } from '@nestjs/swagger';
import { CreateTerroirDto } from './create-terroir.dto';
import { IsBoolean, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { NullableFields } from '@shared/pipes/optional-nulls';

/**
 * Edición parcial de una parcela. `null` borra los datos opcionales de la
 * lista de `@NullableFields`; en el resto, `null` equivale a omitir el campo.
 */
@NullableFields(
  'cadastreCode',
  'latitude',
  'longitude',
  'geographicPolygonGeojson',
  'soilType',
  'irrigationSystem',
  'doType',
  'doCertificateUrl',
)
export class UpdateTerroirDto extends PartialType(CreateTerroirDto) {
  @ApiPropertyOptional({
    example: true,
    description: 'Estado de actividad operativa de la parcela',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
