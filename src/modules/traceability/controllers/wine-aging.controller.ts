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
} from '@nestjs/swagger';
import { WineAgingService } from '../services/wine-aging.service';
import { CreateWineAgingBatchDto } from '../dto/create-wine-aging-batch.dto';
import { WineAgingResponseDto } from '../dto/wine-aging-response.dto';
import { TenantId } from '@shared/decorators/tenant-id.decorator';
import { ApiPaginatedResponse } from '@shared/decorators/api-paginated-response.decorator';
import { WineryScopedPaginationQueryDto } from '@shared/dto/pagination-query.dto';
import { Idempotent } from '@shared/idempotency/idempotent.decorator';
import {
  OrgType,
  RequireActiveOrg,
  Roles,
} from '@modules/auth/decorators/authorization.decorators';

@ApiTags('Crianza en Madera y Guarda (Vino)')
@ApiBearerAuth()
@OrgType('WINERY')
@RequireActiveOrg()
@Controller('wine-aging')
export class WineAgingController {
  constructor(private readonly wineAgingService: WineAgingService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @Roles('OWNER', 'ENOLOGIST')
  @ApiOperation({
    summary: 'Iniciar lote de crianza en barricas',
    description:
      'Traslada vino de cuba a barricas calculando automáticamente la fecha de bloqueo (lockUntilDate).',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Lote de crianza iniciado',
    type: WineAgingResponseDto,
  })
  async createAgingBatch(
    @TenantId() wineryId: string,
    @Body() dto: CreateWineAgingBatchDto,
  ) {
    return this.wineAgingService.createAgingBatch(wineryId, dto);
  }

  @Get()
  @Roles('OWNER', 'ENOLOGIST', 'ACCOUNTANT')
  @ApiOperation({
    summary: 'Listar lotes de crianza',
    description: 'Obtiene el listado de barricas y lotes en guarda.',
  })
  @ApiPaginatedResponse(WineAgingResponseDto, {
    description: 'Página de lotes de crianza',
  })
  async findAll(
    @TenantId() wineryId: string | undefined,
    @Query() query: WineryScopedPaginationQueryDto,
  ) {
    return this.wineAgingService.findAll(wineryId, query);
  }

  @Get(':id')
  @Roles('OWNER', 'ENOLOGIST', 'ACCOUNTANT')
  @ApiOperation({
    summary: 'Obtener detalle de lote de crianza',
    description:
      'Retorna datos de barrica, meses planificados y fecha límite de bloqueo.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Detalle de crianza',
    type: WineAgingResponseDto,
  })
  @ApiNotFoundResponse({ description: 'Lote de crianza no encontrado' })
  async findAgingBatchById(
    @TenantId() wineryId: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.wineAgingService.findAgingBatchById(wineryId, id);
  }
}
