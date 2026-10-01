import {
  Controller,
  Get,
  Post,
  Patch,
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
  ApiUnauthorizedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
} from '@nestjs/swagger';
import { TerroirsService } from './terroirs.service';
import { CreateTerroirDto } from './dto/create-terroir.dto';
import { UpdateTerroirDto } from './dto/update-terroir.dto';
import { QueryTerroirsDto } from './dto/query-terroirs.dto';
import { TerroirResponseDto } from './dto/terroir-response.dto';
import { TenantId } from '@shared/decorators/tenant-id.decorator';
import { ApiPaginatedResponse } from '@shared/decorators/api-paginated-response.decorator';
import { Idempotent } from '@shared/idempotency/idempotent.decorator';
import {
  OrgType,
  RequireActiveOrg,
  Roles,
} from '@modules/auth/decorators/authorization.decorators';

@ApiTags('Terroirs y Parcelas')
@ApiBearerAuth()
@OrgType('WINERY')
@RequireActiveOrg()
@Controller('terroirs')
export class TerroirsController {
  constructor(private readonly terroirsService: TerroirsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @Roles('OWNER', 'AGRONOMIST')
  @ApiOperation({
    summary: 'Registrar una nueva parcela de cultivo',
    description:
      'Registra un terroir o cuartel con altitud, variedad y polígono GeoJSON opcional bajo el tenant de la bodega.',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Parcela registrada exitosamente',
    type: TerroirResponseDto,
  })
  @ApiUnauthorizedResponse({ description: 'No autenticado' })
  @ApiForbiddenResponse({
    description: 'Sin permisos de agrónomo o administrador de bodega',
  })
  async create(@TenantId() wineryId: string, @Body() dto: CreateTerroirDto) {
    return this.terroirsService.create(wineryId, dto);
  }

  // OPERATOR: lectura mínima para elegir la parcela del pesaje (contrato O1
  // §11 bis, propuesta de coordinación); sin alta ni edición
  @Get()
  @Roles('OWNER', 'ENOLOGIST', 'AGRONOMIST', 'OPERATOR', 'ACCOUNTANT')
  @ApiOperation({
    summary: 'Listar parcelas de la bodega',
    description:
      'Obtiene las parcelas asociadas a la bodega con soporte de filtros por D.O. y variedad. El operario de planta (`OPERATOR`) las lee para elegir la parcela del pesaje, sin editarlas.',
  })
  @ApiPaginatedResponse(TerroirResponseDto, {
    description: 'Página de parcelas',
  })
  async findAll(
    @TenantId() wineryId: string | undefined,
    @Query() query: QueryTerroirsDto,
  ) {
    return this.terroirsService.findAll(wineryId, query);
  }

  @Get(':id')
  @Roles('OWNER', 'ENOLOGIST', 'AGRONOMIST', 'OPERATOR', 'ACCOUNTANT')
  @ApiOperation({
    summary: 'Obtener detalle de una parcela',
    description:
      'Retorna los datos agronómicos de la parcela y sus lotes de vendimia históricos.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Detalle de la parcela',
    type: TerroirResponseDto,
  })
  @ApiNotFoundResponse({ description: 'Parcela no encontrada' })
  async findById(
    @TenantId() wineryId: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.terroirsService.findById(wineryId, id);
  }

  @Patch(':id')
  @Roles('OWNER', 'AGRONOMIST')
  @ApiOperation({
    summary: 'Actualizar datos de una parcela',
    description:
      'Permite modificar datos agronómicos, polígono perimetral o estado activo.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Parcela actualizada',
    type: TerroirResponseDto,
  })
  @ApiNotFoundResponse({ description: 'Parcela no encontrada' })
  async update(
    @TenantId() wineryId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTerroirDto,
  ) {
    return this.terroirsService.update(wineryId, id, dto);
  }
}
