import {
  ApiExtraModels,
  ApiProperty,
  ApiPropertyOptional,
  getSchemaPath,
} from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  Equals,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ErrorDetailDto } from '@shared/dto/api-error-response.dto';
import {
  PaginationQueryDto,
  WineryScopedPaginationQueryDto,
} from '@shared/dto/pagination-query.dto';
import {
  OptionalReasonProperty,
  ReasonProperty,
} from '@shared/audit/requires-reason';
import { NullableFields } from '@shared/pipes/optional-nulls';
import {
  DoEvaluationDto,
  LOT_PRODUCT_TYPES,
  LOT_STAGES,
  LotDto,
  LotLockDto,
  TraceActorDto,
} from '@modules/lots/dto/lot.dto';
import { LotEventDto } from '@modules/lots/contract/dto/lot-views.dto';
import {
  CHAIN_IDENTITY_STATUSES,
  type ChainIdentityStatus,
} from '@modules/chain/chain.constants';
import { WineryChainIdentityDto } from '@modules/chain/dto/chain.dto';
import {
  TOKENIZATION_LIMIT_BASES,
  TOKENIZATION_REQUEST_KINDS,
  TOKENIZATION_REQUEST_STATUSES,
  type TokenizationLimitBasis,
  type TokenizationRequestKind,
  type TokenizationRequestStatus,
} from '../tokenization.constants';
import {
  CollectionCommercialDraftDto,
  CollectionCommercialInputDto,
  CollectionPriceDto,
  CollectionPriceInputDto,
  PriceSuggestionAvailableDto,
  PriceSuggestionUnavailableDto,
  UserRefDto,
  type PriceSuggestionDto,
} from './commercial.dto';
import {
  CollectionDto,
  CollectionSummaryDto,
  MintDto,
  WineryRefDto,
} from './collections.dto';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const PRICE_SUGGESTION_SCHEMA = {
  oneOf: [
    { $ref: getSchemaPath(PriceSuggestionUnavailableDto) },
    { $ref: getSchemaPath(PriceSuggestionAvailableDto) },
  ],
};

// ── Tipos (§5.1) ───────────────────────────────────────────────────────────

export class TokenizationLimitsDto {
  @ApiProperty({
    enum: TOKENIZATION_LIMIT_BASES,
    enumName: 'TokenizationLimitBasis',
    description: '`BOTTLES` desde el embotellado (R6)',
  })
  basis!: TokenizationLimitBasis;

  @ApiProperty({ type: 'integer', nullable: true, example: 3000 })
  estimatedBottles!: number | null;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    description: 'Códigos de botella `ACTIVE`',
  })
  bottles!: number | null;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: 'Cuota aprobada vigente (0 sin colección)',
  })
  authorizedQuota!: number;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: 'Pedida en una solicitud abierta',
  })
  pendingQuantity!: number;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: 'Lo que aún se puede pedir = límite − autorizada − pendiente',
  })
  maxQuantity!: number;
}

export class TokenizationRequestLotDto {
  @ApiProperty({ example: 'CVJ-L2026-004' })
  reference!: string;

  @ApiProperty({ type: String, nullable: true })
  lotCode!: string | null;

  @ApiProperty({ example: 'Singani Preventa 2026' })
  name!: string;

  @ApiProperty({
    enum: LOT_PRODUCT_TYPES,
    enumName: 'LotProductType',
    nullable: true,
  })
  productType!: (typeof LOT_PRODUCT_TYPES)[number] | null;

  @ApiProperty({ enum: LOT_STAGES, enumName: 'LotStage' })
  stage!: (typeof LOT_STAGES)[number];

  @ApiProperty({ type: 'integer', example: 2026 })
  harvestYear!: number;

  @ApiProperty({ type: 'integer', nullable: true })
  estimatedBottles!: number | null;

  @ApiProperty({ type: 'integer', nullable: true })
  bottles!: number | null;
}

export class TokenizationRequestSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  wineryId!: string;

  @ApiProperty({ type: () => WineryRefDto })
  winery!: WineryRefDto;

  @ApiProperty({ format: 'uuid' })
  lotId!: string;

  @ApiProperty({ type: () => TokenizationRequestLotDto })
  lot!: TokenizationRequestLotDto;

  @ApiProperty({
    enum: TOKENIZATION_REQUEST_KINDS,
    enumName: 'TokenizationRequestKind',
    description:
      'Lo deduce el servidor: sin colección, `INITIAL`; con colección, `QUOTA_INCREASE`',
  })
  kind!: TokenizationRequestKind;

  @ApiProperty({
    enum: TOKENIZATION_REQUEST_STATUSES,
    enumName: 'TokenizationRequestStatus',
  })
  status!: TokenizationRequestStatus;

  @ApiProperty({
    type: 'integer',
    minimum: 1,
    description: '`INITIAL`: cuota; `QUOTA_INCREASE`: botellas adicionales',
  })
  quantity!: number;

  @ApiProperty({
    type: 'integer',
    minimum: 1,
    description: 'Cuota total si se aprueba',
  })
  resultingQuota!: number;

  @ApiProperty({
    description: 'Valor de `tokenizacion.requiereAprobacion` al enviar (§5.6)',
  })
  requiresApproval!: boolean;

  @ApiProperty({ type: () => UserRefDto, nullable: true })
  assignee!: UserRefDto | null;

  @ApiProperty({ format: 'date-time' })
  submittedAt!: string;

  @ApiProperty({ type: () => TraceActorDto })
  submittedBy!: TraceActorDto;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  collectionId!: string | null;
}

export class TokenizationChangeRequestDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'date-time' })
  at!: string;

  @ApiProperty({ type: () => UserRefDto })
  by!: UserRefDto;

  @ApiProperty({ example: 'Falta la nota de cata' })
  message!: string;

  @ApiProperty({
    type: String,
    isArray: true,
    example: ['commercial.tastingNotes'],
    description: 'Campos a revisar',
  })
  fields!: string[];

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  resolvedAt!: string | null;
}

export class TokenizationDecisionByDto {
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  userId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  fullName!: string | null;

  @ApiProperty({
    description: '`true` si se autoaprobó (`requiresApproval = false`, S-11)',
  })
  system!: boolean;
}

export class TokenizationDecisionDto {
  @ApiProperty({ enum: ['APPROVED', 'REJECTED'] })
  outcome!: 'APPROVED' | 'REJECTED';

  @ApiProperty({ format: 'date-time' })
  at!: string;

  @ApiProperty({ type: String, nullable: true })
  reason!: string | null;

  @ApiProperty({ type: () => TokenizationDecisionByDto })
  by!: TokenizationDecisionByDto;
}

export class TokenizationWithdrawnDto {
  @ApiProperty({ format: 'date-time' })
  at!: string;

  @ApiProperty({ type: () => TraceActorDto })
  by!: TraceActorDto;

  @ApiProperty()
  reason!: string;
}

export class TokenizationHistoryEntryDto {
  @ApiProperty({
    enum: TOKENIZATION_REQUEST_STATUSES,
    enumName: 'TokenizationRequestStatus',
  })
  status!: TokenizationRequestStatus;

  @ApiProperty({ format: 'date-time' })
  at!: string;

  @ApiProperty({ example: 'Lic. Valeria Soliz' })
  by!: string;

  @ApiProperty({ type: String, nullable: true })
  note!: string | null;
}

export class TokenizationInternalNoteDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  text!: string;

  @ApiProperty({ example: 'Lic. Marcos Vaca' })
  by!: string;

  @ApiProperty({ format: 'date-time' })
  at!: string;
}

/** Solicitud como la ve la bodega (sin notas internas ni sugerencia de precio). */
export class TokenizationRequestDto extends TokenizationRequestSummaryDto {
  @ApiProperty({
    type: () => CollectionCommercialDraftDto,
    description: 'Lo que envía la bodega y completa operaciones (§5.5)',
  })
  commercialDraft!: CollectionCommercialDraftDto;

  @ApiProperty({
    type: () => CollectionPriceDto,
    nullable: true,
    description: 'La bodega lo ve en solo lectura tras aprobarse',
  })
  price!: CollectionPriceDto | null;

  @ApiProperty({ type: String, nullable: true })
  wineryNotes!: string | null;

  @ApiProperty({ type: () => TokenizationChangeRequestDto, isArray: true })
  changeRequests!: TokenizationChangeRequestDto[];

  @ApiProperty({ type: () => TokenizationDecisionDto, nullable: true })
  decision!: TokenizationDecisionDto | null;

  @ApiProperty({ type: () => TokenizationWithdrawnDto, nullable: true })
  withdrawn!: TokenizationWithdrawnDto | null;

  @ApiProperty({ type: () => TokenizationLimitsDto })
  limitsAtSubmission!: TokenizationLimitsDto;

  @ApiProperty({ type: () => TokenizationHistoryEntryDto, isArray: true })
  history!: TokenizationHistoryEntryDto[];
}

// ── Revisión del back office (§5.4) ────────────────────────────────────────

export class TokenizationReviewTraceabilityDto {
  @ApiProperty({ type: 'integer', minimum: 0 })
  publicEventsCount!: number;

  @ApiProperty({ type: () => LotEventDto, nullable: true })
  lastEvent!: LotEventDto | null;

  @ApiProperty({ type: () => LotLockDto, isArray: true })
  locks!: LotLockDto[];

  @ApiProperty({ type: String, nullable: true, format: 'date' })
  estimatedReadyDate!: string | null;

  @ApiProperty({ type: 'integer', minimum: 0 })
  complianceIssuesOpen!: number;

  @ApiProperty({ type: () => DoEvaluationDto })
  denomination!: DoEvaluationDto;

  @ApiProperty({ enum: ['OPEN', 'CLOSED'] })
  dossierStatus!: 'OPEN' | 'CLOSED';
}

/** Lo que operaciones revisa antes de aprobar (docs-back/07 §6.2). */
@ApiExtraModels(PriceSuggestionUnavailableDto, PriceSuggestionAvailableDto)
export class TokenizationReviewDto {
  @ApiProperty({ type: () => LotDto, description: 'Lectura de plataforma' })
  lot!: LotDto;

  @ApiProperty({ type: () => TokenizationReviewTraceabilityDto })
  traceability!: TokenizationReviewTraceabilityDto;

  @ApiProperty({
    type: () => TokenizationLimitsDto,
    description: 'Recalculados ahora',
  })
  limits!: TokenizationLimitsDto;

  @ApiProperty({ type: () => WineryChainIdentityDto })
  chainIdentity!: WineryChainIdentityDto;

  @ApiProperty(PRICE_SUGGESTION_SCHEMA)
  priceSuggestion!: PriceSuggestionDto;

  @ApiProperty({ type: () => CollectionSummaryDto, isArray: true })
  otherCollectionsOfWinery!: CollectionSummaryDto[];
}

/** Solicitud como la ve el back office: con notas, sugerencia y revisión. */
@ApiExtraModels(PriceSuggestionUnavailableDto, PriceSuggestionAvailableDto)
export class PlatformTokenizationRequestDto extends TokenizationRequestDto {
  @ApiProperty({ type: () => TokenizationInternalNoteDto, isArray: true })
  internalNotes!: TokenizationInternalNoteDto[];

  @ApiProperty(PRICE_SUGGESTION_SCHEMA)
  priceSuggestion!: PriceSuggestionDto;

  @ApiProperty({ type: () => TokenizationReviewDto })
  review!: TokenizationReviewDto;
}

/** `201` de aprobar: la solicitud, su colección y la emisión creada. */
export class TokenizationApprovalDto {
  @ApiProperty({ type: () => PlatformTokenizationRequestDto })
  request!: PlatformTokenizationRequestDto;

  @ApiProperty({ type: () => CollectionDto })
  collection!: CollectionDto;

  @ApiProperty({ type: () => MintDto })
  mint!: MintDto;
}

// ── Estado de tokenización del lote (§5.3) ─────────────────────────────────

export class LotChainIdentityStatusDto {
  @ApiProperty({
    enum: CHAIN_IDENTITY_STATUSES,
    enumName: 'ChainIdentityStatus',
  })
  status!: ChainIdentityStatus;
}

export class LotTokenizationStatusDto {
  @ApiProperty({ format: 'uuid' })
  lotId!: string;

  @ApiProperty({ description: 'Puede enviar una solicitud ahora' })
  tokenizable!: boolean;

  @ApiProperty({
    type: () => ErrorDetailDto,
    isArray: true,
    description: 'Con `code` `TOK_…` y `message` listo para mostrar',
  })
  blockers!: ErrorDetailDto[];

  @ApiProperty({ type: () => TokenizationLimitsDto })
  limits!: TokenizationLimitsDto;

  @ApiProperty({
    description: 'Valor efectivo actual de `tokenizacion.requiereAprobacion`',
  })
  approvalRequired!: boolean;

  @ApiProperty({ type: () => LotChainIdentityStatusDto })
  chainIdentity!: LotChainIdentityStatusDto;

  @ApiProperty({ type: () => TokenizationRequestSummaryDto, nullable: true })
  openRequest!: TokenizationRequestSummaryDto | null;

  @ApiProperty({ type: () => CollectionSummaryDto, nullable: true })
  collection!: CollectionSummaryDto | null;

  @ApiProperty({
    type: () => TokenizationRequestSummaryDto,
    isArray: true,
    description: 'Historial del lote',
  })
  requests!: TokenizationRequestSummaryDto[];
}

// ── Entradas del ERP (§5.3) ────────────────────────────────────────────────

/** `POST /v1/lots/{id}/tokenization-requests`. */
export class CreateTokenizationRequestDto {
  @ApiProperty({
    type: 'integer',
    minimum: 1,
    example: 100,
    description:
      'Botellas a autorizar (la cuota si no hay colección; las adicionales si la hay)',
  })
  @IsInt({ message: 'quantity debe ser un entero' })
  @Min(1, { message: 'quantity debe ser al menos 1' })
  quantity!: number;

  @ApiPropertyOptional({ type: () => CollectionCommercialInputDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CollectionCommercialInputDto)
  commercial?: CollectionCommercialInputDto;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @Transform(trim)
  @IsString({ message: 'notes debe ser un texto' })
  @MaxLength(2000)
  notes?: string;

  @ApiProperty({
    type: Boolean,
    enum: [true],
    example: true,
    description:
      'Confirmación explícita: se emitirán NFT a nombre de la bodega cuando se apruebe',
  })
  @Equals(true, { message: 'confirm debe ser true' })
  confirm!: true;
}

/** `PATCH /v1/tokenization-requests/{id}` (bodega). */
export class UpdateTokenizationRequestDto {
  @ApiPropertyOptional({ type: 'integer', minimum: 1 })
  @IsOptional()
  @IsInt({ message: 'quantity debe ser un entero' })
  @Min(1, { message: 'quantity debe ser al menos 1' })
  quantity?: number;

  @ApiPropertyOptional({ type: () => CollectionCommercialInputDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CollectionCommercialInputDto)
  commercial?: CollectionCommercialInputDto;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @Transform(trim)
  @IsString({ message: 'notes debe ser un texto' })
  @MaxLength(2000)
  notes?: string;
}

/** `POST /v1/tokenization-requests/{id}/resubmit`. */
export class ResubmitTokenizationRequestDto {
  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @Transform(trim)
  @IsString({ message: 'message debe ser un texto' })
  @MaxLength(2000)
  message?: string;
}

/** Acción con motivo obligatorio (retirar, rechazar). */
export class TokenizationReasonDto {
  @ReasonProperty()
  reason!: string;
}

/** `GET /v1/tokenization-requests` (ERP). */
export class TokenizationRequestsQueryDto extends WineryScopedPaginationQueryDto {
  @ApiPropertyOptional({
    enum: TOKENIZATION_REQUEST_STATUSES,
    enumName: 'TokenizationRequestStatus',
  })
  @IsOptional()
  @IsIn(TOKENIZATION_REQUEST_STATUSES, { message: 'Estado no válido' })
  status?: TokenizationRequestStatus;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all', { message: 'lotId debe ser un UUID' })
  lotId?: string;

  @ApiPropertyOptional({
    enum: TOKENIZATION_REQUEST_KINDS,
    enumName: 'TokenizationRequestKind',
  })
  @IsOptional()
  @IsIn(TOKENIZATION_REQUEST_KINDS, { message: 'Tipo no válido' })
  kind?: TokenizationRequestKind;
}

// ── Entradas del back office (§5.4) ────────────────────────────────────────

/** `GET /v1/platform/tokenization-requests`. */
export class PlatformTokenizationRequestsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: TOKENIZATION_REQUEST_STATUSES,
    enumName: 'TokenizationRequestStatus',
    description: 'Por defecto, los estados abiertos, por antigüedad',
  })
  @IsOptional()
  @IsIn(TOKENIZATION_REQUEST_STATUSES, { message: 'Estado no válido' })
  status?: TokenizationRequestStatus;

  @ApiPropertyOptional({
    enum: TOKENIZATION_REQUEST_KINDS,
    enumName: 'TokenizationRequestKind',
  })
  @IsOptional()
  @IsIn(TOKENIZATION_REQUEST_KINDS, { message: 'Tipo no válido' })
  kind?: TokenizationRequestKind;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all', { message: 'wineryId debe ser un UUID' })
  wineryId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Persona asignada' })
  @IsOptional()
  @IsUUID('all', { message: 'assigneeId debe ser un UUID' })
  assigneeId?: string;

  @ApiPropertyOptional({
    description: 'Busca en la bodega, el lote y el nombre de la colección',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  q?: string;
}

/** `POST …/{id}/notes`. */
export class AddTokenizationNoteDto {
  @ApiProperty({ minLength: 1, maxLength: 2000 })
  @Transform(trim)
  @IsString({ message: 'text debe ser un texto' })
  @Length(1, 2000, { message: 'text debe tener entre 1 y 2000 caracteres' })
  text!: string;
}

/** `PATCH /v1/platform/tokenization-requests/{id}`. `price: null` lo deja vacío. */
@NullableFields('price')
export class ReviewTokenizationRequestDto {
  @ApiPropertyOptional({ type: () => CollectionCommercialInputDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CollectionCommercialInputDto)
  commercial?: CollectionCommercialInputDto;

  @ApiPropertyOptional({ type: () => CollectionPriceInputDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => CollectionPriceInputDto)
  price?: CollectionPriceInputDto | null;

  @OptionalReasonProperty()
  reason?: string;
}

/** `POST …/{id}/request-changes`. */
export class RequestTokenizationChangesDto {
  @ApiProperty({
    minLength: 3,
    maxLength: 2000,
    example: 'Falta la nota de cata',
    description: 'Llega por correo al dueño',
  })
  @Transform(trim)
  @IsString({ message: 'message debe ser un texto' })
  @Length(3, 2000, { message: 'message debe tener entre 3 y 2000 caracteres' })
  message!: string;

  @ApiPropertyOptional({
    type: String,
    isArray: true,
    maxItems: 20,
    example: ['commercial.tastingNotes'],
  })
  @IsOptional()
  @IsArray({ message: 'fields debe ser una lista' })
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  fields?: string[];
}

/** `POST …/{id}/approve`. */
@NullableFields('price')
export class ApproveTokenizationRequestDto {
  @ApiPropertyOptional({ type: () => CollectionCommercialInputDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CollectionCommercialInputDto)
  commercial?: CollectionCommercialInputDto;

  @ApiPropertyOptional({
    type: () => CollectionPriceInputDto,
    nullable: true,
    description: 'El precio no es obligatorio para aprobar (A-32)',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => CollectionPriceInputDto)
  price?: CollectionPriceInputDto | null;

  @ApiPropertyOptional({
    default: false,
    description: 'Publicar la colección en cuanto se confirme la emisión',
  })
  @IsOptional()
  @IsBoolean({ message: 'publishOnMint debe ser true o false' })
  publishOnMint?: boolean;

  @OptionalReasonProperty()
  reason?: string;
}
