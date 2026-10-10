import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import { JSON_VALUE_SCHEMA } from '@shared/dto/json-value.schema';
import { PaginationQueryDto } from '@shared/dto/pagination-query.dto';
import { ReasonProperty } from '@shared/audit/requires-reason';
import { LOT_STAGES } from '@modules/lots/dto/lot.dto';
import {
  COLLECTION_STATUSES,
  type CollectionStatus,
} from '@modules/tokenization/tokenization.constants';
import { TokenCountsDto } from '@modules/tokenization/dto/token-counts.dto';
import {
  CHAIN_ALERT_LEVELS,
  CHAIN_IDENTITY_STATUSES,
  CHAIN_NETWORKS,
  CHAIN_SIGNER_ROLES,
  CHAIN_SUBJECT_TYPES,
  CHAIN_TX_KINDS,
  CHAIN_TX_STATUSES,
  PLATFORM_ACCOUNT_STATUSES,
  RECONCILIATION_DEPTHS,
  RECONCILIATION_SCOPES,
  RECONCILIATION_STATUSES,
  RECONCILIATION_TRIGGERS,
  VERIFICATION_CHECK_KEYS,
  type ChainAlertLevel,
  type ChainIdentityStatus,
  type ChainNetwork,
  type ChainSignerRole,
  type ChainSubjectType,
  type ChainTxKind,
  type ChainTxStatus,
  type PlatformAccountBalanceStatus,
  type ReconciliationDepth,
  type ReconciliationScope,
  type VerificationCheckKey,
} from '../chain.constants';
import {
  ChainTxRefDto,
  DossierAnchorDto,
  PublicDossierAnchorDto,
} from './chain-common.dto';

const ACCOUNT_EXAMPLE =
  'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';
const CONTRACT_EXAMPLE =
  'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const HASH_EXAMPLE =
  '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

// ── Transacciones (§2.3, §2.4) ─────────────────────────────────────────────

export class ChainSubjectDto {
  @ApiProperty({ enum: CHAIN_SUBJECT_TYPES, enumName: 'ChainSubjectType' })
  type!: ChainSubjectType;

  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  id!: string;
}

export class ChainSignerDto {
  @ApiProperty({ enum: CHAIN_SIGNER_ROLES, enumName: 'ChainSignerRole' })
  role!: ChainSignerRole;

  @ApiProperty({ example: ACCOUNT_EXAMPLE })
  address!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  wineryId!: string | null;
}

export class ChainTxResultDto {
  @ApiProperty({
    ...JSON_VALUE_SCHEMA,
    description:
      'Valor devuelto (p. ej. el último id emitido por `mint_batch`)',
    example: 99,
  })
  returnValue!: unknown;

  @ApiProperty({
    type: String,
    isArray: true,
    description: 'Tipos de los eventos del contrato que emitió',
    example: ['consecutive_mint', 'lot_minted'],
  })
  contractEvents!: string[];
}

export class ChainTxHistoryEntryDto {
  @ApiProperty({ type: 'integer', minimum: 1 })
  attempt!: number;

  @ApiProperty({ enum: CHAIN_TX_STATUSES, enumName: 'ChainTxStatus' })
  status!: ChainTxStatus;

  @ApiProperty({ format: 'date-time' })
  at!: string;

  @ApiProperty({ type: String, nullable: true })
  txHash!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Número de secuencia de la cuenta de origen',
  })
  sequence!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'CHN_BAD_SEQUENCE' })
  errorCode!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Código de resultado de la red o del contrato',
  })
  detail!: string | null;
}

export class ChainTxRequestedByDto {
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  userId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  fullName!: string | null;

  @ApiProperty({ enum: ['API', 'WORKER'] })
  source!: 'API' | 'WORKER';
}

export class ChainTxAbandonedDto {
  @ApiProperty({ format: 'date-time' })
  at!: string;

  @ApiProperty({ example: 'Lic. Marcos Vaca' })
  by!: string;

  @ApiProperty()
  reason!: string;
}

/** Transacción completa: solo la ve la plataforma. */
export class ChainTransactionDto extends ChainTxRefDto {
  @ApiProperty({
    example: 'mint:3fa85f64-5717-4562-b3fc-2c963f66afa6:1',
    description: 'Único: reprocesar el evento no crea otra transacción',
  })
  intentKey!: string;

  @ApiProperty({ type: () => ChainSubjectDto })
  subject!: ChainSubjectDto;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  wineryId!: string | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'Parámetros validados de la intención; sin secretos ni XDR',
  })
  intent!: Record<string, unknown>;

  @ApiProperty({
    type: String,
    nullable: true,
    example: ACCOUNT_EXAMPLE,
    description: 'Quien paga (`null` hasta que el worker la construye)',
  })
  sourceAccount!: string | null;

  @ApiProperty({ type: () => ChainSignerDto, isArray: true })
  signers!: ChainSignerDto[];

  @ApiProperty({ type: String, nullable: true, example: '1389000' })
  feeChargedStroops!: string | null;

  @ApiProperty({ type: String, nullable: true })
  rentFeeStroops!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '100000000',
    description: 'Tope de comisión con el que se construyó',
  })
  maxFeeStroops!: string | null;

  @ApiProperty({ type: () => ChainTxResultDto, nullable: true })
  result!: ChainTxResultDto | null;

  @ApiProperty({ type: () => ChainTxHistoryEntryDto, isArray: true })
  history!: ChainTxHistoryEntryDto[];

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  nextAttemptAt!: string | null;

  @ApiProperty({ type: () => ChainTxRequestedByDto })
  requestedBy!: ChainTxRequestedByDto;

  @ApiProperty({ type: () => ChainTxAbandonedDto, nullable: true })
  abandoned!: ChainTxAbandonedDto | null;

  @ApiProperty({ type: String, nullable: true })
  correlationId!: string | null;
}

/** `GET /v1/platform/chain/transactions`. */
export class ChainTransactionsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: CHAIN_TX_STATUSES, enumName: 'ChainTxStatus' })
  @IsOptional()
  @IsIn(CHAIN_TX_STATUSES, { message: 'Estado no válido' })
  status?: ChainTxStatus;

  @ApiPropertyOptional({ enum: CHAIN_TX_KINDS, enumName: 'ChainTxKind' })
  @IsOptional()
  @IsIn(CHAIN_TX_KINDS, { message: 'Tipo de transacción no válido' })
  kind?: ChainTxKind;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all', { message: 'wineryId debe ser un UUID' })
  wineryId?: string;

  @ApiPropertyOptional({
    enum: CHAIN_SUBJECT_TYPES,
    enumName: 'ChainSubjectType',
  })
  @IsOptional()
  @IsIn(CHAIN_SUBJECT_TYPES, { message: 'Tipo de sujeto no válido' })
  subjectType?: ChainSubjectType;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  subjectId?: string;

  @ApiPropertyOptional({ format: 'date-time', description: 'Creadas desde' })
  @IsOptional()
  @IsDateString({}, { message: 'from debe ser una fecha ISO 8601' })
  from?: string;

  @ApiPropertyOptional({ format: 'date-time', description: 'Creadas hasta' })
  @IsOptional()
  @IsDateString({}, { message: 'to debe ser una fecha ISO 8601' })
  to?: string;
}

/** Cuerpo de las acciones del back office sobre la cadena: solo el motivo. */
export class ChainActionDto {
  @ReasonProperty()
  reason!: string;
}

// ── Cuentas de la plataforma (§2.4) ────────────────────────────────────────

export class PlatformAccountStatusDto {
  @ApiProperty({
    type: String,
    nullable: true,
    example: ACCOUNT_EXAMPLE,
    description: '`null` con `status: MISSING` (cuenta sin configurar)',
  })
  address!: string | null;

  @ApiProperty({ type: String, nullable: true })
  explorerUrl!: string | null;

  @ApiProperty({
    example: '9873.4512300',
    description: 'XLM con 7 decimales (`"0.0000000"` si falta la cuenta)',
  })
  balanceXlm!: string;

  @ApiProperty({ example: '50.0000000' })
  minBalanceXlm!: string;

  @ApiProperty({
    enum: PLATFORM_ACCOUNT_STATUSES,
    enumName: 'PlatformAccountBalanceStatus',
  })
  status!: PlatformAccountBalanceStatus;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Última lectura del saldo en la red',
  })
  checkedAt!: string | null;
}

export class PlatformChainAccountsDto {
  @ApiProperty({ enum: CHAIN_NETWORKS, enumName: 'ChainNetwork' })
  network!: ChainNetwork;

  @ApiProperty({ type: () => PlatformAccountStatusDto })
  operations!: PlatformAccountStatusDto;

  @ApiProperty({ type: () => PlatformAccountStatusDto })
  anchor!: PlatformAccountStatusDto;

  @ApiProperty({
    type: String,
    nullable: true,
    example: HASH_EXAMPLE,
    description: 'Código del contrato NFT (`WINERY_NFT_WASM_HASH`)',
  })
  wasmHash!: string | null;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    description: 'Días de vida que le quedan al código en la red (§8.3)',
  })
  codeTtlDays!: number | null;
}

// ── Identidad de la bodega (§3.1) ──────────────────────────────────────────

export class ChainIdentityAccountDto {
  @ApiProperty({ example: ACCOUNT_EXAMPLE })
  address!: string;

  @ApiProperty({ type: String, nullable: true })
  explorerUrl!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'api.drinksonchain.com',
  })
  homeDomain!: string | null;

  @ApiProperty({ type: () => ChainTxRefDto })
  createdTx!: ChainTxRefDto;
}

export class ChainIdentityContractDto {
  @ApiProperty({ example: CONTRACT_EXAMPLE })
  address!: string;

  @ApiProperty({ type: String, nullable: true })
  explorerUrl!: string | null;

  @ApiProperty({ example: HASH_EXAMPLE })
  wasmHash!: string;

  @ApiProperty({ example: 'Destilería Cinti Viejo', maxLength: 40 })
  name!: string;

  @ApiProperty({ example: 'CVJ', description: 'El `lotPrefix` de la bodega' })
  symbol!: string;

  @ApiProperty({
    example: 'https://api.drinksonchain.com/v1/public/nft/cinti-viejo/',
    description: '`token_uri(id)` = `baseUri` + id',
  })
  baseUri!: string;

  @ApiProperty({ example: ACCOUNT_EXAMPLE })
  operatorAddress!: string;

  @ApiProperty({ description: 'Pausado en la red (§3.5)' })
  paused!: boolean;

  @ApiProperty({ type: () => ChainTxRefDto })
  deployedTx!: ChainTxRefDto;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  deployedAt!: string | null;
}

export class ChainIdentityErrorDto {
  @ApiProperty({ example: 'CHN_INSUFFICIENT_BALANCE' })
  code!: string;

  @ApiProperty()
  message!: string;
}

export class WineryChainIdentityDto {
  @ApiProperty({ format: 'uuid' })
  wineryId!: string;

  @ApiProperty({ enum: CHAIN_NETWORKS, enumName: 'ChainNetwork' })
  network!: ChainNetwork;

  @ApiProperty({
    enum: CHAIN_IDENTITY_STATUSES,
    enumName: 'ChainIdentityStatus',
    description:
      '`ACTIVE` exige cuenta y contrato confirmados y leídos de vuelta',
  })
  status!: ChainIdentityStatus;

  @ApiProperty({ type: () => ChainIdentityAccountDto, nullable: true })
  account!: ChainIdentityAccountDto | null;

  @ApiProperty({ type: () => ChainIdentityContractDto, nullable: true })
  contract!: ChainIdentityContractDto | null;

  @ApiProperty({ type: () => ChainTxRefDto, isArray: true })
  pendingTransactions!: ChainTxRefDto[];

  @ApiProperty({ type: () => ChainIdentityErrorDto, nullable: true })
  lastError!: ChainIdentityErrorDto | null;
}

// ── Cuenta de la bodega en el ERP (§3.4, ORG-12) ───────────────────────────

export class ChainAccountLotDto {
  @ApiProperty({ format: 'uuid' })
  lotId!: string;

  @ApiProperty({ example: 'CVJ-L2026-004' })
  reference!: string;

  @ApiProperty({ type: String, nullable: true })
  lotCode!: string | null;

  @ApiProperty({ example: 'Singani Preventa 2026' })
  name!: string;

  @ApiProperty({ enum: LOT_STAGES, enumName: 'LotStage' })
  stage!: (typeof LOT_STAGES)[number];

  @ApiProperty({ format: 'uuid' })
  collectionId!: string;

  @ApiProperty({ enum: COLLECTION_STATUSES, enumName: 'CollectionStatus' })
  collectionStatus!: CollectionStatus;

  @ApiProperty({ type: 'integer', minimum: 1 })
  quota!: number;

  @ApiProperty({ type: () => TokenCountsDto })
  counts!: TokenCountsDto;

  @ApiProperty({ type: () => DossierAnchorDto, nullable: true })
  anchor!: DossierAnchorDto | null;
}

export class WineryChainCostsDto {
  @ApiProperty({
    example: '0.1459000',
    description: 'XLM pagados por la plataforma por esta bodega (informativo)',
  })
  feesChargedXlm!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Desde cuándo se suma (`null` sin transacciones)',
  })
  since!: string | null;
}

export class WineryChainAccountViewDto {
  @ApiProperty({ type: () => WineryChainIdentityDto })
  identity!: WineryChainIdentityDto;

  @ApiProperty({
    type: () => TokenCountsDto,
    description: 'Suma de sus colecciones',
  })
  totals!: TokenCountsDto;

  @ApiProperty({ type: () => ChainAccountLotDto, isArray: true })
  byLot!: ChainAccountLotDto[];

  @ApiProperty({
    type: () => ChainTxRefDto,
    isArray: true,
    maxItems: 10,
    description: 'Las 10 últimas de la bodega (emisiones, anclajes, pausas)',
  })
  recentTransactions!: ChainTxRefDto[];

  @ApiProperty({ type: () => WineryChainCostsDto })
  chainCosts!: WineryChainCostsDto;
}

// ── Registro público (§3.2) ────────────────────────────────────────────────

export class PublicChainRegistryPlatformDto {
  @ApiProperty({ type: String, nullable: true, example: ACCOUNT_EXAMPLE })
  operationsAccount!: string | null;

  @ApiProperty({ type: String, nullable: true, example: ACCOUNT_EXAMPLE })
  anchorAccount!: string | null;
}

export class PublicChainRegistryWineryDto {
  @ApiProperty({ example: 'cinti-viejo' })
  slug!: string;

  @ApiProperty({ example: 'Destilería Cinti Viejo' })
  tradeName!: string;

  @ApiProperty({ example: 'CVJ' })
  symbol!: string;

  @ApiProperty({ example: ACCOUNT_EXAMPLE })
  account!: string;

  @ApiProperty({ example: CONTRACT_EXAMPLE })
  contract!: string;

  @ApiProperty({ type: String, nullable: true })
  accountExplorerUrl!: string | null;

  @ApiProperty({ type: String, nullable: true })
  contractExplorerUrl!: string | null;

  @ApiProperty()
  paused!: boolean;

  @ApiProperty({ format: 'date-time', description: 'Contrato desplegado' })
  since!: string;
}

/** Fuente canónica de "contratos oficiales". */
export class PublicChainRegistryDto {
  @ApiProperty({ enum: CHAIN_NETWORKS, enumName: 'ChainNetwork' })
  network!: ChainNetwork;

  @ApiProperty({ example: 'Test SDF Network ; September 2015' })
  networkPassphrase!: string;

  @ApiProperty({ type: String, nullable: true, example: HASH_EXAMPLE })
  wasmHash!: string | null;

  @ApiProperty({ type: () => PublicChainRegistryPlatformDto })
  platform!: PublicChainRegistryPlatformDto;

  @ApiProperty({ type: () => PublicChainRegistryWineryDto, isArray: true })
  wineries!: PublicChainRegistryWineryDto[];

  @ApiProperty({ format: 'date-time' })
  generatedAt!: string;
}

// ── Verificación pública del anclaje (§7.3, PUB-03) ────────────────────────

export class PublicVerificationDossierDto {
  @ApiProperty({ enum: ['OPEN', 'CLOSED'] })
  status!: 'OPEN' | 'CLOSED';

  @ApiProperty({ type: String, nullable: true, example: HASH_EXAMPLE })
  hash!: string | null;

  @ApiProperty({ enum: ['sha256/jcs-rfc8785'] })
  algorithm!: 'sha256/jcs-rfc8785';

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  closedAt!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Bytes canónicos para recalcular la huella (O2 §12.1)',
  })
  canonicalUrl!: string | null;
}

export class PublicVerificationCheckDto {
  @ApiProperty({
    enum: VERIFICATION_CHECK_KEYS,
    enumName: 'DossierVerificationCheckKey',
  })
  key!: VerificationCheckKey;

  @ApiProperty({
    type: Boolean,
    nullable: true,
    description: '`null` = aún no aplica',
  })
  pass!: boolean | null;

  @ApiProperty({ example: 'El expediente está cerrado' })
  message!: string;
}

export class PublicDossierVerificationDto {
  @ApiProperty({ example: 'CVJ-2026-SINGANI-004' })
  lotCode!: string;

  @ApiProperty({ type: () => PublicVerificationDossierDto })
  dossier!: PublicVerificationDossierDto;

  @ApiProperty({ type: () => PublicDossierAnchorDto, nullable: true })
  anchor!: PublicDossierAnchorDto | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: ACCOUNT_EXAMPLE,
    description:
      'La de `stellar.toml` y del registro (`null` si el entorno no tiene cuenta de anclaje)',
  })
  officialAnchorAccount!: string | null;

  @ApiProperty({ type: () => PublicVerificationCheckDto, isArray: true })
  checks!: PublicVerificationCheckDto[];

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Comprobación del servidor al confirmar el anclaje',
  })
  verifiedOnChainAt!: string | null;

  @ApiProperty({ format: 'date-time' })
  checkedAt!: string;
}

// ── Indexador (§8.1) ───────────────────────────────────────────────────────

export class ChainEventDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: '0005305721018777600-0000000001' })
  rpcEventId!: string;

  @ApiProperty({ enum: CHAIN_NETWORKS, enumName: 'ChainNetwork' })
  network!: ChainNetwork;

  @ApiProperty({ example: CONTRACT_EXAMPLE })
  contractAddress!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  wineryId!: string | null;

  @ApiProperty({ type: 'integer' })
  ledger!: number;

  @ApiProperty({ format: 'date-time' })
  ledgerClosedAt!: string;

  @ApiProperty({ example: HASH_EXAMPLE })
  txHash!: string;

  @ApiProperty({
    example: 'lot_minted',
    description:
      'Primer topic: `consecutive_mint`, `lot_minted`, `transfer`, `burn`, `paused`, `unpaused`, `role_granted`…',
  })
  type!: string;

  @ApiProperty({
    type: 'array',
    items: {},
    description: 'Topics decodificados',
  })
  topics!: unknown[];

  @ApiProperty({ type: 'object', additionalProperties: true })
  data!: Record<string, unknown>;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Transacción propia que lo originó',
  })
  matchedTransactionId!: string | null;

  @ApiProperty({
    description: '`false` → alerta `CRITICAL` `UNEXPECTED_EVENT`',
  })
  originatedBySystem!: boolean;

  @ApiProperty({ format: 'date-time' })
  processedAt!: string;
}

/** `GET /v1/platform/chain/events`. */
export class ChainEventsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Dirección `C…` del contrato' })
  @IsOptional()
  @Matches(/^C[A-Z2-7]{55}$/, { message: 'contract debe ser una dirección C…' })
  contract?: string;

  @ApiPropertyOptional({ example: 'lot_minted' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(40)
  type?: string;

  @ApiPropertyOptional({ description: 'Hash de la transacción (hex de 64)' })
  @IsOptional()
  @Matches(/^[0-9a-f]{64}$/, { message: 'txHash debe ser un hex de 64' })
  txHash?: string;

  @ApiPropertyOptional({
    enum: ['true', 'false'],
    description: '`true` = solo los que no originó el sistema',
  })
  @IsOptional()
  @IsIn(['true', 'false'], { message: 'unmatched debe ser true o false' })
  unmatched?: 'true' | 'false';

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString({}, { message: 'from debe ser una fecha ISO 8601' })
  from?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString({}, { message: 'to debe ser una fecha ISO 8601' })
  to?: string;
}

// ── Conciliación y alertas (§8.2) ──────────────────────────────────────────

export class ReconciliationRunDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: RECONCILIATION_SCOPES, enumName: 'ReconciliationScope' })
  scope!: ReconciliationScope;

  @ApiProperty({ type: String, nullable: true })
  subjectId!: string | null;

  @ApiProperty({
    enum: RECONCILIATION_TRIGGERS,
    enumName: 'ReconciliationTrigger',
  })
  trigger!: (typeof RECONCILIATION_TRIGGERS)[number];

  @ApiProperty({ enum: RECONCILIATION_DEPTHS, enumName: 'ReconciliationDepth' })
  depth!: ReconciliationDepth;

  @ApiProperty({
    enum: RECONCILIATION_STATUSES,
    enumName: 'ReconciliationStatus',
  })
  status!: (typeof RECONCILIATION_STATUSES)[number];

  @ApiProperty({ format: 'date-time' })
  startedAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  finishedAt!: string | null;

  @ApiProperty({ type: 'integer', minimum: 0 })
  checks!: number;

  @ApiProperty({ type: 'integer', minimum: 0 })
  issuesOpened!: number;

  @ApiProperty({ type: 'integer', minimum: 0 })
  issuesAutoResolved!: number;
}

export class ChainAlertSubjectDto {
  @ApiProperty({ example: 'COLLECTION' })
  type!: string;

  @ApiProperty()
  id!: string;
}

export class ChainAlertResolutionDto {
  @ApiProperty({ example: 'Lic. Marcos Vaca' })
  by!: string;

  @ApiProperty()
  note!: string;

  @ApiProperty({
    description: 'Cerrada sola al desaparecer su condición (p. ej. `TX_STUCK`)',
  })
  auto!: boolean;
}

export class ChainAlertDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    example: 'TOTAL_MINTED_MISMATCH',
    description:
      '`TOTAL_MINTED_MISMATCH`, `BALANCE_MISMATCH`, `OWNER_MISMATCH`, `BURN_MISMATCH`, `PAUSE_MISMATCH`, ' +
      '`ROLE_MISMATCH`, `QUOTA_EXCEEDED`, `BOTTLES_SHORTFALL`, `ANCHOR_MISMATCH`, `TX_STUCK`, `LOW_BALANCE`, ' +
      '`TTL_EXPIRING`, `UNEXPECTED_EVENT`, `INDEXER_GAP`, `NETWORK_RESET`, `CHN_INTENT_REJECTED`, `TX_FAILED`',
  })
  code!: string;

  @ApiProperty({ enum: CHAIN_ALERT_LEVELS, enumName: 'ChainAlertLevel' })
  level!: ChainAlertLevel;

  @ApiProperty({ type: () => ChainAlertSubjectDto })
  subject!: ChainAlertSubjectDto;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  wineryId!: string | null;

  @ApiProperty({ ...JSON_VALUE_SCHEMA, description: 'Lo que dice la base' })
  expected!: unknown;

  @ApiProperty({ ...JSON_VALUE_SCHEMA, description: 'Lo que dice la red' })
  actual!: unknown;

  @ApiProperty()
  message!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  runId!: string | null;

  @ApiProperty({ format: 'date-time' })
  detectedAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  resolvedAt!: string | null;

  @ApiProperty({ type: () => ChainAlertResolutionDto, nullable: true })
  resolution!: ChainAlertResolutionDto | null;
}

/** Detalle de una conciliación: con sus alertas. */
export class ReconciliationRunDetailDto extends ReconciliationRunDto {
  @ApiProperty({ type: () => ChainAlertDto, isArray: true })
  alerts!: ChainAlertDto[];
}

/** `GET /v1/platform/chain/reconciliation/runs`. */
export class ReconciliationRunsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: RECONCILIATION_STATUSES,
    enumName: 'ReconciliationStatus',
  })
  @IsOptional()
  @IsIn(RECONCILIATION_STATUSES, { message: 'Estado no válido' })
  status?: (typeof RECONCILIATION_STATUSES)[number];
}

/** `POST /v1/platform/chain/reconciliation/runs`. */
export class StartReconciliationDto {
  @ApiProperty({ enum: RECONCILIATION_SCOPES, enumName: 'ReconciliationScope' })
  @IsIn(RECONCILIATION_SCOPES, { message: 'scope no válido' })
  scope!: ReconciliationScope;

  @ApiPropertyOptional({
    description:
      'Id del contrato o de la colección (obligatorio salvo con `scope: ALL`)',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  subjectId?: string;

  @ApiPropertyOptional({
    enum: RECONCILIATION_DEPTHS,
    enumName: 'ReconciliationDepth',
    default: 'FULL',
  })
  @IsOptional()
  @IsIn(RECONCILIATION_DEPTHS, { message: 'depth no válido' })
  depth?: ReconciliationDepth;
}

/** `GET /v1/platform/chain/alerts`. */
export class ChainAlertsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ['open', 'resolved'], default: 'open' })
  @IsOptional()
  @IsIn(['open', 'resolved'], { message: 'status debe ser open o resolved' })
  status?: 'open' | 'resolved';

  @ApiPropertyOptional({
    enum: CHAIN_ALERT_LEVELS,
    enumName: 'ChainAlertLevel',
  })
  @IsOptional()
  @IsIn(CHAIN_ALERT_LEVELS, { message: 'Nivel no válido' })
  level?: ChainAlertLevel;

  @ApiPropertyOptional({ example: 'TX_STUCK' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(40)
  code?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all', { message: 'wineryId debe ser un UUID' })
  wineryId?: string;
}

/** `POST /v1/platform/chain/alerts/{id}/resolve`. */
export class ResolveChainAlertDto {
  @ApiProperty({
    minLength: 3,
    maxLength: 500,
    description: 'Qué se comprobó y cómo se resolvió (queda en la bitácora)',
  })
  @Transform(trim)
  @IsString({ message: 'note debe ser un texto' })
  @Length(3, 500, { message: 'note debe tener entre 3 y 500 caracteres' })
  note!: string;
}
