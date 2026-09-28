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
import { notImplemented } from '@modules/lots/domain/trace-errors';
import { BatchLabAnalysisResponseDto } from '@modules/traceability/dto/batch-lab-analysis-response.dto';
import { ApiPaginatedResponse } from '@shared/decorators/api-paginated-response.decorator';
import { TenantId } from '@shared/decorators/tenant-id.decorator';
import { WineryScopedPaginationQueryDto } from '@shared/dto/pagination-query.dto';
import { Idempotent } from '@shared/idempotency/idempotent.decorator';
import type { Paginated } from '@shared/interfaces/api-response.interface';
import {
  ApiErrorCodes,
  ApiLotNotFound,
  ApiNotImplemented,
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
  @Post(':id/lab-analyses')
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @Roles('OWNER', 'ENOLOGIST')
  @ApiOperation({
    summary: 'Registrar un análisis de laboratorio del lote',
    description:
      'Contrato O2 §8.1–§8.3: un análisis nuevo sustituye al anterior (reanálisis). La conformidad se calcula ' +
      'contra `rules.lab.limits` de la instantánea del lote (singani: metanol, cobre y grado; vino: acidez ' +
      'volátil y grado); falta alguno → `INCOMPLETE`. Unidades de §8.2.',
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
  @ApiNotImplemented('2.7')
  create(
    @TenantId() _wineryId: string,
    @Param('id', ParseUUIDPipe) _id: string,
    @Body() _dto: CreateLotLabAnalysisDto,
  ): BatchLabAnalysisResponseDto {
    throw notImplemented('2.7');
  }

  @Get(':id/lab-analyses')
  @Roles('OWNER', 'ENOLOGIST', 'AGRONOMIST', 'OPERATOR', 'ACCOUNTANT')
  @ApiOperation({
    summary: 'Análisis de laboratorio del lote',
    description:
      'Contrato O2 §8.1: todos los análisis del lote, el más reciente primero, con `current: true` en el vigente.',
  })
  @ApiPaginatedResponse(BatchLabAnalysisResponseDto, {
    description: 'Página de análisis del lote',
  })
  @ApiLotNotFound()
  @ApiNotImplemented('2.7')
  list(
    @TenantId() _wineryId: string | undefined,
    @Param('id', ParseUUIDPipe) _id: string,
    @Query() _query: WineryScopedPaginationQueryDto,
  ): Paginated<BatchLabAnalysisResponseDto> {
    throw notImplemented('2.7');
  }
}
