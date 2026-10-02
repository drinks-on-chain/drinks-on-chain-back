import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  OrgType,
  PlatformReadOnly,
  RequireActiveOrg,
  Roles,
} from '@modules/auth/decorators/authorization.decorators';
import { BatchLabAnalysisResponseDto } from '@modules/traceability/dto/batch-lab-analysis-response.dto';
import { LabAnalysesService } from '@modules/traceability/services/lab-analyses.service';
import {
  AuthenticatedUser,
  CurrentUser,
} from '@shared/decorators/current-user.decorator';
import { ApiPaginatedResponse } from '@shared/decorators/api-paginated-response.decorator';
import { TenantId } from '@shared/decorators/tenant-id.decorator';
import { WineryScopedPaginationQueryDto } from '@shared/dto/pagination-query.dto';
import { Idempotent } from '@shared/idempotency/idempotent.decorator';
import {
  ApiErrorCodes,
  ApiLotNotFound,
  ApiPlatformReadOnly,
  ApiRuleErrors,
} from './contract-responses';
import { CreateLotLabAnalysisDto } from './dto/lot-lab-analyses.dto';

/** Laboratorio del lote con conformidad calculada (contrato O2 §8). */
@ApiTags('Lotes (Ola 2)')
@ApiBearerAuth()
@OrgType('WINERY')
@RequireActiveOrg()
@PlatformReadOnly()
@Controller('lots')
export class LotLabAnalysesController {
  constructor(private readonly labAnalyses: LabAnalysesService) {}

  @Post(':id/lab-analyses')
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @Roles('OWNER', 'ENOLOGIST')
  @ApiOperation({
    summary: 'Registrar un análisis de laboratorio del lote',
    description:
      'Contrato O2 §8.1–§8.3: un análisis nuevo sustituye al anterior (reanálisis). La conformidad se calcula ' +
      'contra `rules.lab.limits` de la instantánea del lote (singani: metanol, cobre y grado; vino: acidez ' +
      'volátil y grado); falta alguno → `INCOMPLETE`. Unidades de §8.2. El informe va por su `key` de ' +
      '`POST /v1/uploads` (de la bodega y existente; si no, 422 `TRC_FILE_NOT_FOUND`) o por su URL (alias ' +
      'hasta H2); el ensayo no puede ser anterior al embotellado.',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    type: BatchLabAnalysisResponseDto,
  })
  @ApiLotNotFound()
  @ApiPlatformReadOnly()
  @ApiErrorCodes(HttpStatus.CONFLICT, [
    'TRC_LOT_NOT_BOTTLED',
    'TRC_DOSSIER_CLOSED',
    'TRC_LOT_TERMINAL',
  ])
  @ApiRuleErrors([
    'TRC_DATE_IN_FUTURE',
    'TRC_DATE_BEFORE_PREVIOUS_STAGE',
    'TRC_FILE_NOT_FOUND',
  ])
  create(
    @TenantId() wineryId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateLotLabAnalysisDto,
  ) {
    return this.labAnalyses.createForLot(wineryId, user.id, id, dto);
  }

  @Get(':id/lab-analyses')
  @Roles('OWNER', 'ENOLOGIST', 'AGRONOMIST', 'OPERATOR', 'ACCOUNTANT')
  @ApiOperation({
    summary: 'Análisis de laboratorio del lote',
    description:
      'Contrato O2 §8.1: todos los análisis del lote, el más reciente primero, con `current: true` en el vigente ' +
      '(ni sustituido por un reanálisis ni anulado por una corrección).',
  })
  @ApiPaginatedResponse(BatchLabAnalysisResponseDto, {
    description: 'Página de análisis del lote',
  })
  @ApiLotNotFound()
  list(
    @TenantId() wineryId: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: WineryScopedPaginationQueryDto,
  ) {
    return this.labAnalyses.listForLot(wineryId, id, query);
  }
}
