import {
  Controller,
  Get,
  Param,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiNotFoundResponse,
} from '@nestjs/swagger';
import { LabAnalysesService } from '../services/lab-analyses.service';
import { BatchLabAnalysisResponseDto } from '../dto/batch-lab-analysis-response.dto';
import { TenantId } from '@shared/decorators/tenant-id.decorator';
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
/**
 * Lectura del análisis vigente de un embotellado. El alta es
 * `POST /v1/lots/{id}/lab-analyses` (contrato O2 §8.1): la ruta legada
 * `POST /v1/lab-analyses` se retiró en H2.
 */
export class LabAnalysesController {
  constructor(private readonly labAnalysesService: LabAnalysesService) {}

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
