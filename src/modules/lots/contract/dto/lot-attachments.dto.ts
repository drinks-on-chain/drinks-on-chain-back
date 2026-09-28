import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { TraceActorDto } from '@modules/lots/dto/lot.dto';

/** Tipos de archivo del lote (contrato O2 §11.5). */
export const LOT_ATTACHMENT_KINDS = [
  'LAB_REPORT',
  'PHYTO_REPORT',
  'LABEL',
  'DO_CERTIFICATE',
  'PHOTO',
  'OTHER',
] as const;
export const LOT_ATTACHMENT_VISIBILITIES = ['PRIVATE', 'PUBLIC'] as const;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateLotAttachmentDto {
  @ApiProperty({
    example: 'uploads/2026/10/etiqueta.png',
    description:
      '`key` de `POST /v1/uploads`; inexistente o de otra organización → 422 `TRC_FILE_NOT_FOUND`',
  })
  @IsString()
  @MaxLength(500)
  key!: string;

  @ApiProperty({ enum: LOT_ATTACHMENT_KINDS })
  @IsIn(LOT_ATTACHMENT_KINDS)
  kind!: (typeof LOT_ATTACHMENT_KINDS)[number];

  @ApiProperty({ minLength: 1, maxLength: 200, example: 'Etiqueta frontal' })
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  title!: string;

  @ApiPropertyOptional({
    enum: LOT_ATTACHMENT_VISIBILITIES,
    description: 'Por defecto `PRIVATE`; `LABEL` nace `PUBLIC` (S-20)',
  })
  @IsOptional()
  @IsIn(LOT_ATTACHMENT_VISIBILITIES)
  visibility?: (typeof LOT_ATTACHMENT_VISIBILITIES)[number];
}

export class ChangeLotAttachmentVisibilityDto {
  @ApiProperty({ enum: LOT_ATTACHMENT_VISIBILITIES })
  @IsIn(LOT_ATTACHMENT_VISIBILITIES)
  visibility!: (typeof LOT_ATTACHMENT_VISIBILITIES)[number];
}

export class LotAttachmentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: LOT_ATTACHMENT_KINDS })
  kind!: (typeof LOT_ATTACHMENT_KINDS)[number];

  @ApiProperty({ example: 'Etiqueta frontal' })
  title!: string;

  @ApiProperty({ example: 'uploads/2026/10/etiqueta.png' })
  key!: string;

  @ApiProperty({ example: 'image/png' })
  mimeType!: string;

  @ApiProperty({ type: 'integer', minimum: 0, example: 184320 })
  sizeBytes!: number;

  @ApiProperty({
    example: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
  })
  sha256!: string;

  @ApiProperty({ enum: LOT_ATTACHMENT_VISIBILITIES })
  visibility!: (typeof LOT_ATTACHMENT_VISIBILITIES)[number];

  @ApiProperty({ description: 'URL firmada de 15 min' })
  url!: string;

  @ApiProperty({ example: '2026-10-02T09:15:00.000Z' })
  urlExpiresAt!: string;

  @ApiProperty({ example: '2026-10-02T09:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ type: () => TraceActorDto })
  createdBy!: TraceActorDto;
}
