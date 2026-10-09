import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiPaginatedResponse } from '@shared/decorators/api-paginated-response.decorator';
import { TenantId } from '@shared/decorators/tenant-id.decorator';
import { Idempotent } from '@shared/idempotency/idempotent.decorator';
import type { Paginated } from '@shared/interfaces/api-response.interface';
import {
  OrgType,
  PlatformReadOnly,
  RequireActiveOrg,
  Roles,
} from '@modules/auth/decorators/authorization.decorators';
import {
  ApiErrorCodes,
  ApiNotImplementedO3,
  ApiRuleErrors,
  WINERY_TOKENIZATION_READERS,
  WINERY_TOKEN_READERS,
  notImplementedO3,
} from '@modules/chain/contract/o3-contract';
import {
  CollectionDto,
  CollectionSummaryDto,
  CollectionsQueryDto,
  TokenDto,
  TokensQueryDto,
  WineryLotClosureDto,
} from './dto/collections.dto';
import {
  CreateTokenizationRequestDto,
  LotTokenizationStatusDto,
  ResubmitTokenizationRequestDto,
  TokenizationReasonDto,
  TokenizationRequestDto,
  TokenizationRequestSummaryDto,
  TokenizationRequestsQueryDto,
  UpdateTokenizationRequestDto,
} from './dto/tokenization-requests.dto';

const FORBIDDEN = () =>
  ApiErrorCodes(HttpStatus.FORBIDDEN, [
    'AUTH_INSUFFICIENT_PERMISSIONS (rol)',
    'ORG_NOT_ACTIVE',
  ]);
const OWNER_ONLY = () =>
  ApiErrorCodes(HttpStatus.FORBIDDEN, [
    'AUTH_INSUFFICIENT_PERMISSIONS (solo el dueño)',
    'ORG_NOT_ACTIVE',
    'TRC_PLATFORM_READ_ONLY (la cantidad la autoriza la bodega, A-03: la plataforma no escribe aquí)',
  ]);
const REQUEST_NOT_FOUND = () =>
  ApiErrorCodes(HttpStatus.NOT_FOUND, ['TOK_REQUEST_NOT_FOUND']);
const COLLECTION_NOT_FOUND = () =>
  ApiErrorCodes(HttpStatus.NOT_FOUND, ['TOK_COLLECTION_NOT_FOUND']);

const QUOTA_RULES = [
  'TOK_LOT_PRODUCT_UNDEFINED',
  'TOK_LOT_ESTIMATE_MISSING',
  'TOK_QUOTA_INVALID',
  'TOK_QUOTA_EXCEEDS_ESTIMATE (`expected`, `actual`, `meta.maxQuantity`)',
  'TOK_QUOTA_EXCEEDS_BOTTLES (`expected`, `actual`, `meta.maxQuantity`)',
] as const;

/**
 * ERP · tokenización del lote (contrato O3 §5.3; TOK-01, TOK-08). Solo el
 * dueño autoriza, edita, reenvía y retira; el resto de miembros con acceso
 * (enología y contabilidad) lee. La plataforma lee con `?wineryId=` y no
 * escribe: la cantidad la autoriza la bodega (A-03).
 */
@ApiTags('Tokenization')
@ApiBearerAuth()
@OrgType('WINERY')
@RequireActiveOrg()
@PlatformReadOnly()
@Controller()
export class ErpTokenizationController {
  @Get('lots/:id/tokenization')
  @Roles(...WINERY_TOKENIZATION_READERS)
  @ApiOperation({
    summary: 'Estado de tokenización de un lote',
    description:
      'Contrato O3 §5.3: si se puede enviar una solicitud ahora (`tokenizable`), por qué no (`blockers` con ' +
      'código `TOK_…`), los límites (estimación o botellas, cuota autorizada y lo que queda), la solicitud ' +
      'abierta, la colección y el historial. La UI decide con esto si muestra "Autorizar tokenización".',
  })
  @ApiOkResponse({ type: LotTokenizationStatusDto })
  @FORBIDDEN()
  @ApiErrorCodes(HttpStatus.NOT_FOUND, ['TRC_LOT_NOT_FOUND'])
  @ApiNotImplementedO3('3.3')
  lotTokenization(
    @TenantId() _wineryId: string | undefined,
    @Param('id', ParseUUIDPipe) _id: string,
  ): Promise<LotTokenizationStatusDto> {
    throw notImplementedO3('3.3');
  }

  @Post('lots/:id/tokenization-requests')
  @HttpCode(HttpStatus.CREATED)
  @Roles('OWNER')
  @Idempotent({ required: true })
  @ApiOperation({
    summary: 'Autorizar la tokenización de un lote',
    description:
      'Contrato O3 §5.2 y §5.3: el dueño autoriza `quantity` botellas (la cuota si el lote no tiene colección; ' +
      'las adicionales si la tiene: `QUOTA_INCREASE`). Antes del embotellado el límite es la estimación del ' +
      'lote; después, los códigos de botella activos. Una sola solicitud abierta por lote. Con ' +
      '`tokenizacion.requiereAprobacion = false` se aprueba sola si los datos están completos (S-11). ' +
      '`Idempotency-Key` obligatoria.',
  })
  @ApiCreatedResponse({ type: TokenizationRequestDto })
  @OWNER_ONLY()
  @ApiErrorCodes(HttpStatus.NOT_FOUND, ['TRC_LOT_NOT_FOUND'])
  @ApiErrorCodes(HttpStatus.CONFLICT, [
    'TOK_LOT_NOT_TOKENIZABLE (`CERTIFIED`, `ANCHORED`, `REJECTED` o `DISCARDED`; `meta.stage`)',
    'TOK_REQUEST_ALREADY_OPEN (`meta.requestId`)',
    'IDEMPOTENCY_KEY_REUSED',
    'IDEMPOTENCY_IN_PROGRESS',
  ])
  @ApiRuleErrors(['IDEMPOTENCY_KEY_REQUIRED', ...QUOTA_RULES])
  @ApiNotImplementedO3('3.3')
  create(
    @TenantId() _wineryId: string,
    @Param('id', ParseUUIDPipe) _id: string,
    @Body() _dto: CreateTokenizationRequestDto,
  ): Promise<TokenizationRequestDto> {
    throw notImplementedO3('3.3');
  }

  @Get('tokenization-requests')
  @Roles(...WINERY_TOKENIZATION_READERS)
  @ApiOperation({
    summary: 'Solicitudes de tokenización de la bodega',
    description: 'Contrato O3 §5.3. Orden `-submittedAt`.',
  })
  @ApiPaginatedResponse(TokenizationRequestSummaryDto)
  @FORBIDDEN()
  @ApiNotImplementedO3('3.3')
  list(
    @TenantId() _wineryId: string | undefined,
    @Query() _query: TokenizationRequestsQueryDto,
  ): Promise<Paginated<TokenizationRequestSummaryDto>> {
    throw notImplementedO3('3.3');
  }

  @Get('tokenization-requests/:id')
  @Roles(...WINERY_TOKENIZATION_READERS)
  @ApiOperation({
    summary: 'Una solicitud de tokenización',
    description:
      'Contrato O3 §5.1: sin las notas internas ni la sugerencia de precio del back office.',
  })
  @ApiOkResponse({ type: TokenizationRequestDto })
  @FORBIDDEN()
  @REQUEST_NOT_FOUND()
  @ApiNotImplementedO3('3.3')
  get(
    @TenantId() _wineryId: string | undefined,
    @Param('id', ParseUUIDPipe) _id: string,
  ): Promise<TokenizationRequestDto> {
    throw notImplementedO3('3.3');
  }

  @Patch('tokenization-requests/:id')
  @Roles('OWNER')
  @ApiOperation({
    summary: 'Editar una solicitud',
    description:
      'Contrato O3 §5.3: solo en `CHANGES_REQUESTED` (o en `SUBMITTED` antes de que operaciones la tome).',
  })
  @ApiOkResponse({ type: TokenizationRequestDto })
  @OWNER_ONLY()
  @REQUEST_NOT_FOUND()
  @ApiErrorCodes(HttpStatus.CONFLICT, [
    'TOK_REQUEST_INVALID_TRANSITION (`meta.from`, `meta.to`)',
    'TOK_LOT_NOT_TOKENIZABLE',
  ])
  @ApiRuleErrors(QUOTA_RULES)
  @ApiNotImplementedO3('3.3')
  update(
    @TenantId() _wineryId: string,
    @Param('id', ParseUUIDPipe) _id: string,
    @Body() _dto: UpdateTokenizationRequestDto,
  ): Promise<TokenizationRequestDto> {
    throw notImplementedO3('3.3');
  }

  @Post('tokenization-requests/:id/resubmit')
  @HttpCode(HttpStatus.OK)
  @Roles('OWNER')
  @Idempotent({ required: true })
  @ApiOperation({
    summary: 'Reenviar una solicitud tras los cambios pedidos',
    description:
      'Contrato O3 §5.3: `CHANGES_REQUESTED → SUBMITTED`; marca las peticiones de cambio como resueltas y ' +
      'avisa a operaciones. `Idempotency-Key` obligatoria.',
  })
  @ApiOkResponse({ type: TokenizationRequestDto })
  @OWNER_ONLY()
  @REQUEST_NOT_FOUND()
  @ApiErrorCodes(HttpStatus.CONFLICT, [
    'TOK_REQUEST_INVALID_TRANSITION (`meta.from`, `meta.to`)',
    'IDEMPOTENCY_KEY_REUSED',
    'IDEMPOTENCY_IN_PROGRESS',
  ])
  @ApiRuleErrors(['IDEMPOTENCY_KEY_REQUIRED', ...QUOTA_RULES])
  @ApiNotImplementedO3('3.3')
  resubmit(
    @TenantId() _wineryId: string,
    @Param('id', ParseUUIDPipe) _id: string,
    @Body() _dto: ResubmitTokenizationRequestDto,
  ): Promise<TokenizationRequestDto> {
    throw notImplementedO3('3.3');
  }

  @Post('tokenization-requests/:id/withdraw')
  @HttpCode(HttpStatus.OK)
  @Roles('OWNER')
  @ApiOperation({
    summary: 'Retirar una solicitud',
    description:
      'Contrato O3 §5.3: `→ WITHDRAWN` desde cualquier estado abierto, con motivo.',
  })
  @ApiOkResponse({ type: TokenizationRequestDto })
  @OWNER_ONLY()
  @REQUEST_NOT_FOUND()
  @ApiErrorCodes(HttpStatus.CONFLICT, [
    'TOK_REQUEST_INVALID_TRANSITION (`meta.from`, `meta.to`)',
  ])
  @ApiRuleErrors(['(falta `reason`)'])
  @ApiNotImplementedO3('3.3')
  withdraw(
    @TenantId() _wineryId: string,
    @Param('id', ParseUUIDPipe) _id: string,
    @Body() _dto: TokenizationReasonDto,
  ): Promise<TokenizationRequestDto> {
    throw notImplementedO3('3.3');
  }

  // ── Colecciones de la bodega ─────────────────────────────────────────────

  @Get('collections')
  @Roles(...WINERY_TOKENIZATION_READERS)
  @ApiOperation({
    summary: 'Colecciones de la bodega',
    description: 'Contrato O3 §5.3 y §6.2. Orden `-createdAt`.',
  })
  @ApiPaginatedResponse(CollectionSummaryDto)
  @FORBIDDEN()
  @ApiNotImplementedO3('3.4')
  listCollections(
    @TenantId() _wineryId: string | undefined,
    @Query() _query: CollectionsQueryDto,
  ): Promise<Paginated<CollectionSummaryDto>> {
    throw notImplementedO3('3.4');
  }

  @Get('collections/:id')
  @Roles(...WINERY_TOKENIZATION_READERS)
  @ApiOperation({
    summary: 'Una colección de la bodega',
    description:
      'Contrato O3 §6.2: datos comerciales, emisiones con sus transacciones, historial de cuota y de estado, ' +
      'anclaje, cierre y métricas. Las órdenes de compra del cierre no se muestran a la bodega.',
  })
  @ApiOkResponse({ type: CollectionDto })
  @FORBIDDEN()
  @COLLECTION_NOT_FOUND()
  @ApiNotImplementedO3('3.4')
  getCollection(
    @TenantId() _wineryId: string | undefined,
    @Param('id', ParseUUIDPipe) _id: string,
  ): Promise<CollectionDto> {
    throw notImplementedO3('3.4');
  }

  @Get('collections/:id/tokens')
  @Roles(...WINERY_TOKEN_READERS)
  @ApiOperation({
    summary: 'NFT de una colección',
    description:
      'Contrato O3 §5.3 y §6.3: dueño y contabilidad. Sin datos del consumidor: solo `owner.kind` y la ' +
      'dirección. Orden por número de botella.',
  })
  @ApiPaginatedResponse(TokenDto)
  @FORBIDDEN()
  @COLLECTION_NOT_FOUND()
  @ApiNotImplementedO3('3.4')
  listTokens(
    @TenantId() _wineryId: string | undefined,
    @Param('id', ParseUUIDPipe) _id: string,
    @Query() _query: TokensQueryDto,
  ): Promise<Paginated<TokenDto>> {
    throw notImplementedO3('3.4');
  }

  @Get('collections/:id/closure')
  @Roles(...WINERY_TOKEN_READERS)
  @ApiOperation({
    summary: 'Cierre del lote con faltante (lectura de la bodega)',
    description:
      'Contrato O3 §8.4: cifras y números de botella afectados, sin datos de pedidos.',
  })
  @ApiOkResponse({ type: WineryLotClosureDto })
  @FORBIDDEN()
  @COLLECTION_NOT_FOUND()
  @ApiErrorCodes(HttpStatus.CONFLICT, [
    'TOK_CLOSURE_NOT_APPLICABLE (lote sin embotellar ni descartar; `meta.stage`)',
  ])
  @ApiNotImplementedO3('3.6')
  closure(
    @TenantId() _wineryId: string | undefined,
    @Param('id', ParseUUIDPipe) _id: string,
  ): Promise<WineryLotClosureDto> {
    throw notImplementedO3('3.6');
  }
}
