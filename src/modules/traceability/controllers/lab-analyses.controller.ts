import {
  Controller,
  Get,
  Post,
  Body,
  Param,
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
  ApiConflictResponse,
} from '@nestjs/swagger';
import { LabAnalysesService } from '../services/lab-analyses.service';
import { CreateBatchLabAnalysisDto } from '../dto/create-batch-lab-analysis.dto';
import { BatchLabAnalysisResponseDto } from '../dto/batch-lab-analysis-response.dto';
import {
  CurrentUser,
  AuthenticatedUser,
} from '@shared/decorators/current-user.decorator';
import { TenantId } from '@shared/decorators/tenant-id.decorator';
import { ApiErrorResponseDto } from '@shared/dto/api-error-response.dto';
import { Idempotent } from '@shared/idempotency/idempotent.decorator';
import {
  OrgType,
  PlatformReadOnly,
  RequireActiveOrg,
  Roles,
} from '@modules/auth/decorators/authorization.decorators';

@ApiTags('Laboratorio Físico-Químico')
@ApiBearerAuth()
@PlatformReadOnly()
@OrgType('WINERY')
@RequireActiveOrg()
@Controller('lab-analyses')
export class LabAnalysesController {
  constructor(private readonly labAnalysesService: LabAnalysesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @Roles('OWNER', 'ENOLOGIST')
  @ApiOperation({
    summary: 'Registrar informe analítico oficial de laboratorio (legado)',
    description:
      'Alias hasta H2 de `POST /v1/lots/{id}/lab-analyses` (contrato O2 §8): la conformidad la calcula el servidor con los límites y las unidades de la instantánea del lote (EA-08; `conformsToSenasagStandards` de la entrada se ignora y falta un parámetro exigido → no conforme). Un análisis nuevo sustituye al anterior (reanálisis, sin 409).',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Informe de laboratorio registrado',
    type: BatchLabAnalysisResponseDto,
  })
  @ApiConflictResponse({
    type: ApiErrorResponseDto,
    description: 'TRC_LOT_TERMINAL',
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    type: ApiErrorResponseDto,
    description:
      'VALIDATION_ERROR (p. ej. metanol en mg/L y en mg/100 mL a.a. que no coinciden) · TRC_DATE_IN_FUTURE',
  })
  async create(
    @TenantId() wineryId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateBatchLabAnalysisDto,
  ) {
    return this.labAnalysesService.create(wineryId, user.id, dto);
  }

  @Get('batch/:bottlingBatchId')
  @Roles('OWNER', 'ENOLOGIST', 'AGRONOMIST', 'ACCOUNTANT')
  @ApiOperation({
    summary:
      'Consultar certificado de laboratorio por ID de lote de embotellado',
    description:
      'Obtiene el informe físico-químico oficial emitido para un lote embotellado.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Informe analítico',
    type: BatchLabAnalysisResponseDto,
  })
  @ApiNotFoundResponse({ description: 'Informe analítico no encontrado' })
  async findByBatchId(
    @TenantId() wineryId: string | undefined,
    @Param('bottlingBatchId', ParseUUIDPipe) bottlingBatchId: string,
  ) {
    return this.labAnalysesService.findByBatchId(wineryId, bottlingBatchId);
  }
}
