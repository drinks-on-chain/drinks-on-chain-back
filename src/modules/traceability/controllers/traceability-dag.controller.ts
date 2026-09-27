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

import { Public } from '@modules/auth/decorators/public.decorator';

@ApiTags('Grafo DAG de Trazabilidad')
@ApiBearerAuth()
@Controller('traceability')
export class TraceabilityDagController {
  constructor(private readonly dagBuilderService: DagBuilderService) {}

  @Get('dag/:bottlingBatchId')
  @ApiOperation({
    summary: 'Consultar árbol genealógico DAG de trazabilidad',
    description:
      'Reconstruye la cadena completa de custodia y transformaciones (Parcela -> Vendimia -> Vinificación -> Crianza/Destilación -> Embotellado) con hashes y métricas para contrato Soroban.',
  })
  @ApiResponse({
    status: 200,
    description: 'Grafo DAG de linaje',
  })
  @ApiNotFoundResponse({ description: 'Lote de embotellado no encontrado' })
  async getDagByBottlingBatchId(
    @Param('bottlingBatchId', ParseUUIDPipe) bottlingBatchId: string,
  ): Promise<DagGraphResult> {
    return this.dagBuilderService.buildDagForBottlingBatch(bottlingBatchId);
  }

  @Public()
  @Get('public/:lotCode')
  @ApiOperation({
    summary: 'Pasaporte Digital Público de Trazabilidad (Acceso QR consumidor)',
    description:
      'Endpoint público sin autenticación para consumidores que escanean el código QR en la botella física. Retorna el linaje completo y certificado analítico oficial.',
  })
  @ApiResponse({
    status: 200,
    description: 'Pasaporte digital de trazabilidad pública',
  })
  @ApiNotFoundResponse({ description: 'Código de lote no encontrado' })
  async getPublicPassportByLotCode(
    @Param('lotCode') lotCode: string,
  ): Promise<DagGraphResult> {
    return this.dagBuilderService.buildDagForBottlingBatch(lotCode);
  }
}
