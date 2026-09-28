import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { BottlingService } from '../services/bottling.service';
import { CreateBottlingBatchDto } from '../dto/create-bottling-batch.dto';
import { QueryBottlingBatchesDto } from '../dto/query-bottling-batches.dto';
import { BottlingBatchResponseDto } from '../dto/bottling-batch-response.dto';
import {
  CurrentUser,
  AuthenticatedUser,
} from '@shared/decorators/current-user.decorator';
import { TenantId } from '@shared/decorators/tenant-id.decorator';
import { ApiErrorResponseDto } from '@shared/dto/api-error-response.dto';
import { ApiPaginatedResponse } from '@shared/decorators/api-paginated-response.decorator';
import { Idempotent } from '@shared/idempotency/idempotent.decorator';
import {
  OrgType,
  PlatformReadOnly,
  RequireActiveOrg,
  Roles,
} from '@modules/auth/decorators/authorization.decorators';

@ApiTags('Fraccionamiento y Embotellado')
@ApiBearerAuth()
@PlatformReadOnly()
@OrgType('WINERY')
@RequireActiveOrg()
@Controller('bottling')
export class BottlingController {
  constructor(private readonly bottlingService: BottlingService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @Roles('OWNER', 'ENOLOGIST')
  @ApiOperation({
    summary: 'Registrar lote de embotellado y fraccionamiento (legado)',
    description:
      'Alias hasta H2 de `POST /v1/lots/{id}/bottling` (contrato O2 §6): el lote se deduce del origen y aplican las mismas reglas desde la apertura. Tipo derivado del origen (EA-01), candados con el reloj de la base y la instantánea del lote, un embotellado por lote (S-10), balance de volumen con la merma de la instantánea y de alcohol (EA-02), fuentes y tanques a estados terminales, código de lote con secuencia sin carreras (EA-07), URL del QR `{PASSPORT_BASE_URL}/b/{lotCode}` y un código por botella.',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Lote de embotellado registrado',
    type: BottlingBatchResponseDto,
  })
  @ApiUnprocessableEntityResponse({
    type: ApiErrorResponseDto,
    description:
      'VALIDATION_ERROR · TRC_PRODUCT_TYPE_MISMATCH · TRC_LOCK_NOT_RELEASED · TRC_BOTTLING_SOURCE_INVALID · TRC_BOTTLING_SOURCES_PENDING · TRC_VOLUME_MISSING · TRC_VOLUME_EXCEEDS_AVAILABLE · TRC_BOTTLING_EXCEEDS_VOLUME · TRC_BOTTLING_LOSS_ABOVE_TOLERANCE · TRC_ALCOHOL_BALANCE_EXCEEDED · TRC_DILUTION_NOT_ALLOWED · TRC_COMPLIANCE_ISSUES_OPEN · TRC_DATE_IN_FUTURE (un detalle por regla incumplida)',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    type: ApiErrorResponseDto,
    description: 'TRC_LOT_ALREADY_BOTTLED · TRC_LOT_TERMINAL',
  })
  async create(
    @TenantId() wineryId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateBottlingBatchDto,
  ) {
    return this.bottlingService.create(wineryId, user.id, dto);
  }

  @Get()
  @Roles('OWNER', 'ENOLOGIST', 'ACCOUNTANT')
  @ApiOperation({
    summary: 'Listar lotes embotellados',
    description:
      'Retorna los lotes de embotellado de la bodega con filtros por tipo de bebida.',
  })
  @ApiPaginatedResponse(BottlingBatchResponseDto, {
    description: 'Página de lotes embotellados',
  })
  async findAll(
    @TenantId() wineryId: string | undefined,
    @Query() query: QueryBottlingBatchesDto,
  ) {
    return this.bottlingService.findAll(wineryId, query);
  }

  @Get(':id')
  @Roles('OWNER', 'ENOLOGIST', 'ACCOUNTANT')
  @ApiOperation({
    summary: 'Obtener detalle de lote embotellado',
    description:
      'Retorna datos de fraccionamiento, código de lote internacional y certificado de laboratorio asociado.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Detalle de lote embotellado',
    type: BottlingBatchResponseDto,
  })
  @ApiNotFoundResponse({ description: 'Lote de embotellado no encontrado' })
  async findById(
    @TenantId() wineryId: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.bottlingService.findById(wineryId, id);
  }
}
