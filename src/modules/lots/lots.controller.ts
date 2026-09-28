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
  ApiExtraModels,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  CurrentUser,
  AuthenticatedUser,
} from '@shared/decorators/current-user.decorator';
import { TenantId } from '@shared/decorators/tenant-id.decorator';
import { ApiPaginatedResponse } from '@shared/decorators/api-paginated-response.decorator';
import { Idempotent } from '@shared/idempotency/idempotent.decorator';
import { ApiErrorResponseDto } from '@shared/dto/api-error-response.dto';
import {
  OrgType,
  PlatformReadOnly,
  RequireActiveOrg,
  Roles,
} from '@modules/auth/decorators/authorization.decorators';
import { LotsService } from './lots.service';
import {
  CreateLotDto,
  DiscardLotDto,
  LabLimitDto,
  LotDto,
  LotSummaryDto,
  QueryLotsDto,
  UpdateLotDto,
} from './dto/lot.dto';

const LOT_READERS = [
  'OWNER',
  'ENOLOGIST',
  'AGRONOMIST',
  'OPERATOR',
  'ACCOUNTANT',
] as const;

@ApiTags('Lotes (Ola 2)')
@ApiBearerAuth()
@ApiExtraModels(LabLimitDto)
@OrgType('WINERY')
@RequireActiveOrg()
@PlatformReadOnly()
@Controller('lots')
export class LotsController {
  constructor(private readonly lots: LotsService) {}

  @Get()
  @Roles(...LOT_READERS)
  @ApiOperation({
    summary: 'Listar lotes de la bodega',
    description:
      'Lista de `LotSummary` ordenada por `-updatedAt` (contrato O2 §2.5). `stage` admite varias etapas separadas por coma; `q` busca en nombre, referencia y código de lote. La plataforma lee con `?wineryId=`.',
  })
  @ApiPaginatedResponse(LotSummaryDto, { description: 'Página de lotes' })
  list(@TenantId() wineryId: string | undefined, @Query() query: QueryLotsDto) {
    return this.lots.list(wineryId, query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @Roles('OWNER', 'ENOLOGIST')
  @ApiOperation({
    summary: 'Crear un lote en origen',
    description:
      'Crea el lote con la instantánea de las reglas vigentes (CFG-06) y su referencia interna `{lotPrefix}-L{año}-{NNN}` (contrato O2 §2.4). Con `productType: SINGANI` y `plannedTerroirIds` se evalúa la D.O. al crear.',
  })
  @ApiResponse({ status: HttpStatus.CREATED, type: LotDto })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    type: ApiErrorResponseDto,
    description:
      'VALIDATION_ERROR · TRC_PRODUCT_NOT_SUPPORTED · TRC_DO_TERROIR_NOT_ELIGIBLE (un detalle por regla incumplida)',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    type: ApiErrorResponseDto,
    description:
      'TRC_PLATFORM_READ_ONLY (la plataforma solo lee) · rol sin permiso',
  })
  create(
    @TenantId() wineryId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateLotDto,
  ) {
    return this.lots.create(wineryId, user.id, dto);
  }

  @Get(':id')
  @Roles(...LOT_READERS)
  @ApiOperation({
    summary: 'Detalle de un lote',
    description:
      'Lote con candados, instantánea de reglas, D.O., incidencias de cumplimiento y enlaces a la cadena (contrato O2 §2.1). Otra bodega → 404 `TRC_LOT_NOT_FOUND`.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: LotDto })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    type: ApiErrorResponseDto,
    description: 'TRC_LOT_NOT_FOUND',
  })
  get(
    @TenantId() wineryId: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.lots.get(wineryId, id);
  }

  @Patch(':id')
  @Roles('OWNER', 'ENOLOGIST')
  @ApiOperation({
    summary: 'Editar un lote',
    description:
      'Nombre, estimación de botellas (con `reason`, queda en su historial), formato y grado previstos, fecha objetivo y notas. `productType` no se cambia por aquí (§4.3).',
  })
  @ApiResponse({ status: HttpStatus.OK, type: LotDto })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    type: ApiErrorResponseDto,
    description: 'TRC_LOT_TERMINAL',
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    type: ApiErrorResponseDto,
    description:
      'VALIDATION_ERROR (p. ej. `reason` obligatorio al cambiar la estimación)',
  })
  update(
    @TenantId() wineryId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateLotDto,
  ) {
    return this.lots.update(wineryId, id, user.id, dto);
  }

  @Post(':id/discard')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @Roles('OWNER', 'ENOLOGIST')
  @ApiOperation({
    summary: 'Descartar un lote',
    description:
      'Pasa el lote a `DISCARDED` con motivo: las fuentes abiertas pasan a `DISCARDED` y se anulan sus códigos de botella (contrato O2 §2.2). Un lote certificado → 409 `TRC_LOT_TERMINAL`.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: LotDto })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    type: ApiErrorResponseDto,
    description: 'TRC_LOT_TERMINAL',
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    type: ApiErrorResponseDto,
    description: 'VALIDATION_ERROR',
  })
  discard(
    @TenantId() wineryId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: DiscardLotDto,
  ) {
    return this.lots.discard(wineryId, id, user.id, dto);
  }
}
