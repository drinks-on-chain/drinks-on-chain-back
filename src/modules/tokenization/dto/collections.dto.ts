import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { JSON_VALUE_SCHEMA } from '@shared/dto/json-value.schema';
import {
  PaginationQueryDto,
  WineryScopedPaginationQueryDto,
} from '@shared/dto/pagination-query.dto';
import {
  OptionalReasonProperty,
  ReasonProperty,
} from '@shared/audit/requires-reason';
import { NullableFields } from '@shared/pipes/optional-nulls';
import { LOT_PRODUCT_TYPES, LOT_STAGES } from '@modules/lots/dto/lot.dto';
import {
  ChainTxRefDto,
  DossierAnchorDto,
} from '@modules/chain/dto/chain-common.dto';
import {
  CLOSURE_ITEM_OUTCOMES,
  COLLECTION_STATUSES,
  LOT_CLOSURE_STATUSES,
  MANUAL_CLOSURE_OUTCOMES,
  MINT_STATUSES,
  SALE_STATES,
  TOKENIZATION_REQUEST_KINDS,
  TOKEN_BURN_REASONS,
  TOKEN_OWNER_KINDS,
  TOKEN_STATUSES,
  UNSOLD_POLICIES,
  type ClosureItemOutcome,
  type CollectionStatus,
  type LotClosureStatus,
  type MintStatus,
  type SaleState,
  type TokenBurnReason,
  type TokenizationRequestKind,
  type TokenOwnerKind,
  type TokenStatus,
  type UnsoldPolicy,
} from '../tokenization.constants';
import {
  CollectionCommercialDto,
  CollectionCommercialInputDto,
  CollectionPriceDto,
  CollectionPriceInputDto,
  UserRefDto,
} from './commercial.dto';
import { TokenCountsDto } from './token-counts.dto';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const ACCOUNT_EXAMPLE =
  'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';
const CONTRACT_EXAMPLE =
  'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

export class WineryRefDto {
  @ApiProperty({ example: 'cinti-viejo' })
  slug!: string;

  @ApiProperty({ example: 'Destilería Cinti Viejo' })
  tradeName!: string;
}

// ── Emisión (§6.1) ─────────────────────────────────────────────────────────

export class MintRangeDto {
  @ApiProperty({ type: 'integer', minimum: 0 })
  firstTokenId!: number;

  @ApiProperty({ type: 'integer', minimum: 0 })
  lastTokenId!: number;

  @ApiProperty({ type: 'integer', minimum: 1 })
  firstBottleNumber!: number;

  @ApiProperty({ type: 'integer', minimum: 1 })
  lastBottleNumber!: number;
}

export class MintDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  collectionId!: string;

  @ApiProperty({ format: 'uuid' })
  requestId!: string;

  @ApiProperty({
    type: 'integer',
    minimum: 1,
    description: '1 = inicial; 2… = ampliaciones',
  })
  sequence!: number;

  @ApiProperty({ type: 'integer', minimum: 1 })
  quantity!: number;

  @ApiProperty({ enum: MINT_STATUSES, enumName: 'MintStatus' })
  status!: MintStatus;

  @ApiProperty({
    example: 'CVJ-L2026-004',
    description: 'Lo enviado como `lot` a `mint_batch`: la referencia del lote',
  })
  lotArg!: string;

  @ApiProperty({ type: () => MintRangeDto, isArray: true })
  ranges!: MintRangeDto[];

  @ApiProperty({
    type: () => ChainTxRefDto,
    isArray: true,
    description: 'Una por trozo de hasta 32 000',
  })
  transactions!: ChainTxRefDto[];

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  confirmedAt!: string | null;
}

// ── Colección (§6.2) ───────────────────────────────────────────────────────

export class CollectionLotRefDto {
  @ApiProperty({ example: 'CVJ-L2026-004' })
  reference!: string;

  @ApiProperty({ type: String, nullable: true })
  lotCode!: string | null;

  @ApiProperty({ example: 'Singani Preventa 2026' })
  name!: string;

  @ApiProperty({ enum: LOT_PRODUCT_TYPES, enumName: 'LotProductType' })
  productType!: (typeof LOT_PRODUCT_TYPES)[number];

  @ApiProperty({ type: 'integer', example: 2026 })
  harvestYear!: number;

  @ApiProperty({ enum: LOT_STAGES, enumName: 'LotStage' })
  stage!: (typeof LOT_STAGES)[number];

  @ApiProperty({ type: String, nullable: true, format: 'date' })
  estimatedReadyDate!: string | null;
}

export class CollectionContractRefDto {
  @ApiProperty({ example: CONTRACT_EXAMPLE })
  address!: string;

  @ApiProperty({ type: String, nullable: true })
  explorerUrl!: string | null;
}

export class CollectionSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'singani-preventa-2026' })
  slug!: string;

  @ApiProperty({ format: 'uuid' })
  wineryId!: string;

  @ApiProperty({ type: () => WineryRefDto })
  winery!: WineryRefDto;

  @ApiProperty({ format: 'uuid' })
  lotId!: string;

  @ApiProperty({ type: () => CollectionLotRefDto })
  lot!: CollectionLotRefDto;

  @ApiProperty({ enum: COLLECTION_STATUSES, enumName: 'CollectionStatus' })
  status!: CollectionStatus;

  @ApiProperty({
    enum: MINT_STATUSES,
    enumName: 'MintStatus',
    description: 'De la última emisión',
  })
  mintStatus!: MintStatus;

  @ApiProperty({
    enum: SALE_STATES,
    enumName: 'SaleState',
    nullable: true,
    description:
      'Derivado; `null` si no está `PUBLISHED`. `PRESALE` hasta el anclaje; `ON_SALE` después',
  })
  saleState!: SaleState | null;

  @ApiProperty({ type: 'integer', minimum: 1 })
  quota!: number;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: 'De una ampliación aprobada con la emisión en curso',
  })
  pendingMintQuantity!: number;

  @ApiProperty({ type: () => TokenCountsDto })
  counts!: TokenCountsDto;

  @ApiProperty({ type: () => CollectionPriceDto, nullable: true })
  price!: CollectionPriceDto | null;

  @ApiProperty()
  name!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Portada: `GET /v1/public/collections/images/{id}` de esta API si está publicada',
  })
  coverImageUrl!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'date' })
  estimatedRedeemDate!: string | null;

  @ApiProperty({ type: () => CollectionContractRefDto })
  contract!: CollectionContractRefDto;

  @ApiProperty({ description: 'Desde el anclaje del expediente (§7.2)' })
  redeemable!: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  redeemableSince!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  publishedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  closedAt!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

export class QuotaHistoryEntryDto {
  @ApiProperty({ format: 'uuid' })
  requestId!: string;

  @ApiProperty({
    enum: TOKENIZATION_REQUEST_KINDS,
    enumName: 'TokenizationRequestKind',
  })
  kind!: TokenizationRequestKind;

  @ApiProperty({ type: 'integer', minimum: 1 })
  quantity!: number;

  @ApiProperty({ type: 'integer', minimum: 1 })
  resultingQuota!: number;

  @ApiProperty({ format: 'date-time' })
  approvedAt!: string;

  @ApiProperty({ example: 'Lic. Marcos Vaca' })
  approvedBy!: string;
}

export class CollectionStatusHistoryEntryDto {
  @ApiProperty({ enum: COLLECTION_STATUSES, enumName: 'CollectionStatus' })
  status!: CollectionStatus;

  @ApiProperty({ format: 'date-time' })
  at!: string;

  @ApiProperty({ example: 'Lic. Marcos Vaca' })
  by!: string;

  @ApiProperty({ type: String, nullable: true })
  reason!: string | null;
}

// ── Métricas (§8.5, TOK-11) ────────────────────────────────────────────────

export class CollectionChainCostsDto {
  @ApiProperty({ example: '0.1459000' })
  feesChargedXlm!: string;

  @ApiProperty({ type: 'integer', minimum: 0 })
  transactions!: number;
}

export class CollectionMintMetricDto {
  @ApiProperty({ type: 'integer', minimum: 1 })
  sequence!: number;

  @ApiProperty({ type: 'integer', minimum: 1 })
  quantity!: number;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  confirmedAt!: string | null;
}

export class CollectionMetricsDto {
  @ApiProperty({ type: () => TokenCountsDto })
  counts!: TokenCountsDto;

  @ApiProperty({ type: 'integer', minimum: 1 })
  quota!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Cuota sobre la estimación del lote, en %',
  })
  authorizedVsEstimatePercent!: number | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  firstMintedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  publishedAt!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Ola 4',
  })
  firstSaleAt!: string | null;

  @ApiProperty({ type: () => CollectionChainCostsDto })
  chainCosts!: CollectionChainCostsDto;

  @ApiProperty({ type: () => CollectionMintMetricDto, isArray: true })
  byMint!: CollectionMintMetricDto[];
}

// ── Cierre del lote con faltante (§8.4, TOK-10) ────────────────────────────

export class LotClosureDecisionDto {
  @ApiProperty({ type: () => UserRefDto })
  by!: UserRefDto;

  @ApiProperty({ format: 'date-time' })
  at!: string;

  @ApiProperty()
  reason!: string;
}

/** Cifras del cierre, sin los NFT afectados (lo que lleva la lista). */
export class LotClosureSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  lotId!: string;

  @ApiProperty({ format: 'uuid' })
  collectionId!: string;

  @ApiProperty({ enum: LOT_CLOSURE_STATUSES, enumName: 'LotClosureStatus' })
  status!: LotClosureStatus;

  @ApiProperty({ format: 'date-time' })
  computedAt!: string;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: 'Códigos `ACTIVE` (0 si el lote se descartó)',
  })
  bottles!: number;

  @ApiProperty({ type: 'integer', minimum: 0 })
  minted!: number;

  @ApiProperty({ type: 'integer', minimum: 0 })
  sold!: number;

  @ApiProperty({ type: 'integer', minimum: 0 })
  reserved!: number;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: '`MINTED` no reservados',
  })
  unsold!: number;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: 'max(0, emitidos − quemados − botellas)',
  })
  shortfall!: number;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: 'min(faltante, no vendidos)',
  })
  unsoldToBurn!: number;

  @ApiProperty({ type: 'integer', minimum: 0 })
  soldWithoutBottle!: number;

  @ApiProperty({
    enum: UNSOLD_POLICIES,
    enumName: 'UnsoldPolicy',
    nullable: true,
    description: 'Qué hacer con los no vendidos que sí tienen botella',
  })
  unsoldPolicy!: UnsoldPolicy | null;

  @ApiProperty({ type: () => LotClosureDecisionDto, nullable: true })
  decision!: LotClosureDecisionDto | null;
}

/** NFT afectado, como lo ve la bodega: sin datos de pedidos. */
export class WineryLotClosureItemDto {
  @ApiProperty({ type: 'integer', minimum: 0 })
  tokenId!: number;

  @ApiProperty({ type: 'integer', minimum: 1 })
  bottleNumber!: number;

  @ApiProperty({ enum: TOKEN_STATUSES, enumName: 'TokenStatus' })
  status!: TokenStatus;

  @ApiProperty({
    enum: CLOSURE_ITEM_OUTCOMES,
    enumName: 'ClosureItemOutcome',
  })
  outcome!: ClosureItemOutcome;

  @ApiProperty({ type: () => ChainTxRefDto, nullable: true })
  burnTx!: ChainTxRefDto | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  resolvedAt!: string | null;
}

export class LotClosureItemDto extends WineryLotClosureItemDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Ola 4',
  })
  orderId!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Ola 4',
  })
  paidAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  note!: string | null;
}

export class LotClosureDto extends LotClosureSummaryDto {
  @ApiProperty({
    type: () => LotClosureItemDto,
    isArray: true,
    description: 'Solo los NFT afectados',
  })
  items!: LotClosureItemDto[];
}

/** `GET /v1/collections/{id}/closure`: cifras y números de botella. */
export class WineryLotClosureDto extends LotClosureSummaryDto {
  @ApiProperty({ type: () => WineryLotClosureItemDto, isArray: true })
  items!: WineryLotClosureItemDto[];
}

/** `POST /v1/platform/collections/{id}/closure/decide`. */
export class DecideLotClosureDto {
  @ApiProperty({
    enum: UNSOLD_POLICIES,
    enumName: 'UnsoldPolicy',
    description:
      '`BURN` (y todo cierre con faltante): solo `ADMIN`. `KEEP_ON_SALE` sin faltante: también `OPERATIONS`',
  })
  @IsIn(UNSOLD_POLICIES, { message: 'unsoldPolicy no válido' })
  unsoldPolicy!: UnsoldPolicy;

  @ReasonProperty()
  reason!: string;
}

/** `POST /v1/platform/collections/{id}/closure/items/{tokenId}/resolve`. */
export class ResolveLotClosureItemDto {
  @ApiProperty({ enum: MANUAL_CLOSURE_OUTCOMES })
  @IsIn(MANUAL_CLOSURE_OUTCOMES, { message: 'outcome no válido' })
  outcome!: (typeof MANUAL_CLOSURE_OUTCOMES)[number];

  @ApiProperty({ minLength: 3, maxLength: 1000 })
  @Transform(trim)
  @IsString({ message: 'note debe ser un texto' })
  @Length(3, 1000, { message: 'note debe tener entre 3 y 1000 caracteres' })
  note!: string;
}

/** `GET /v1/platform/lot-closures`. */
export class LotClosuresQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: LOT_CLOSURE_STATUSES,
    enumName: 'LotClosureStatus',
  })
  @IsOptional()
  @IsIn(LOT_CLOSURE_STATUSES, { message: 'Estado no válido' })
  status?: LotClosureStatus;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all', { message: 'wineryId debe ser un UUID' })
  wineryId?: string;
}

// ── Colección completa ─────────────────────────────────────────────────────

export class CollectionDto extends CollectionSummaryDto {
  @ApiProperty({ type: () => CollectionCommercialDto })
  commercial!: CollectionCommercialDto;

  @ApiProperty({
    ...JSON_VALUE_SCHEMA,
    description: 'Copia de `precio.politica` al aprobar',
  })
  pricePolicySnapshot!: unknown;

  @ApiProperty({ type: () => CollectionPriceDto, isArray: true })
  priceHistory!: CollectionPriceDto[];

  @ApiProperty({ type: () => MintDto, isArray: true })
  mints!: MintDto[];

  @ApiProperty({ type: () => QuotaHistoryEntryDto, isArray: true })
  quotaHistory!: QuotaHistoryEntryDto[];

  @ApiProperty({ type: () => CollectionStatusHistoryEntryDto, isArray: true })
  statusHistory!: CollectionStatusHistoryEntryDto[];

  @ApiProperty({ type: () => DossierAnchorDto, nullable: true })
  anchor!: DossierAnchorDto | null;

  @ApiProperty({ type: () => LotClosureDto, nullable: true })
  closure!: LotClosureDto | null;

  @ApiProperty({ type: () => CollectionMetricsDto })
  metrics!: CollectionMetricsDto;
}

// ── NFT por botella (§6.3) ─────────────────────────────────────────────────

export class TokenOwnerDto {
  @ApiProperty({ enum: TOKEN_OWNER_KINDS, enumName: 'TokenOwnerKind' })
  kind!: TokenOwnerKind;

  @ApiProperty({ example: ACCOUNT_EXAMPLE })
  address!: string;
}

export class TokenOnchainDto {
  @ApiProperty({ type: String, nullable: true, example: ACCOUNT_EXAMPLE })
  owner!: string | null;

  @ApiProperty()
  burned!: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  checkedAt!: string | null;
}

export class TokenDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  collectionId!: string;

  @ApiProperty({ format: 'uuid' })
  wineryId!: string;

  @ApiProperty({ format: 'uuid' })
  lotId!: string;

  @ApiProperty({ example: CONTRACT_EXAMPLE })
  contractAddress!: string;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: 'Id en la red (u32)',
  })
  tokenId!: number;

  @ApiProperty({
    type: 'integer',
    minimum: 1,
    description: '1…cuota dentro de la colección (no es el serial físico)',
  })
  bottleNumber!: number;

  @ApiProperty({ enum: TOKEN_STATUSES, enumName: 'TokenStatus' })
  status!: TokenStatus;

  @ApiProperty({
    type: () => TokenOwnerDto,
    description: 'Proyección de la base; sin datos del consumidor',
  })
  owner!: TokenOwnerDto;

  @ApiProperty({ format: 'uuid' })
  mintId!: string;

  @ApiProperty({ type: () => ChainTxRefDto })
  mintTx!: ChainTxRefDto;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  soldAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  redeemableAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  redeemWindowEndsAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  burnedAt!: string | null;

  @ApiProperty({ type: () => ChainTxRefDto, nullable: true })
  burnTx!: ChainTxRefDto | null;

  @ApiProperty({
    enum: TOKEN_BURN_REASONS,
    enumName: 'TokenBurnReason',
    nullable: true,
  })
  burnReason!: TokenBurnReason | null;

  @ApiProperty({
    type: () => TokenOnchainDto,
    description: 'Última lectura del indexador o de la conciliación',
  })
  onchain!: TokenOnchainDto;

  @ApiProperty({
    example: 'https://api.drinksonchain.com/v1/public/nft/cinti-viejo/57',
    description: '`token_uri`',
  })
  metadataUrl!: string;
}

// ── Consultas y acciones ───────────────────────────────────────────────────

/** `GET /v1/collections` (ERP). */
export class CollectionsQueryDto extends WineryScopedPaginationQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all', { message: 'lotId debe ser un UUID' })
  lotId?: string;

  @ApiPropertyOptional({
    enum: COLLECTION_STATUSES,
    enumName: 'CollectionStatus',
  })
  @IsOptional()
  @IsIn(COLLECTION_STATUSES, { message: 'Estado no válido' })
  status?: CollectionStatus;
}

/** `GET /v1/platform/collections`. */
export class PlatformCollectionsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: COLLECTION_STATUSES,
    enumName: 'CollectionStatus',
  })
  @IsOptional()
  @IsIn(COLLECTION_STATUSES, { message: 'Estado no válido' })
  status?: CollectionStatus;

  @ApiPropertyOptional({ enum: SALE_STATES, enumName: 'SaleState' })
  @IsOptional()
  @IsIn(SALE_STATES, { message: 'saleState no válido' })
  saleState?: SaleState;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all', { message: 'wineryId debe ser un UUID' })
  wineryId?: string;

  @ApiPropertyOptional({ enum: MINT_STATUSES, enumName: 'MintStatus' })
  @IsOptional()
  @IsIn(MINT_STATUSES, { message: 'mintStatus no válido' })
  mintStatus?: MintStatus;

  @ApiPropertyOptional({
    description:
      'Busca en el nombre, el slug, la bodega y la referencia del lote',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  q?: string;
}

/** `GET …/collections/{id}/tokens`. */
export class TokensQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: TOKEN_STATUSES, enumName: 'TokenStatus' })
  @IsOptional()
  @IsIn(TOKEN_STATUSES, { message: 'Estado no válido' })
  status?: TokenStatus;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    description: 'Número de botella desde',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'fromNumber debe ser un entero' })
  @Min(1)
  fromNumber?: number;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    description: 'Número de botella hasta',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'toNumber debe ser un entero' })
  @Min(1)
  toNumber?: number;
}

/** `PATCH /v1/platform/collections/{id}`. `price: null` quita el precio. */
@NullableFields('price', 'estimatedRedeemDate')
export class UpdateCollectionDto {
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

  @ApiPropertyOptional({ type: String, nullable: true, format: 'date' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'estimatedRedeemDate debe ser AAAA-MM-DD',
  })
  estimatedRedeemDate?: string | null;

  @ReasonProperty()
  reason!: string;
}

/** Acción con motivo obligatorio (pausar, cerrar). */
export class CollectionReasonDto {
  @ReasonProperty()
  reason!: string;
}

/** Acción con motivo opcional (publicar, reanudar). */
export class CollectionOptionalReasonDto {
  @OptionalReasonProperty()
  reason?: string;
}
