import { ApiProperty } from '@nestjs/swagger';
import { Equals } from 'class-validator';
import { TraceActorDto } from '@modules/lots/dto/lot.dto';

/** Requisitos del cierre del expediente (contrato O2 §10). */
export const DOSSIER_REQUIREMENT_KEYS = [
  'BOTTLED',
  'LAB_CONFORMING',
  'BOTTLE_CODES_READY',
  'NO_OPEN_COMPLIANCE_ISSUES',
  'NO_OPEN_SOURCES',
] as const;

export class DossierRequirementDto {
  @ApiProperty({ enum: DOSSIER_REQUIREMENT_KEYS })
  key!: (typeof DOSSIER_REQUIREMENT_KEYS)[number];

  @ApiProperty()
  met!: boolean;

  @ApiProperty({ example: 'El análisis de laboratorio vigente es conforme' })
  message!: string;
}

export class DossierPreviewDto {
  @ApiProperty({ description: '`true` si se cumplen todos los requisitos' })
  ready!: boolean;

  @ApiProperty({ type: () => DossierRequirementDto, isArray: true })
  requirements!: DossierRequirementDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'a1b2c3d4e5f6…',
    description: 'SHA-256 hex del contenido canónico si se cerrara ahora',
  })
  hashPreview!: string | null;
}

export class CloseDossierDto {
  @ApiProperty({ type: Boolean, enum: [true], example: true })
  @Equals(true, { message: 'confirm debe ser true' })
  confirm!: true;
}

export class DossierBottleCodesDto {
  @ApiProperty({ type: 'integer', minimum: 0, example: 2950 })
  count!: number;

  @ApiProperty({
    example: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    description:
      'Raíz Merkle de las hojas `SHA-256("{serie}:{código}:{sal}")` ordenadas por serie',
  })
  merkleRoot!: string;

  @ApiProperty({ enum: ['sha256-merkle/serial-code-salt'] })
  algorithm!: 'sha256-merkle/serial-code-salt';
}

export class LotDossierDto {
  @ApiProperty({ format: 'uuid' })
  lotId!: string;

  @ApiProperty({ enum: ['doc-dossier/1'] })
  schema!: 'doc-dossier/1';

  @ApiProperty({ enum: ['OPEN', 'CLOSED'] })
  status!: 'OPEN' | 'CLOSED';

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'SHA-256 hex de los bytes canónicos',
  })
  hash!: string | null;

  @ApiProperty({ enum: ['sha256/jcs-rfc8785'] })
  algorithm!: 'sha256/jcs-rfc8785';

  @ApiProperty({ type: String, nullable: true })
  closedAt!: string | null;

  @ApiProperty({ type: () => TraceActorDto, nullable: true })
  closedBy!: TraceActorDto | null;

  @ApiProperty({ type: () => DossierBottleCodesDto, nullable: true })
  bottleCodes!: DossierBottleCodesDto | null;

  @ApiProperty({
    type: 'object',
    nullable: true,
    properties: {},
    additionalProperties: false,
    description:
      'Siempre `null` en esta ola; Ola 3: `{ network, txHash, anchoredAt, explorerUrl }`',
  })
  anchor!: null;
}

/** Esquema del contenido canónico `doc-dossier/1` (objeto JSON libre). */
export const CANONICAL_DOSSIER_SCHEMA = {
  type: 'object' as const,
  additionalProperties: true,
  description:
    'JSON canónico RFC 8785 (JCS), UTF-8, `schema: doc-dossier/1`: bodega, lote, instantánea de reglas, ' +
    'parcelas tal como estaban en cada pesaje, pesajes, análisis, dictámenes, tanques, crianzas o destilaciones, ' +
    'embotellado con su balance, laboratorio con su conformidad, correcciones, adjuntos por `{ kind, sha256 }`, ' +
    'raíz Merkle de los códigos y `closedAt`. Decimales como cadenas de escala fija; actores como ' +
    '`{ role, membershipId }`. Hash = SHA-256 de estos bytes exactos.',
};
