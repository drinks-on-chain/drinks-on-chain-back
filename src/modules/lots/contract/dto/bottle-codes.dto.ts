import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { TraceActorDto } from '@modules/lots/dto/lot.dto';
import { WineryScopedPaginationQueryDto } from '@shared/dto/pagination-query.dto';

export const BOTTLE_UNIT_STATUSES = ['ACTIVE', 'VOIDED'] as const;
export const BOTTLE_CODE_EXPORT_STATUSES = [
  'PENDING',
  'READY',
  'FAILED',
] as const;

// ── Código de botella (§7.1) ───────────────────────────────────────────────

export class BottleUnitVoidedDto {
  @ApiProperty({ example: '2026-10-05T12:00:00.000Z' })
  at!: string;

  @ApiProperty({
    type: () => TraceActorDto,
    nullable: true,
    description: '`null` = no registrado (membresía que ya no existe)',
  })
  by!: TraceActorDto | null;

  @ApiProperty({ example: 'Etiqueta dañada en la línea' })
  reason!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'P3R8T2W7',
    description: 'Código que lo sustituye (misma serie)',
  })
  replacedBy!: string | null;
}

export class BottleUnitDto {
  @ApiProperty({
    example: 'K7M2Q9XA',
    description: '8 caracteres Crockford (7 aleatorios + 1 de control)',
  })
  code!: string;

  @ApiProperty({ example: 'K7M2-Q9XA' })
  codeFormatted!: string;

  @ApiProperty({ type: 'integer', minimum: 1, example: 1234 })
  serial!: number;

  @ApiProperty({ format: 'uuid' })
  lotId!: string;

  @ApiProperty({ example: 'CVJ-2026-SINGANI-004' })
  lotCode!: string;

  @ApiProperty({
    enum: BOTTLE_UNIT_STATUSES,
    description: '`DELIVERED` llega en la Ola 5 (canje)',
  })
  status!: (typeof BOTTLE_UNIT_STATUSES)[number];

  @ApiProperty({ example: 'https://app.drinksonchain.com/b/K7M2Q9XA' })
  qrUrl!: string;

  @ApiProperty({ type: () => BottleUnitVoidedDto, nullable: true })
  voided!: BottleUnitVoidedDto | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Código anulado al que sustituye',
  })
  replaces!: string | null;

  @ApiProperty({ type: 'integer', minimum: 0, example: 1 })
  exportsCount!: number;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '2026-10-02T09:00:00.000Z',
  })
  firstExportedAt!: string | null;
}

// ── Consultas (§7.2) ───────────────────────────────────────────────────────

export class QueryBottleCodesDto extends WineryScopedPaginationQueryDto {
  @ApiPropertyOptional({ enum: BOTTLE_UNIT_STATUSES })
  @IsOptional()
  @IsIn(BOTTLE_UNIT_STATUSES)
  status?: (typeof BOTTLE_UNIT_STATUSES)[number];

  @ApiPropertyOptional({ type: 'integer', minimum: 1, example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  fromSerial?: number;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, example: 500 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  toSerial?: number;

  @ApiPropertyOptional({
    maxLength: 20,
    example: 'K7M2-Q9',
    description:
      'Busca por un fragmento del código (se normaliza: mayúsculas, sin espacios ni guiones, O → 0, I/L → 1) ' +
      'o por el número de serie exacto',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 20)
  q?: string;
}

export class ExportBottleCodesCsvQueryDto {
  @ApiPropertyOptional({ enum: ['csv'], default: 'csv' })
  @IsOptional()
  @IsIn(['csv'])
  format?: 'csv';

  @ApiPropertyOptional({ type: 'integer', minimum: 1, example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  fromSerial?: number;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, example: 2950 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  toSerial?: number;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Solo personal de plataforma: bodega de la petición. La plataforma no exporta códigos (403): ' +
      'solo los lista (contrato O2 §14)',
  })
  @IsOptional()
  @IsUUID('all', { message: 'wineryId debe ser un UUID' })
  wineryId?: string;
}

// ── Exportación ZIP (§7.2) ─────────────────────────────────────────────────

export class BottleCodeExportQrDto {
  @ApiProperty({ enum: ['SVG', 'PNG'] })
  @IsIn(['SVG', 'PNG'])
  imageFormat!: 'SVG' | 'PNG';

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 64,
    maximum: 4096,
    example: 512,
  })
  @IsOptional()
  @IsInt()
  @Min(64)
  @Max(4096)
  sizePx?: number;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 0,
    maximum: 16,
    example: 4,
    description: 'Margen en módulos del QR',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(16)
  margin?: number;
}

export class CreateBottleCodeExportDto {
  @ApiProperty({ enum: ['ZIP'] })
  @IsIn(['ZIP'])
  format!: 'ZIP';

  @ApiPropertyOptional({ type: 'integer', minimum: 1, example: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  fromSerial?: number;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, example: 2950 })
  @IsOptional()
  @IsInt()
  @Min(1)
  toSerial?: number;

  @ApiProperty({ type: () => BottleCodeExportQrDto })
  @ValidateNested()
  @Type(() => BottleCodeExportQrDto)
  qr!: BottleCodeExportQrDto;
}

export class BottleCodeExportAcceptedDto {
  @ApiProperty({ format: 'uuid' })
  exportId!: string;

  @ApiProperty({ enum: ['PENDING'] })
  status!: 'PENDING';
}

export class BottleCodeExportDto {
  @ApiProperty({ format: 'uuid' })
  exportId!: string;

  @ApiProperty({ enum: BOTTLE_CODE_EXPORT_STATUSES })
  status!: (typeof BOTTLE_CODE_EXPORT_STATUSES)[number];

  @ApiProperty({ enum: ['CSV', 'ZIP'] })
  format!: 'CSV' | 'ZIP';

  @ApiProperty({ type: 'integer', minimum: 1, example: 1 })
  fromSerial!: number;

  @ApiProperty({ type: 'integer', minimum: 1, example: 2950 })
  toSerial!: number;

  @ApiProperty({ type: 'integer', minimum: 0, example: 2950 })
  rows!: number;

  @ApiProperty({ example: '2026-10-02T09:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({
    type: () => TraceActorDto,
    nullable: true,
    description: '`null` = no registrado (membresía que ya no existe)',
  })
  createdBy!: TraceActorDto | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'URL firmada de 15 min del ZIP (solo `READY` y sin caducar; una exportación CSV se descarga al pedirla)',
  })
  downloadUrl!: string | null;

  @ApiProperty({
    example: '2026-10-09T09:00:00.000Z',
    description: 'Caducidad del ZIP (7 días)',
  })
  expiresAt!: string;
}

// ── Anulación (§7.2) ───────────────────────────────────────────────────────

export class VoidBottleCodeDto {
  @ApiProperty({ minLength: 3, maxLength: 500, example: 'Etiqueta dañada' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(3, 500)
  reason!: string;

  @ApiPropertyOptional({
    default: false,
    description:
      '`true` emite un código nuevo con la misma serie (no admitido con el expediente cerrado, S-14)',
  })
  @IsOptional()
  @IsBoolean()
  replace?: boolean;
}
