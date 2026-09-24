import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
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
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@modules/auth/guards/roles.guard';
import { TenantGuard } from '@modules/auth/guards/tenant.guard';
import { Roles } from '@modules/auth/decorators/roles.decorator';
import { TenantId } from '@shared/decorators/tenant-id.decorator';
import { UserRoleEnum } from '@prisma/client';

@ApiTags('Terroirs y Parcelas')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard, RolesGuard, TenantGuard)
@Controller('terroirs')
export class TerroirsController {
  constructor(private readonly terroirsService: TerroirsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles(UserRoleEnum.WINERY_ADMIN, UserRoleEnum.AGRONOMIST)
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
  @ApiForbiddenResponse({ description: 'Sin permisos de agrónomo o administrador de bodega' })
  async create(
    @TenantId() wineryId: string,
    @Body() dto: CreateTerroirDto,
  ) {
    return this.terroirsService.create(wineryId, dto);
  }

  @Get()
  @Roles(UserRoleEnum.WINERY_ADMIN, UserRoleEnum.ENOLOGIST, UserRoleEnum.AGRONOMIST)
  @ApiOperation({
    summary: 'Listar parcelas de la bodega',
    description: 'Obtiene las parcelas asociadas a la bodega con soporte de filtros por D.O. y variedad.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Listado de parcelas',
  })
  async findAll(
    @TenantId() wineryId: string | undefined,
    @Query() query: QueryTerroirsDto,
  ) {
    return this.terroirsService.findAll(wineryId, query);
  }

  @Get(':id')
  @Roles(UserRoleEnum.WINERY_ADMIN, UserRoleEnum.ENOLOGIST, UserRoleEnum.AGRONOMIST)
  @ApiOperation({
    summary: 'Obtener detalle de una parcela',
    description: 'Retorna los datos agronómicos de la parcela y sus lotes de vendimia históricos.',
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
  @Roles(UserRoleEnum.WINERY_ADMIN, UserRoleEnum.AGRONOMIST)
  @ApiOperation({
    summary: 'Actualizar datos de una parcela',
    description: 'Permite modificar datos agronómicos, polígono perimetral o estado activo.',
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
