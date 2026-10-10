import { ApiProperty } from '@nestjs/swagger';
import {
  LOT_PRODUCT_TYPES,
  LabLimitDto,
  WINERY_ROLES,
} from '@modules/lots/dto/lot.dto';
import { JSON_VALUE_SCHEMA } from '@shared/dto/json-value.schema';
import { PublicDossierAnchorDto } from '@modules/chain/dto/chain-common.dto';
import { LOT_EVENT_TYPES, type LotEventType } from './lot-views.dto';

/** Estado de un apartado del pasaporte (contrato O2 §12.2). */
export const RECORD_STATUSES = [
  'RECORDED',
  'NOT_RECORDED',
  'NOT_APPLICABLE',
  'PENDING',
] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];

const DO_STATUSES = [
  'ELIGIBLE',
  'ELIGIBLE_BY_EXCEPTION',
  'NOT_ELIGIBLE',
  'NOT_APPLICABLE',
] as const;
type DoStatus = (typeof DO_STATUSES)[number];

const RECORD_STATUS_PROP = {
  enum: RECORD_STATUSES,
  description:
    '`NOT_RECORDED`: la etapa aplica pero no hay datos (el visor escribe "No registrado")',
} as const;

// ── Conformidad del laboratorio (§8.3) ─────────────────────────────────────

/** Un parámetro de `LabConformity.checks` (§8.3). */
export class LabConformityCheckDto {
  @ApiProperty({
    example: 'metanol',
    description: 'Clave del límite: metanol, cobre, acidezVolatil, grado…',
  })
  parameter!: string;

  @ApiProperty({ type: Number, nullable: true, example: 48 })
  value!: number | null;

  @ApiProperty({ example: 'mg/100 ml a.a.' })
  unit!: string;

  @ApiProperty({ type: () => LabLimitDto, nullable: true })
  limit!: LabLimitDto | null;

  @ApiProperty({ enum: ['PASS', 'FAIL', 'MISSING', 'UNIT_UNKNOWN'] })
  result!: 'PASS' | 'FAIL' | 'MISSING' | 'UNIT_UNKNOWN';
}

// ── Pasaporte de lote (§12.2) ──────────────────────────────────────────────

export class PublicPassportWineryDto {
  @ApiProperty({ example: 'destileria-cinti-viejo' })
  slug!: string;

  @ApiProperty({ example: 'Destilería Cinti Viejo' })
  tradeName!: string;

  @ApiProperty({ example: 'Valle de Cinti' })
  region!: string;

  @ApiProperty({ type: String, nullable: true })
  logoUrl!: string | null;

  @ApiProperty({ type: String, nullable: true })
  website!: string | null;

  @ApiProperty({
    description:
      '`false` si la bodega está suspendida o revocada; el pasaporte sigue visible (S-23)',
  })
  active!: boolean;
}

export class PublicDenominationRulesDto {
  @ApiProperty({ example: 1600 })
  minAltitudeMasl!: number;

  @ApiProperty({
    type: String,
    isArray: true,
    example: ['Moscatel de Alejandría'],
  })
  requiredVarieties!: string[];
}

export class PublicDenominationDto {
  @ApiProperty({ description: '`false` en vino' })
  applies!: boolean;

  @ApiProperty({ enum: DO_STATUSES })
  status!: DoStatus;

  @ApiProperty({ type: () => PublicDenominationRulesDto, nullable: true })
  rules!: PublicDenominationRulesDto | null;

  @ApiProperty({
    description: 'Cumple por un valor bajo el mínimo legal autorizado (A-31)',
  })
  legalException!: boolean;
}

export class PublicOriginTerroirDto {
  @ApiProperty({ example: 'Parcela Cinti 02' })
  parcelName!: string;

  @ApiProperty({ example: 'Valle de Cinti' })
  region!: string;

  @ApiProperty({ example: 2350 })
  altitudeMasl!: number;

  @ApiProperty({ example: 'Moscatel de Alejandría' })
  variety!: string;

  @ApiProperty({ enum: DO_STATUSES })
  doStatus!: DoStatus;
}

export class PublicOriginDto {
  @ApiProperty(RECORD_STATUS_PROP)
  status!: RecordStatus;

  @ApiProperty({ type: () => PublicOriginTerroirDto, isArray: true })
  terroirs!: PublicOriginTerroirDto[];
}

export class PublicMaturityDto {
  @ApiProperty({ example: 23.4 })
  brixDegrees!: number;

  @ApiProperty({ example: 3.4 })
  ph!: number;

  @ApiProperty({ example: 5.2 })
  acidityGl!: number;
}

export class PublicHarvestDto {
  @ApiProperty(RECORD_STATUS_PROP)
  status!: RecordStatus;

  @ApiProperty({ type: String, nullable: true, example: '2026-03-12' })
  firstIntakeDate!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '2026-03-12' })
  lastIntakeDate!: string | null;

  @ApiProperty({ enum: ['APPROVED', 'NOT_RECORDED'] })
  phytosanitary!: 'APPROVED' | 'NOT_RECORDED';

  @ApiProperty({ type: () => PublicMaturityDto, nullable: true })
  maturity!: PublicMaturityDto | null;
}

export class PublicTreatmentDto {
  @ApiProperty({ example: 'SULFITADO' })
  type!: string;

  @ApiProperty({ example: 'Metabisulfito de potasio' })
  additive!: string;

  @ApiProperty({ example: 'SENASAG-AUT-2026-118' })
  regulatoryAuthCode!: string;

  @ApiProperty({ example: '2026-03-14T08:00:00.000Z' })
  appliedAt!: string;
}

export class PublicFermentationDto {
  @ApiProperty(RECORD_STATUS_PROP)
  status!: RecordStatus;

  @ApiProperty({ type: String, nullable: true })
  startDate!: string | null;

  @ApiProperty({ type: String, nullable: true })
  endDate!: string | null;

  @ApiProperty({ type: 'integer', minimum: 0, example: 14 })
  readingsCount!: number;

  @ApiProperty({
    type: () => PublicTreatmentDto,
    isArray: true,
    description: 'Sin dosis (S-22)',
  })
  treatments!: PublicTreatmentDto[];
}

export class PublicAgingDto {
  @ApiProperty(RECORD_STATUS_PROP)
  status!: RecordStatus;

  @ApiProperty({ type: String, nullable: true, example: 'BARRICA' })
  containerType!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Roble francés' })
  containerMaterial!: string | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 12 })
  plannedMonths!: number | null;

  @ApiProperty({ type: String, nullable: true })
  startDate!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '2027-04-01' })
  unlockDate!: string | null;
}

export class PublicDistillationDto {
  @ApiProperty(RECORD_STATUS_PROP)
  status!: RecordStatus;

  @ApiProperty({ type: String, nullable: true })
  startDate!: string | null;

  @ApiProperty({ type: String, nullable: true })
  endDate!: string | null;

  @ApiProperty({ type: Number, nullable: true, example: 60 })
  heartAbvPercent!: number | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 180 })
  restMinDays!: number | null;

  @ApiProperty({ type: String, nullable: true, example: '2026-10-07' })
  restUntil!: string | null;
}

export class PublicBottlingDto {
  @ApiProperty(RECORD_STATUS_PROP)
  status!: RecordStatus;

  @ApiProperty({ type: String, nullable: true, example: '2026-10-01' })
  date!: string | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 2950 })
  bottles!: number | null;

  @ApiProperty({ type: 'integer', nullable: true, example: 75 })
  formatCl!: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 40 })
  finalAbv!: number | null;
}

export class PublicLabDto {
  @ApiProperty({
    enum: ['CONFORMING', 'NON_CONFORMING', 'INCOMPLETE', 'NOT_RECORDED'],
  })
  status!: 'CONFORMING' | 'NON_CONFORMING' | 'INCOMPLETE' | 'NOT_RECORDED';

  @ApiProperty({ type: String, nullable: true })
  laboratoryName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  testedAt!: string | null;

  @ApiProperty({ type: () => LabConformityCheckDto, isArray: true })
  checks!: LabConformityCheckDto[];
}

export class PublicRuleItemDto {
  @ApiProperty({ example: 'trazabilidad.singani.reposoMinimoDias' })
  key!: string;

  @ApiProperty({ example: 'Reposo mínimo' })
  label!: string;

  @ApiProperty({ ...JSON_VALUE_SCHEMA, example: 180 })
  value!: unknown;

  @ApiProperty({ type: String, nullable: true, example: 'días' })
  unit!: string | null;

  @ApiProperty()
  legalException!: boolean;
}

export class PublicRulesDto {
  @ApiProperty({ example: '2026-01-15T12:00:00.000Z' })
  takenAt!: string;

  @ApiProperty({
    enum: ['LOT_CREATION', 'MIGRATION'],
    description: '`MIGRATION`: "reglas fijadas al migrar"',
  })
  origin!: 'LOT_CREATION' | 'MIGRATION';

  @ApiProperty({ type: () => PublicRuleItemDto, isArray: true })
  items!: PublicRuleItemDto[];
}

export class PublicTimelineEventDto {
  @ApiProperty({ enum: LOT_EVENT_TYPES })
  type!: LotEventType;

  @ApiProperty()
  occurredAt!: string;

  @ApiProperty()
  recordedAt!: string;

  @ApiProperty()
  lateEntry!: boolean;

  @ApiProperty({ example: 'Destilación cerrada' })
  summary!: string;

  @ApiProperty({
    enum: WINERY_ROLES,
    nullable: true,
    description: 'Solo el rol, nunca el nombre (S-21); `null` = sistema',
  })
  actorRole!: (typeof WINERY_ROLES)[number] | null;

  @ApiProperty()
  corrected!: boolean;
}

export class PublicCorrectionsSummaryDto {
  @ApiProperty({ type: 'integer', minimum: 0 })
  count!: number;

  @ApiProperty({ type: String, nullable: true })
  lastAt!: string | null;
}

export class PublicDossierDto {
  @ApiProperty({ enum: ['OPEN', 'CLOSED'] })
  status!: 'OPEN' | 'CLOSED';

  @ApiProperty({ type: String, nullable: true })
  hash!: string | null;

  @ApiProperty({ type: String, nullable: true })
  closedAt!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example:
      'https://api.drinksonchain.com/v1/public/lots/CVJ-2026-SINGANI-004/dossier',
  })
  canonicalUrl!: string | null;

  @ApiProperty({
    type: () => PublicDossierAnchorDto,
    nullable: true,
    description:
      'Anclaje del hash en la red (contrato O3 §7.3). `null` hasta que el lote certificado tenga su ' +
      'transacción de anclaje (paso 3.5); `FAILED` se publica como `PENDING`',
  })
  anchor!: PublicDossierAnchorDto | null;
}

export class PublicAttachmentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'LABEL' })
  kind!: string;

  @ApiProperty({ example: 'Etiqueta frontal' })
  title!: string;

  @ApiProperty({
    description:
      '`/v1/public/lots/{lotCode}/attachments/{id}` (redirige a una URL firmada)',
  })
  url!: string;
}

export class PublicLotPassportDto {
  @ApiProperty({ enum: ['LOT'] })
  kind!: 'LOT';

  @ApiProperty({ example: 'CVJ-2026-SINGANI-004' })
  lotCode!: string;

  @ApiProperty({ example: 'Singani Gran Reserva 2026' })
  name!: string;

  @ApiProperty({ enum: LOT_PRODUCT_TYPES })
  productType!: (typeof LOT_PRODUCT_TYPES)[number];

  @ApiProperty({ type: 'integer', example: 2026 })
  vintage!: number;

  @ApiProperty({ enum: ['BOTTLED', 'CERTIFIED', 'ANCHORED', 'DISCARDED'] })
  stage!: 'BOTTLED' | 'CERTIFIED' | 'ANCHORED' | 'DISCARDED';

  @ApiProperty({ type: () => PublicPassportWineryDto })
  winery!: PublicPassportWineryDto;

  @ApiProperty({ type: () => PublicDenominationDto })
  denomination!: PublicDenominationDto;

  @ApiProperty({ type: () => PublicOriginDto })
  origin!: PublicOriginDto;

  @ApiProperty({ type: () => PublicHarvestDto })
  harvest!: PublicHarvestDto;

  @ApiProperty({ type: () => PublicFermentationDto })
  fermentation!: PublicFermentationDto;

  @ApiProperty({ type: () => PublicAgingDto })
  aging!: PublicAgingDto;

  @ApiProperty({ type: () => PublicDistillationDto })
  distillation!: PublicDistillationDto;

  @ApiProperty({ type: () => PublicBottlingDto })
  bottling!: PublicBottlingDto;

  @ApiProperty({ type: () => PublicLabDto })
  lab!: PublicLabDto;

  @ApiProperty({ type: () => PublicRulesDto })
  rules!: PublicRulesDto;

  @ApiProperty({
    type: () => PublicTimelineEventDto,
    isArray: true,
    description: 'Solo eventos `PUBLIC`',
  })
  timeline!: PublicTimelineEventDto[];

  @ApiProperty({ type: () => PublicCorrectionsSummaryDto })
  corrections!: PublicCorrectionsSummaryDto;

  @ApiProperty({ type: () => PublicDossierDto })
  dossier!: PublicDossierDto;

  @ApiProperty({ type: () => PublicAttachmentDto, isArray: true })
  publicAttachments!: PublicAttachmentDto[];

  @ApiProperty({ example: '2026-10-05T12:00:00.000Z' })
  generatedAt!: string;
}

// ── Pasaporte de botella (§12.2) ───────────────────────────────────────────

export class PublicMerkleStepDto {
  @ApiProperty({ enum: ['L', 'R'] })
  side!: 'L' | 'R';

  @ApiProperty({ description: 'SHA-256 hex del nodo hermano' })
  hash!: string;
}

export class PublicMerkleProofDto {
  @ApiProperty({ description: 'Sal de 16 bytes de la hoja (hex)' })
  salt!: string;

  @ApiProperty({ type: () => PublicMerkleStepDto, isArray: true })
  path!: PublicMerkleStepDto[];
}

export class PublicBottleDto {
  @ApiProperty({ example: 'K7M2Q9XA' })
  code!: string;

  @ApiProperty({ example: 'K7M2-Q9XA' })
  codeFormatted!: string;

  @ApiProperty({ type: 'integer', minimum: 1, example: 1234 })
  serial!: number;

  @ApiProperty({ type: 'integer', minimum: 1, example: 2950 })
  lotTotal!: number;

  @ApiProperty({
    enum: ['ACTIVE', 'VOIDED'],
    description: '`VOIDED`: el visor avisa "código anulado"',
  })
  status!: 'ACTIVE' | 'VOIDED';

  @ApiProperty({
    type: () => PublicMerkleProofDto,
    nullable: true,
    description: '`null` hasta cerrar el expediente',
  })
  merkleProof!: PublicMerkleProofDto | null;
}

export class PublicBottlePassportDto {
  @ApiProperty({ enum: ['BOTTLE'] })
  kind!: 'BOTTLE';

  @ApiProperty({ type: () => PublicBottleDto })
  bottle!: PublicBottleDto;

  @ApiProperty({ type: () => PublicLotPassportDto })
  lot!: PublicLotPassportDto;

  @ApiProperty({
    type: 'object',
    nullable: true,
    properties: {},
    additionalProperties: false,
    description: 'Siempre `null` en esta ola (canje: Ola 5, PUB-04)',
  })
  redemption!: null;
}
