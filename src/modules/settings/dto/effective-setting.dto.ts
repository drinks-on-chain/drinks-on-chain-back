import { ApiProperty } from '@nestjs/swagger';
import type { SettingAppliesAt, SettingValue } from '../settings.types';

export class EffectiveSettingDto {
  @ApiProperty({ example: 'trazabilidad.singani.reposoMinimoDias' })
  key!: string;

  @ApiProperty({ example: 'Reposo mínimo tras la destilación' })
  description!: string;

  @ApiProperty({
    description:
      'Valor efectivo: número, sí/no, texto, lista u objeto según el parámetro; null = vacío (ilimitado, desactivado o sin definir)',
    example: 180,
    nullable: true,
    oneOf: [
      { type: 'number' },
      { type: 'boolean' },
      { type: 'string' },
      { type: 'array', items: { type: 'string' } },
      { type: 'object' },
    ],
  })
  value!: SettingValue;

  @ApiProperty({
    enum: ['GLOBAL', 'WINERY'],
    description: 'WINERY = ajuste de la bodega; GLOBAL = estándar general',
  })
  source!: 'GLOBAL' | 'WINERY';

  @ApiProperty({
    enum: ['LOT', 'COLLECTION', 'IMMEDIATE'],
    description:
      'Cuándo se aplica: se fija en el lote al crearlo, en la colección al aprobarla o de inmediato',
  })
  appliesAt!: SettingAppliesAt;
}
