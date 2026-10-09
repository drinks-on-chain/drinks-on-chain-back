import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { ApiPaginatedResponse } from '@shared/decorators/api-paginated-response.decorator';
import { RequiresReason } from '@shared/audit/requires-reason';
import { PaginationQueryDto } from '@shared/dto/pagination-query.dto';
import { Idempotent } from '@shared/idempotency/idempotent.decorator';
import type { Paginated } from '@shared/interfaces/api-response.interface';
import {
  Audience,
  OrgType,
  Roles,
} from '@modules/auth/decorators/authorization.decorators';
import { platformRolesWith } from '@modules/platform-users/permissions';
import {
  ApiErrorCodes,
  ApiNotImplementedO3,
  ApiRoleForbidden,
  ApiRuleErrors,
  notImplementedO3,
} from '@modules/chain/contract/o3-contract';
import { ChainTxRefDto } from '@modules/chain/dto/chain-common.dto';
import {
  CollectionDto,
  CollectionMetricsDto,
  CollectionOptionalReasonDto,
  CollectionReasonDto,
  CollectionSummaryDto,
  DecideLotClosureDto,
  LotClosureDto,
  LotClosureSummaryDto,
  LotClosuresQueryDto,
  PlatformCollectionsQueryDto,
  ResolveLotClosureItemDto,
  TokenDto,
  TokensQueryDto,
  UpdateCollectionDto,
} from './dto/collections.dto';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '@shared/decorators/current-user.decorator';
import { CollectionsService } from './collections.service';

/** Ver: administración, operaciones y soporte. */
const READERS = platformRolesWith('tokenization', 'FULL', 'READ');
/** Editar, publicar, pausar, reanudar, cerrar y resolver ítems del cierre. */
const OPERATORS = platformRolesWith('tokenization', 'FULL');

const COLLECTION_NOT_FOUND = () =>
  ApiErrorCodes(HttpStatus.NOT_FOUND, ['TOK_COLLECTION_NOT_FOUND']);
const INVALID_TRANSITION =
  'TOK_COLLECTION_INVALID_TRANSITION (`meta.from`, `meta.to`)';
const IDEMPOTENCY = ['IDEMPOTENCY_KEY_REUSED', 'IDEMPOTENCY_IN_PROGRESS'];
const PUBLISH_CONFLICTS = [
  INVALID_TRANSITION,
  'TOK_MINT_NOT_CONFIRMED (`meta.mintStatus`)',
  'TOK_WINERY_NOT_ACTIVE (`meta.status`)',
  'CHN_CONTRACT_PAUSED',
  ...IDEMPOTENCY,
];

/**
 * Back office · colecciones (contrato O3 §6.4, §8.4 y §8.5; TOK-06…08,
 * TOK-10, TOK-11). Ampliar la cuota no es una acción de esta pantalla: la
 * pide la bodega (`QUOTA_INCREASE`) y se aprueba en la bandeja (S-14).
 */
@ApiTags('Tokenization')
@ApiBearerAuth()
@Audience('STAFF')
@OrgType('PLATFORM')
@Controller('platform/collections')
export class PlatformCollectionsController {
  constructor(private readonly collections: CollectionsService) {}

  @Get()
  @Roles(...READERS)
  @ApiOperation({
    summary: 'Colecciones',
    description:
      'Contrato O3 §6.4. Filtros: `status`, `saleState`, `wineryId`, `mintStatus` y `q`. Orden `-createdAt`.',
  })
  @ApiPaginatedResponse(CollectionSummaryDto)
  @ApiRoleForbidden()
  list(
    @Query() query: PlatformCollectionsQueryDto,
  ): Promise<Paginated<CollectionSummaryDto>> {
    return this.collections.platformList(query);
  }

  @Get(':id')
  @Roles(...READERS)
  @ApiOperation({ summary: 'Una colección', description: 'Contrato O3 §6.2.' })
  @ApiOkResponse({ type: CollectionDto })
  @ApiRoleForbidden()
  @COLLECTION_NOT_FOUND()
  get(@Param('id', ParseUUIDPipe) id: string): Promise<CollectionDto> {
    return this.collections.get(undefined, id);
  }

  @Patch(':id')
  @Roles(...OPERATORS)
  @RequiresReason()
  @ApiOperation({
    summary: 'Editar datos comerciales, precio o fecha de canje',
    description:
      'Contrato O3 §6.4: con motivo; el precio queda en `priceHistory`. El `slug` no cambia una vez publicada.',
  })
  @ApiOkResponse({ type: CollectionDto })
  @ApiRoleForbidden()
  @COLLECTION_NOT_FOUND()
  @ApiErrorCodes(HttpStatus.CONFLICT, [
    'TOK_PRICE_LOCKED (cambio de precio con ventas, Ola 4)',
    'TOK_SLUG_TAKEN',
    INVALID_TRANSITION,
  ])
  @ApiRuleErrors([
    '(falta `reason`)',
    'TOK_PRICE_INVALID',
    'TOK_COMMERCIAL_DATA_INCOMPLETE (imágenes sin portada)',
  ])
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCollectionDto,
  ): Promise<CollectionDto> {
    return this.collections.update(id, user.id, dto);
  }

  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  @Roles(...OPERATORS)
  @Idempotent({ required: true })
  @ApiOperation({
    summary: 'Publicar la colección',
    description:
      'Contrato O3 §6.4: `READY → PUBLISHED` (preventa hasta el anclaje). Exige las emisiones confirmadas, los ' +
      'datos comerciales completos, la bodega `ACTIVE` y el contrato sin pausar. Las imágenes pasan a servirse ' +
      'en `GET /v1/public/collections/images/{id}`. `Idempotency-Key` obligatoria.',
  })
  @ApiOkResponse({ type: CollectionDto })
  @ApiRoleForbidden()
  @COLLECTION_NOT_FOUND()
  @ApiErrorCodes(HttpStatus.CONFLICT, PUBLISH_CONFLICTS)
  @ApiRuleErrors([
    'IDEMPOTENCY_KEY_REQUIRED',
    'TOK_COMMERCIAL_DATA_INCOMPLETE (un detalle por campo)',
  ])
  publish(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CollectionOptionalReasonDto,
  ): Promise<CollectionDto> {
    return this.collections.publish(id, user.id, dto);
  }

  @Post(':id/pause')
  @HttpCode(HttpStatus.OK)
  @Roles(...OPERATORS)
  @Idempotent({ required: true })
  @RequiresReason()
  @ApiOperation({
    summary: 'Pausar la colección (pausa comercial)',
    description:
      'Contrato O3 §6.4: `PUBLISHED → PAUSED`. No toca la red. `Idempotency-Key` obligatoria.',
  })
  @ApiOkResponse({ type: CollectionDto })
  @ApiRoleForbidden()
  @COLLECTION_NOT_FOUND()
  @ApiErrorCodes(HttpStatus.CONFLICT, [INVALID_TRANSITION, ...IDEMPOTENCY])
  @ApiRuleErrors(['IDEMPOTENCY_KEY_REQUIRED', '(falta `reason`)'])
  pause(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CollectionReasonDto,
  ): Promise<CollectionDto> {
    return this.collections.pause(id, user.id, dto);
  }

  @Post(':id/resume')
  @HttpCode(HttpStatus.OK)
  @Roles(...OPERATORS)
  @Idempotent({ required: true })
  @ApiOperation({
    summary: 'Reanudar la colección',
    description:
      'Contrato O3 §6.4: `PAUSED → PUBLISHED`, con las mismas condiciones que publicar. `Idempotency-Key` ' +
      'obligatoria.',
  })
  @ApiOkResponse({ type: CollectionDto })
  @ApiRoleForbidden()
  @COLLECTION_NOT_FOUND()
  @ApiErrorCodes(HttpStatus.CONFLICT, PUBLISH_CONFLICTS)
  @ApiRuleErrors([
    'IDEMPOTENCY_KEY_REQUIRED',
    'TOK_COMMERCIAL_DATA_INCOMPLETE (un detalle por campo)',
  ])
  resume(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CollectionOptionalReasonDto,
  ): Promise<CollectionDto> {
    return this.collections.resume(id, user.id, dto);
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @Roles(...OPERATORS)
  @RequiresReason()
  @ApiOperation({
    summary: 'Cerrar la colección',
    description:
      'Contrato O3 §6.4: `READY`, `PUBLISHED` o `PAUSED → CLOSED` (no se vende más), con el cierre del lote ' +
      'resuelto.',
  })
  @ApiOkResponse({ type: CollectionDto })
  @ApiRoleForbidden()
  @COLLECTION_NOT_FOUND()
  @ApiErrorCodes(HttpStatus.CONFLICT, [
    INVALID_TRANSITION,
    'TOK_CLOSURE_PENDING (`meta.closureStatus`)',
  ])
  @ApiRuleErrors(['(falta `reason`)'])
  close(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CollectionReasonDto,
  ): Promise<CollectionDto> {
    return this.collections.close(id, user.id, dto);
  }

  @Get(':id/tokens')
  @Roles(...READERS)
  @ApiOperation({
    summary: 'NFT de una colección',
    description: 'Contrato O3 §6.3. Orden por número de botella.',
  })
  @ApiPaginatedResponse(TokenDto)
  @ApiRoleForbidden()
  @COLLECTION_NOT_FOUND()
  listTokens(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: TokensQueryDto,
  ): Promise<Paginated<TokenDto>> {
    return this.collections.tokens(undefined, id, query);
  }

  @Get(':id/transactions')
  @Roles(...READERS)
  @ApiOperation({
    summary: 'Transacciones de una colección',
    description:
      'Contrato O3 §6.4: emisiones y quemas, las más recientes primero. Paginada como toda colección de la API.',
  })
  @ApiPaginatedResponse(ChainTxRefDto)
  @ApiRoleForbidden()
  @COLLECTION_NOT_FOUND()
  listTransactions(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: PaginationQueryDto,
  ): Promise<Paginated<ChainTxRefDto>> {
    return this.collections.transactions(id, query);
  }

  @Get(':id/metrics')
  @Roles(...READERS)
  @ApiOperation({
    summary: 'Métricas de una colección',
    description:
      'Contrato O3 §8.5: NFT por estado, cuota frente a la estimación, fechas y lo pagado en la red.',
  })
  @ApiOkResponse({ type: CollectionMetricsDto })
  @ApiRoleForbidden()
  @COLLECTION_NOT_FOUND()
  metrics(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CollectionMetricsDto> {
    return this.collections.metrics(id);
  }

  // ── Cierre del lote con faltante (§8.4) ──────────────────────────────────

  @Get(':id/closure')
  @Roles(...READERS)
  @ApiOperation({
    summary: 'Cierre del lote de una colección',
    description:
      'Contrato O3 §8.4: botellas frente a NFT, faltante y los NFT afectados (primero los no vendidos con ' +
      'número de botella más alto; después los vendidos, desde el pedido pagado más reciente).',
  })
  @ApiOkResponse({ type: LotClosureDto })
  @ApiRoleForbidden()
  @COLLECTION_NOT_FOUND()
  @ApiErrorCodes(HttpStatus.CONFLICT, [
    'TOK_CLOSURE_NOT_APPLICABLE (lote sin embotellar ni descartar; `meta.stage`)',
  ])
  @ApiNotImplementedO3('3.6')
  closure(@Param('id', ParseUUIDPipe) _id: string): Promise<LotClosureDto> {
    throw notImplementedO3('3.6');
  }

  @Post(':id/closure/decide')
  @HttpCode(HttpStatus.OK)
  @Roles(...OPERATORS)
  @Idempotent({ required: true })
  @RequiresReason()
  @ApiOperation({
    summary: 'Decidir el cierre',
    description:
      'Contrato O3 §8.4: cierre `DECIDED`; encola las quemas (`BURN_UNSOLD`). **Con quemas (faltante o ' +
      '`unsoldPolicy: BURN`) solo decide administración**; operaciones solo puede `KEEP_ON_SALE` sin faltante. ' +
      '`Idempotency-Key` obligatoria.',
  })
  @ApiOkResponse({ type: LotClosureDto })
  @ApiErrorCodes(HttpStatus.FORBIDDEN, [
    'AUTH_INSUFFICIENT_PERMISSIONS (rol; o una decisión con quemas sin ser administración)',
  ])
  @COLLECTION_NOT_FOUND()
  @ApiErrorCodes(HttpStatus.CONFLICT, [
    'TOK_CLOSURE_NOT_APPLICABLE',
    'CONFLICT (cierre ya decidido)',
    ...IDEMPOTENCY,
  ])
  @ApiRuleErrors(['IDEMPOTENCY_KEY_REQUIRED', '(falta `reason`)'])
  @ApiNotImplementedO3('3.6')
  decideClosure(
    @Param('id', ParseUUIDPipe) _id: string,
    @Body() _dto: DecideLotClosureDto,
  ): Promise<LotClosureDto> {
    throw notImplementedO3('3.6');
  }

  @Post(':id/closure/items/:tokenId/resolve')
  @HttpCode(HttpStatus.OK)
  @Roles(...OPERATORS)
  @ApiOperation({
    summary: 'Resolver un NFT vendido sin botella',
    description:
      'Contrato O3 §8.4 (A-30, proceso manual del MVP): devolución o sustitución, ítem a ítem. El cierre pasa ' +
      'a `RESOLVED` cuando no queda ningún ítem `PENDING` ni quema sin confirmar.',
  })
  @ApiParam({
    name: 'tokenId',
    schema: { type: 'integer', minimum: 0 },
    description: 'Id del token en la red',
  })
  @ApiOkResponse({ type: LotClosureDto })
  @ApiRoleForbidden()
  @ApiErrorCodes(HttpStatus.NOT_FOUND, [
    'TOK_COLLECTION_NOT_FOUND',
    'NOT_FOUND (el token no es un ítem del cierre)',
  ])
  @ApiErrorCodes(HttpStatus.CONFLICT, ['CONFLICT (ítem ya resuelto)'])
  @ApiRuleErrors()
  @ApiNotImplementedO3('3.6')
  resolveClosureItem(
    @Param('id', ParseUUIDPipe) _id: string,
    @Param('tokenId', ParseIntPipe) _tokenId: number,
    @Body() _dto: ResolveLotClosureItemDto,
  ): Promise<LotClosureDto> {
    throw notImplementedO3('3.6');
  }
}

/** Back office · cierres con faltante de todas las bodegas (§8.4). */
@ApiTags('Tokenization')
@ApiBearerAuth()
@Audience('STAFF')
@OrgType('PLATFORM')
@Controller('platform/lot-closures')
export class PlatformLotClosuresController {
  @Get()
  @Roles(...READERS)
  @ApiOperation({
    summary: 'Cierres de lote',
    description:
      'Contrato O3 §8.4: sin los NFT afectados (el detalle, en `GET /v1/platform/collections/{id}/closure`). ' +
      'Filtros: `status` y `wineryId`.',
  })
  @ApiPaginatedResponse(LotClosureSummaryDto)
  @ApiRoleForbidden()
  @ApiNotImplementedO3('3.6')
  list(
    @Query() _query: LotClosuresQueryDto,
  ): Promise<Paginated<LotClosureSummaryDto>> {
    throw notImplementedO3('3.6');
  }
}
