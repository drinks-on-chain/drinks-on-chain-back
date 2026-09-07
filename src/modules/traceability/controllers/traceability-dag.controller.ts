import {
  Controller,
  Get,
  Param,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiNotFoundResponse,
} from '@nestjs/swagger';
import { DagBuilderService, DagGraphResult } from '../services/dag-builder.service';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@modules/auth/guards/roles.guard';
import { TenantGuard } from '@modules/auth/guards/tenant.guard';
import { SkipTenant } from '@modules/auth/decorators/skip-tenant.decorator';

@ApiTags('Grafo DAG de Trazabilidad')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard, RolesGuard, TenantGuard)
@Controller('traceability')
export class TraceabilityDagController {
  constructor(private readonly dagBuilderService: DagBuilderService) {}

  @Get('dag/:bottlingBatchId')
  @SkipTenant()
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
}
