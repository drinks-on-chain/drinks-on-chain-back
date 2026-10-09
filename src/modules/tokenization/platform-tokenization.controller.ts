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
import { RequiresReason } from '@shared/audit/requires-reason';
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
  ApiRoleForbidden,
  ApiRuleErrors,
} from '@modules/chain/contract/o3-contract';
import {
  AddTokenizationNoteDto,
  ApproveTokenizationRequestDto,
  PlatformTokenizationRequestDto,
  PlatformTokenizationRequestsQueryDto,
  RequestTokenizationChangesDto,
  ReviewTokenizationRequestDto,
  TokenizationApprovalDto,
  TokenizationReasonDto,
  TokenizationRequestSummaryDto,
} from './dto/tokenization-requests.dto';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '@shared/decorators/current-user.decorator';
import { TokenizationRequestsService } from './tokenization-requests.service';

/** Bandeja en lectura: administración, operaciones y soporte. */
const READERS = platformRolesWith('tokenization', 'FULL', 'READ');
/** Tomar, anotar, completar, pedir cambios, aprobar y rechazar: administración y operaciones. */
const REVIEWERS = platformRolesWith('tokenization', 'FULL');

const REQUEST_NOT_FOUND = () =>
  ApiErrorCodes(HttpStatus.NOT_FOUND, ['TOK_REQUEST_NOT_FOUND']);
const INVALID_TRANSITION =
  'TOK_REQUEST_INVALID_TRANSITION (`meta.from`, `meta.to`)';

/**
 * Back office · bandeja de tokenización (contrato O3 §5.4; TOK-02…05). La
 * cantidad la autoriza la bodega; operaciones revisa, completa los datos
 * comerciales y el precio, y aprueba, pide cambios o rechaza.
 */
@ApiTags('Tokenization')
@ApiBearerAuth()
@Audience('STAFF')
@OrgType('PLATFORM')
@Controller('platform/tokenization-requests')
export class PlatformTokenizationController {
  constructor(private readonly requests: TokenizationRequestsService) {}

  @Get()
  @Roles(...READERS)
  @ApiOperation({
    summary: 'Bandeja de solicitudes de tokenización',
    description:
      'Contrato O3 §5.4: por defecto, los estados abiertos (`SUBMITTED`, `IN_REVIEW`, `CHANGES_REQUESTED`), por ' +
      'antigüedad. Filtros: `status`, `kind`, `wineryId`, `assigneeId` y `q`.',
  })
  @ApiPaginatedResponse(TokenizationRequestSummaryDto)
  @ApiRoleForbidden()
  list(
    @Query() query: PlatformTokenizationRequestsQueryDto,
  ): Promise<Paginated<TokenizationRequestSummaryDto>> {
    return this.requests.platformList(query);
  }

  @Get(':id')
  @Roles(...READERS)
  @ApiOperation({
    summary: 'Solicitud con su revisión',
    description:
      'Contrato O3 §5.4: la solicitud con las notas internas, la sugerencia de precio y `review` (el lote en ' +
      'lectura, sus candados, la fecha estimada, la D.O., las incidencias, los límites recalculados, la ' +
      'identidad de la bodega en la red y sus otras colecciones).',
  })
  @ApiOkResponse({ type: PlatformTokenizationRequestDto })
  @ApiRoleForbidden()
  @REQUEST_NOT_FOUND()
  get(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PlatformTokenizationRequestDto> {
    return this.requests.platformGet(id);
  }

  @Post(':id/take')
  @HttpCode(HttpStatus.OK)
  @Roles(...REVIEWERS)
  @ApiOperation({
    summary: 'Tomar una solicitud',
    description:
      'Contrato O3 §5.4: `SUBMITTED → IN_REVIEW`, asignada a quien la toma. Sin cuerpo.',
  })
  @ApiOkResponse({ type: PlatformTokenizationRequestDto })
  @ApiRoleForbidden()
  @REQUEST_NOT_FOUND()
  @ApiErrorCodes(HttpStatus.CONFLICT, [INVALID_TRANSITION])
  take(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PlatformTokenizationRequestDto> {
    return this.requests.take(id, user.id);
  }

  @Post(':id/notes')
  @HttpCode(HttpStatus.CREATED)
  @Roles(...REVIEWERS)
  @ApiOperation({
    summary: 'Añadir una nota interna',
    description: 'Contrato O3 §5.4: no la ve la bodega.',
  })
  @ApiCreatedResponse({ type: PlatformTokenizationRequestDto })
  @ApiRoleForbidden()
  @REQUEST_NOT_FOUND()
  @ApiRuleErrors()
  addNote(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddTokenizationNoteDto,
  ): Promise<PlatformTokenizationRequestDto> {
    return this.requests.addNote(id, user.id, dto);
  }

  @Patch(':id')
  @Roles(...REVIEWERS)
  @ApiOperation({
    summary: 'Completar los datos comerciales y el precio',
    description:
      'Contrato O3 §5.4 y §5.5: en `IN_REVIEW`, antes de aprobar. `price: null` lo deja sin precio (A-32).',
  })
  @ApiOkResponse({ type: PlatformTokenizationRequestDto })
  @ApiRoleForbidden()
  @REQUEST_NOT_FOUND()
  @ApiErrorCodes(HttpStatus.CONFLICT, [INVALID_TRANSITION, 'TOK_SLUG_TAKEN'])
  @ApiRuleErrors(['TOK_PRICE_INVALID'])
  review(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewTokenizationRequestDto,
  ): Promise<PlatformTokenizationRequestDto> {
    return this.requests.review(id, user.id, dto);
  }

  @Post(':id/request-changes')
  @HttpCode(HttpStatus.OK)
  @Roles(...REVIEWERS)
  @ApiOperation({
    summary: 'Pedir cambios a la bodega',
    description:
      'Contrato O3 §5.4: `IN_REVIEW → CHANGES_REQUESTED`; correo al dueño con el mensaje.',
  })
  @ApiOkResponse({ type: PlatformTokenizationRequestDto })
  @ApiRoleForbidden()
  @REQUEST_NOT_FOUND()
  @ApiErrorCodes(HttpStatus.CONFLICT, [INVALID_TRANSITION])
  @ApiRuleErrors()
  requestChanges(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RequestTokenizationChangesDto,
  ): Promise<PlatformTokenizationRequestDto> {
    return this.requests.requestChanges(id, user.id, dto);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.CREATED)
  @Roles(...REVIEWERS)
  @Idempotent({ required: true })
  @ApiOperation({
    summary: 'Aprobar una solicitud',
    description:
      'Contrato O3 §5.4 y §6.1: `IN_REVIEW → APPROVED`. Crea la colección (o amplía su cuota) y la emisión: ' +
      'una intención `MINT_BATCH` por cada trozo de hasta 32 000, que el worker envía a la red. La cuota se ' +
      'revalida con los datos de ese momento. Con `CHAIN_MINT_ENABLED=false` la emisión queda `PENDING` ' +
      '(`lastError.code = CHN_MINT_DISABLED`). `Idempotency-Key` obligatoria: dos aprobaciones en paralelo ' +
      'crean una sola colección y una sola emisión.',
  })
  @ApiCreatedResponse({ type: TokenizationApprovalDto })
  @ApiRoleForbidden()
  @REQUEST_NOT_FOUND()
  @ApiErrorCodes(HttpStatus.CONFLICT, [
    INVALID_TRANSITION,
    'TOK_WINERY_NOT_ACTIVE (`meta.status`)',
    'TOK_WINERY_CHAIN_NOT_READY (`meta.status`)',
    'TOK_LOT_NOT_TOKENIZABLE',
    'TOK_SLUG_TAKEN',
    'CHN_CONTRACT_PAUSED',
    'IDEMPOTENCY_KEY_REUSED',
    'IDEMPOTENCY_IN_PROGRESS',
  ])
  @ApiRuleErrors([
    'IDEMPOTENCY_KEY_REQUIRED',
    'TOK_COMMERCIAL_DATA_INCOMPLETE (un detalle por campo: `name`, `description`, imagen de portada)',
    'TOK_PRICE_INVALID',
    'TOK_QUOTA_EXCEEDS_ESTIMATE',
    'TOK_QUOTA_EXCEEDS_BOTTLES',
    'TOK_LOT_ESTIMATE_MISSING',
    'TOK_LOT_PRODUCT_UNDEFINED',
  ])
  approve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveTokenizationRequestDto,
  ): Promise<TokenizationApprovalDto> {
    return this.requests.approve(id, user.id, dto);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @Roles(...REVIEWERS)
  @RequiresReason()
  @ApiOperation({
    summary: 'Rechazar una solicitud',
    description:
      'Contrato O3 §5.4: `→ REJECTED` con motivo; correo al dueño con el motivo.',
  })
  @ApiOkResponse({ type: PlatformTokenizationRequestDto })
  @ApiRoleForbidden()
  @REQUEST_NOT_FOUND()
  @ApiErrorCodes(HttpStatus.CONFLICT, [INVALID_TRANSITION])
  @ApiRuleErrors(['(falta `reason`)'])
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TokenizationReasonDto,
  ): Promise<PlatformTokenizationRequestDto> {
    return this.requests.reject(id, user.id, dto);
  }
}
