import {
  Controller,
  Get,
  Param,
  Query,
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
import { BottlingService } from '../services/bottling.service';
import { QueryBottlingBatchesDto } from '../dto/query-bottling-batches.dto';
import { BottlingBatchResponseDto } from '../dto/bottling-batch-response.dto';
import { TenantId } from '@shared/decorators/tenant-id.decorator';
import { ApiPaginatedResponse } from '@shared/decorators/api-paginated-response.decorator';
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
/**
 * Lectura de los embotellados. El alta es `POST /v1/lots/{id}/bottling`
 * (contrato O2 §6.1): la ruta legada `POST /v1/bottling` se retiró en H2.
 */
export class BottlingController {
  constructor(private readonly bottlingService: BottlingService) {}

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
