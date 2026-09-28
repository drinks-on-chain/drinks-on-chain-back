import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiNotFoundResponse,
} from '@nestjs/swagger';
import {
  DagBuilderService,
  DagGraphResult,
} from '../services/dag-builder.service';
import { DagGraphResponseDto } from '../dto/dag-response.dto';
import { ApiErrorResponseDto } from '@shared/dto/api-error-response.dto';
import {
  AuthenticatedUser,
  CurrentUser,
} from '@shared/decorators/current-user.decorator';
import { Public } from '@modules/auth/decorators/public.decorator';

@ApiTags('Grafo DAG de Trazabilidad')
@ApiBearerAuth()
@Controller('traceability')
export class TraceabilityDagController {
  constructor(private readonly dagBuilderService: DagBuilderService) {}

  @Get('dag/:bottlingBatchId')
  @ApiOperation({
    summary: 'Consultar árbol genealógico DAG de trazabilidad',
    deprecated: true,
    description:
      'Cadena de custodia del embotellado con datos reales (sin métricas de relleno; operador desde la membresía; `isCertified` = expediente cerrado). **SE-07**: solo los miembros de la bodega dueña y el personal de plataforma (ADMIN, OPERATIONS, SUPPORT); cualquier otra sesión → 404. Se retira en H2 por `GET /v1/lots/{id}/graph`.',
  })
  @ApiResponse({
    status: 200,
    description: 'Grafo DAG de linaje',
    type: DagGraphResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Embotellado inexistente o de otra bodega (SE-07)',
    type: ApiErrorResponseDto,
  })
  async getDagByBottlingBatchId(
    @CurrentUser() user: AuthenticatedUser,
    @Param('bottlingBatchId', ParseUUIDPipe) bottlingBatchId: string,
  ): Promise<DagGraphResult> {
    return this.dagBuilderService.buildDagForUser(user, bottlingBatchId);
  }

  @Public()
  @Get('public/:lotCode')
  @ApiOperation({
    summary: 'Pasaporte Digital Público de Trazabilidad (Acceso QR consumidor)',
    deprecated: true,
    description:
      'Endpoint público (legado hasta H2, se sustituye por `GET /v1/public/passports/{code}`): linaje del lote por su **código de lote** (ya no por id del embotellado) con datos registrados.',
  })
  @ApiResponse({
    status: 200,
    description: 'Pasaporte digital de trazabilidad pública',
    type: DagGraphResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Código de lote no encontrado',
    type: ApiErrorResponseDto,
  })
  async getPublicPassportByLotCode(
    @Param('lotCode') lotCode: string,
  ): Promise<DagGraphResult> {
    return this.dagBuilderService.buildPublicDag(lotCode);
  }
}
