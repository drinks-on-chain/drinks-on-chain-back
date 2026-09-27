import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  Allow,
  IsBoolean,
  IsOptional,
  ValidateBy,
  ValidationOptions,
  buildMessage,
  isUUID,
} from 'class-validator';
import { ReasonProperty } from '@shared/audit/requires-reason';
import type {
  SettingAppliesAt,
  SettingLevels,
  SettingType,
  SettingValue,
} from '../settings.types';
import { SETTING_TYPES } from '../settings.types';

/** Esquema OpenAPI de un valor de parámetro (depende del tipo). */
function valueProperty(extra: { description?: string; example?: unknown }) {
  return ApiProperty({
    nullable: true,
    oneOf: [
      { type: 'number' },
      { type: 'boolean' },
      { type: 'string' },
      { type: 'array', items: { type: 'string' } },
      { type: 'object' },
    ],
    ...extra,
  });
}

/** Máximo de bodegas en una selección (el resto, con `ALL`). */
export const MAX_WINERY_SELECTION = 1000;

/** `'ALL'` o una lista no vacía de UUID de bodegas. */
function IsWineryIds(options?: ValidationOptions) {
  return ValidateBy(
    {
      name: 'isWineryIds',
      validator: {
        validate: (value: unknown) =>
          value === 'ALL' ||
          (Array.isArray(value) &&
            value.length > 0 &&
            value.length <= MAX_WINERY_SELECTION &&
            value.every((id) => typeof id === 'string' && isUUID(id))),
        defaultMessage: buildMessage(
          () =>
            `wineryIds debe ser 'ALL' o una lista de 1 a ${MAX_WINERY_SELECTION} UUID de bodegas`,
          options,
        ),
      },
    },
    options,
  );
}

function wineryIdsProperty() {
  return ApiProperty({
    oneOf: [
      { type: 'string', enum: ['ALL'] },
      {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
        minItems: 1,
        maxItems: MAX_WINERY_SELECTION,
      },
    ],
    description: "'ALL' = todas las bodegas no revocadas, o una selección",
  });
}

export class SettingDefinitionDto {
  @ApiProperty({ example: 'trazabilidad.singani.reposoMinimoDias' })
  key!: string;

  @ApiProperty({ example: 'Reposo mínimo tras la destilación' })
  description!: string;

  @ApiProperty({ enum: SETTING_TYPES })
  type!: SettingType;

  @ApiPropertyOptional({ type: [String], example: ['BURN', 'EXTEND'] })
  enumValues?: string[];

  @ApiPropertyOptional({ example: 'días' })
  unit?: string;

  @ApiProperty({
    enum: ['GLOBAL', 'GLOBAL_AND_WINERY', 'WINERY'],
    description:
      'GLOBAL = solo estándar general · GLOBAL_AND_WINERY = estándar y ajuste por bodega · WINERY = solo por bodega',
  })
  levels!: SettingLevels;

  @ApiProperty({ enum: ['LOT', 'COLLECTION', 'IMMEDIATE'] })
  appliesAt!: SettingAppliesAt;

  @valueProperty({ example: 180 })
  default!: SettingValue;

  @ApiPropertyOptional({ example: 0 })
  min?: number;

  @ApiPropertyOptional({ example: 3650 })
  max?: number;

  @ApiProperty({
    nullable: true,
    oneOf: [{ type: 'number' }, { type: 'array', items: { type: 'string' } }],
    description:
      'Piso legal (A-31): un ajuste por bodega más laxo exige excepción legal',
    example: 180,
  })
  legalMinimum!: number | string[] | null;

  @valueProperty({ example: 180, description: 'Estándar general vigente' })
  globalValue!: SettingValue;

  @ApiProperty({ minimum: 0, example: 1 })
  overridesCount!: number;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Nombre de quien cambió el estándar por última vez; null = instalación',
  })
  updatedBy!: string | null;
}

export class SettingOverrideDto {
  @ApiProperty({ format: 'uuid' })
  wineryId!: string;

  @ApiProperty({ example: 'Altos de Calamuchita' })
  wineryName!: string;

  @valueProperty({ example: 210 })
  value!: SettingValue;

  @ApiProperty({
    description: 'Autorizado bajo el mínimo legal por administración (A-31)',
  })
  legalException!: boolean;

  @ApiProperty()
  reason!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;

  @ApiProperty({ description: 'Nombre de quien lo aplicó' })
  updatedBy!: string;
}

export class SettingHistoryEntryDto {
  @ApiProperty({ format: 'date-time' })
  at!: string;

  @ApiProperty({
    description: 'Nombre de quien lo cambió (Sistema sin persona)',
  })
  by!: string;

  @ApiProperty({
    example: 'GLOBAL',
    description: "'GLOBAL' o el id de la bodega",
  })
  scope!: string;

  @valueProperty({
    description:
      'Valor antes; en un ajuste por bodega sin valor propio, el estándar que regía',
  })
  before!: SettingValue;

  @valueProperty({ description: 'Valor después' })
  after!: SettingValue;

  @ApiProperty()
  reason!: string;

  @ApiProperty({
    description:
      'Ajuste autorizado bajo el mínimo legal (A-31); adicional al contrato',
  })
  legalException!: boolean;
}

export class UpdateSettingDto {
  @valueProperty({
    description: 'Nuevo estándar general (tipo según el parámetro)',
    example: 200,
  })
  @Allow()
  value!: unknown;

  @ReasonProperty()
  reason!: string;
}

export class SetSettingOverridesDto {
  @wineryIdsProperty()
  @IsWineryIds()
  wineryIds!: string[] | 'ALL';

  @valueProperty({
    description: 'Valor del ajuste (tipo según el parámetro)',
    example: 210,
  })
  @Allow()
  value!: unknown;

  @ReasonProperty()
  reason!: string;

  @ApiPropertyOptional({
    description:
      'Autoriza un valor bajo el mínimo legal (A-31). Solo administración; queda marcado',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  legalException?: boolean;
}

export class ResetSettingOverridesDto {
  @wineryIdsProperty()
  @IsWineryIds()
  wineryIds!: string[] | 'ALL';

  @ReasonProperty()
  reason!: string;
}

export class SettingOverridesUpdatedDto {
  @ApiProperty({ minimum: 0, example: 2 })
  updated!: number;
}

export class SettingOverridesResetDto {
  @ApiProperty({ minimum: 0, example: 2 })
  reset!: number;
}
