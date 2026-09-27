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
import { ApiPaginatedResponse } from '@shared/decorators/api-paginated-response.decorator';
import { Idempotent } from '@shared/idempotency/idempotent.decorator';
import {
  OrgType,
  RequireActiveOrg,
  Roles,
} from '@modules/auth/decorators/authorization.decorators';

@ApiTags('Fraccionamiento y Embotellado')
@ApiBearerAuth()
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
    summary: 'Registrar lote de embotellado y fraccionamiento',
    description:
      'Valida elegibilidad D.O. del lote de origen, calcula dilución de agua, genera código de lote internacional y URL QR.',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Lote de embotellado registrado',
    type: BottlingBatchResponseDto,
  })
  @ApiUnprocessableEntityResponse({
    description: 'Reglas D.O. incumplidas (ej: reposo inerte < 180 días)',
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
