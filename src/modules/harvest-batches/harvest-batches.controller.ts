import {
  Controller,
  Get,
  Post,
  Patch,
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
import { HarvestBatchesService } from './harvest-batches.service';
import { CreateHarvestBatchDto } from './dto/create-harvest-batch.dto';
import { UpdatePhytoStatusDto } from './dto/update-phyto-status.dto';
import { QueryHarvestBatchesDto } from './dto/query-harvest-batches.dto';
import { HarvestBatchResponseDto } from './dto/harvest-batch-response.dto';
import {
  CreateMaturityAnalysisDto,
  CreatePhytoDecisionDto,
  MaturityAnalysisResponseDto,
  PhytoDecisionResponseDto,
} from './dto/phyto-decision.dto';
import {
  CurrentUser,
  AuthenticatedUser,
} from '@shared/decorators/current-user.decorator';
import { TenantId } from '@shared/decorators/tenant-id.decorator';
import { ApiPaginatedResponse } from '@shared/decorators/api-paginated-response.decorator';
import { Idempotent } from '@shared/idempotency/idempotent.decorator';
import { ApiErrorResponseDto } from '@shared/dto/api-error-response.dto';
import { PaginationQueryDto } from '@shared/dto/pagination-query.dto';
import {
  OrgType,
  PlatformReadOnly,
  RequireActiveOrg,
  Roles,
} from '@modules/auth/decorators/authorization.decorators';

const READERS = [
  'OWNER',
  'ENOLOGIST',
  'AGRONOMIST',
  'OPERATOR',
  'ACCOUNTANT',
] as const;

@ApiTags('Vendimia y Pesaje')
@ApiBearerAuth()
@PlatformReadOnly()
@OrgType('WINERY')
@RequireActiveOrg()
@Controller('harvest-batches')
export class HarvestBatchesController {
  constructor(private readonly harvestBatchesService: HarvestBatchesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @Roles('OWNER', 'AGRONOMIST', 'ENOLOGIST', 'OPERATOR')
  @ApiOperation({
    summary: 'Registrar ingreso y pesaje de uva en vendimia',
    description:
      'Pesaje neto con lote existente (`lotId`), nuevo (`newLot`, solo OWNER y ENOLOGIST) o sin lote (uva recibida). El análisis de madurez es opcional (`maturity`) y el dictamen va aparte: un `phytosanitaryStatus` distinto de `PENDING_INSPECTION` → 422 `TRC_PHYTO_IN_CREATE` (EA-04). El código `HARV-{año}-{parcela}-{NNN}` sale de la secuencia de la bodega (EA-07). Contrato O2 §3.2.',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Lote de vendimia registrado',
    type: HarvestBatchResponseDto,
  })
  @ApiUnprocessableEntityResponse({
    description:
      'VALIDATION_ERROR (bruto ≤ tara…) · TRC_PHYTO_IN_CREATE · TRC_DATE_IN_FUTURE · TRC_HARVEST_YEAR_MISMATCH · TRC_DO_TERROIR_NOT_ELIGIBLE (lote singani) · TRC_PRODUCT_NOT_SUPPORTED (newLot)',
    type: ApiErrorResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    type: ApiErrorResponseDto,
    description:
      'TRC_INVALID_STAGE (lote después de FERMENTING) · TRC_LOT_TERMINAL',
  })
  @ApiNotFoundResponse({
    description:
      'Parcela o lote no encontrados en esta bodega (TRC_LOT_NOT_FOUND)',
    type: ApiErrorResponseDto,
  })
  async create(
    @TenantId() wineryId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateHarvestBatchDto,
  ) {
    return this.harvestBatchesService.create(
      wineryId,
      { id: user.id, role: user.role },
      dto,
    );
  }

  @Get()
  @Roles(...READERS)
  @ApiOperation({
    summary: 'Listar lotes de vendimia',
    description:
      'Pesajes con filtros por año, parcela, estado fitosanitario y lote (`lotId=none`: uva recibida sin lote).',
  })
  @ApiPaginatedResponse(HarvestBatchResponseDto, {
    description: 'Página de lotes de vendimia',
  })
  async findAll(
    @TenantId() wineryId: string | undefined,
    @Query() query: QueryHarvestBatchesDto,
  ) {
    return this.harvestBatchesService.findAll(wineryId, query);
  }

  @Get(':id')
  @Roles(...READERS)
  @ApiOperation({
    summary: 'Obtener detalle de un lote de vendimia',
    description:
      'Pesaje con sus análisis de madurez, dictámenes, kilos disponibles, D.O. (lote singani) y tanques.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Detalle del lote de vendimia',
    type: HarvestBatchResponseDto,
  })
  @ApiNotFoundResponse({ description: 'Lote de vendimia no encontrado' })
  async findById(
    @TenantId() wineryId: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.harvestBatchesService.findById(wineryId, id);
  }

  @Post(':id/phyto-decisions')
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @Roles('OWNER', 'AGRONOMIST', 'ENOLOGIST')
  @ApiOperation({
    summary: 'Registrar un dictamen fitosanitario',
    description:
      'Solo inserción (EA-04, contrato O2 §3.4): `PENDING_INSPECTION → APPROVED | REJECTED | QUARANTINE`; `QUARANTINE → …`; `APPROVED` y `REJECTED` son finales. `REJECTED` y `QUARANTINE` exigen `notes`. Devuelve el pesaje.',
  })
  @ApiResponse({ status: HttpStatus.CREATED, type: HarvestBatchResponseDto })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    type: ApiErrorResponseDto,
    description:
      'TRC_PHYTO_DECISION_FINAL (dictamen final o uva ya en un tanque) · TRC_LOT_TERMINAL',
  })
  @ApiUnprocessableEntityResponse({
    type: ApiErrorResponseDto,
    description:
      'VALIDATION_ERROR (motivo obligatorio) · TRC_DATE_IN_FUTURE · TRC_DATE_BEFORE_PREVIOUS_STAGE · TRC_FILE_NOT_FOUND',
  })
  async decide(
    @TenantId() wineryId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreatePhytoDecisionDto,
  ) {
    return this.harvestBatchesService.decide(wineryId, id, user.id, dto);
  }

  @Get(':id/phyto-decisions')
  @Roles(...READERS)
  @ApiOperation({
    summary: 'Historial de dictámenes fitosanitarios del pesaje',
  })
  @ApiPaginatedResponse(PhytoDecisionResponseDto, {
    description: 'Dictámenes en orden de registro',
  })
  async listDecisions(
    @TenantId() wineryId: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.harvestBatchesService.listDecisions(wineryId, id, query);
  }

  @Post(':id/maturity-analyses')
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @Roles('OWNER', 'ENOLOGIST', 'AGRONOMIST')
  @ApiOperation({
    summary: 'Registrar un análisis de madurez',
    description:
      'Solo inserción; el último (por fecha de medición) es el vigente y se refleja en el pesaje (contrato O2 §3.3). Rangos: Brix 0–40, pH 2–5, acidez 0–30 g/L.',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    type: MaturityAnalysisResponseDto,
  })
  @ApiUnprocessableEntityResponse({
    type: ApiErrorResponseDto,
    description: 'VALIDATION_ERROR · TRC_DATE_IN_FUTURE',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    type: ApiErrorResponseDto,
    description: 'TRC_LOT_TERMINAL',
  })
  async addMaturityAnalysis(
    @TenantId() wineryId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateMaturityAnalysisDto,
  ) {
    return this.harvestBatchesService.addMaturityAnalysis(
      wineryId,
      id,
      user.id,
      dto,
    );
  }

  @Get(':id/maturity-analyses')
  @Roles(...READERS)
  @ApiOperation({ summary: 'Análisis de madurez del pesaje' })
  @ApiPaginatedResponse(MaturityAnalysisResponseDto, {
    description: 'Análisis por fecha de medición',
  })
  async listMaturityAnalyses(
    @TenantId() wineryId: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.harvestBatchesService.listMaturityAnalyses(wineryId, id, query);
  }

  @Patch(':id/phyto-status')
  @Roles('OWNER', 'AGRONOMIST', 'ENOLOGIST')
  @ApiOperation({
    summary: 'Dictaminar estado fitosanitario del lote (legado)',
    deprecated: true,
    description:
      'Alias de `POST /v1/harvest-batches/{id}/phyto-decisions` hasta H2 (contrato O2 §3.4): mismas reglas y ya no sobrescribe las notas del pesaje.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Estado fitosanitario actualizado',
    type: HarvestBatchResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    type: ApiErrorResponseDto,
    description: 'TRC_PHYTO_DECISION_FINAL · TRC_LOT_TERMINAL',
  })
  @ApiUnprocessableEntityResponse({
    type: ApiErrorResponseDto,
    description:
      'VALIDATION_ERROR (motivo obligatorio en REJECTED y QUARANTINE)',
  })
  @ApiNotFoundResponse({ description: 'Lote de vendimia no encontrado' })
  async updatePhytoStatus(
    @TenantId() wineryId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdatePhytoStatusDto,
  ) {
    return this.harvestBatchesService.updatePhytoStatus(
      wineryId,
      id,
      user.id,
      dto,
    );
  }
}
