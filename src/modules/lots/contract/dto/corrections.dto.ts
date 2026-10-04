import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  ValidateNested,
} from 'class-validator';
import { TraceActorDto } from '@modules/lots/dto/lot.dto';
import { JSON_VALUE_SCHEMA } from '@shared/dto/json-value.schema';

/** Registros que admiten corrección compensatoria (contrato O2 §9). */
export const CORRECTION_TARGET_TYPES = [
  'TERROIR',
  'HARVEST_BATCH',
  'MATURITY_ANALYSIS',
  'PHYTO_DECISION',
  'FERMENTATION_TANK',
  'FERMENTATION_LOG',
  'TREATMENT',
  'WINE_AGING',
  'PRODUCTION_BATCH',
  'BOTTLING',
  'LAB_ANALYSIS',
] as const;
export type CorrectionTargetType = (typeof CORRECTION_TARGET_TYPES)[number];
export const CORRECTION_KINDS = ['AMEND', 'VOID'] as const;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const CORRECTABLE_FIELDS_HELP =
  'Campos corregibles (lista cerrada): pesaje (`grossWeightKg`, `tareWeightKg`, `intakeDate`, ' +
  '`temperatureAtIntakeC`, `notes`); análisis y lecturas (sus valores y fechas, o `VOID`); ' +
  'tratamiento (dosis, aditivo, fechas, o `VOID`); tanque (`volumeFilledLiters`, `finalVolumeLiters`, ' +
  'fechas); crianza (`plannedMonths`, `volumeLiters`, `startDate`); destilación (`inputVolumeLiters`, ' +
  'cortes, `heartAbvPercent`, fechas); embotellado (`finalAlcoholAbv`, `bottleType`, `leftover`); ' +
  'laboratorio (valores o `VOID`); dictamen (`VOID` mientras el pesaje no esté en un tanque); ' +
  'parcela (`altitudeMasl`, `varietyName`, `rawMaterialType`). Otro campo → 422 ' +
  '`TRC_CORRECTION_FIELD_NOT_CORRECTABLE`.';

// ── Entradas ───────────────────────────────────────────────────────────────

export class CorrectionTargetDto {
  @ApiProperty({ enum: CORRECTION_TARGET_TYPES })
  @IsIn(CORRECTION_TARGET_TYPES)
  type!: CorrectionTargetType;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  id!: string;
}

export class CreateLotCorrectionDto {
  @ApiProperty({ type: () => CorrectionTargetDto })
  @ValidateNested()
  @Type(() => CorrectionTargetDto)
  target!: CorrectionTargetDto;

  @ApiProperty({
    enum: CORRECTION_KINDS,
    description:
      '`VOID`: el registro deja de contar (lecturas, tratamientos, análisis, dictámenes)',
  })
  @IsIn(CORRECTION_KINDS)
  kind!: (typeof CORRECTION_KINDS)[number];

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    example: { grossWeightKg: 18650.5 },
    description: `Campo → valor nuevo; obligatorio en \`AMEND\`. ${CORRECTABLE_FIELDS_HELP}`,
  })
  @IsOptional()
  @IsObject()
  changes?: Record<string, unknown>;

  @ApiProperty({
    minLength: 10,
    maxLength: 500,
    example: 'La báscula estaba descalibrada; ticket reemitido',
  })
  @Transform(trim)
  @IsString()
  @Length(10, 500)
  reason!: string;
}

export class CreateTerroirCorrectionDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    example: { altitudeMasl: 2410 },
    description:
      'Campo → valor nuevo: `altitudeMasl`, `varietyName`, `rawMaterialType`',
  })
  @IsObject()
  changes!: Record<string, unknown>;

  @ApiProperty({
    minLength: 10,
    maxLength: 500,
    example: 'Altitud medida de nuevo con GPS diferencial',
  })
  @Transform(trim)
  @IsString()
  @Length(10, 500)
  reason!: string;
}

// ── Respuesta ──────────────────────────────────────────────────────────────

export class CorrectionChangeDto {
  @ApiProperty({ example: 'grossWeightKg' })
  field!: string;

  @ApiProperty({ ...JSON_VALUE_SCHEMA, example: 18700 })
  before!: unknown;

  @ApiProperty({ ...JSON_VALUE_SCHEMA, example: 18650.5 })
  after!: unknown;
}

export class CorrectionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: '`null` solo en correcciones de parcelas',
  })
  lotId!: string | null;

  @ApiProperty({ type: () => CorrectionTargetDto })
  target!: CorrectionTargetDto;

  @ApiProperty({ enum: CORRECTION_KINDS })
  kind!: (typeof CORRECTION_KINDS)[number];

  @ApiProperty({ type: () => CorrectionChangeDto, isArray: true })
  changes!: CorrectionChangeDto[];

  @ApiProperty({ minLength: 10, maxLength: 500 })
  reason!: string;

  @ApiProperty({ example: '2026-10-03T15:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ type: () => TraceActorDto })
  createdBy!: TraceActorDto;
}
