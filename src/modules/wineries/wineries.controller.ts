import {
  Controller,
  Get,
  Patch,
  Body,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
} from '@nestjs/swagger';
import { WineriesService } from './wineries.service';
import { UpdateWineryDto } from './dto/update-winery.dto';
import { QueryWineriesDto } from './dto/query-wineries.dto';
import { WineryResponseDto } from './dto/winery-response.dto';
import {
  OrgType,
  RequireActiveOrg,
  Roles,
} from '@modules/auth/decorators/authorization.decorators';
import { TenantId } from '@shared/decorators/tenant-id.decorator';
import { ValidationException } from '@shared/exceptions/validation.exception';
import { ApiPaginatedResponse } from '@shared/decorators/api-paginated-response.decorator';
import type { Paginated } from '@shared/interfaces/api-response.interface';

/**
 * Directorio (plataforma) y perfil de la bodega activa (0.1). La
 * autoinscripción, `pending`/`approve`/`reject` y `my/members*` se retiraron
 * al cerrar la Ola 1 (H1): los sustituyen `/v1/public/winery-applications`,
 * `/v1/platform/*` y `/v1/organizations/current/*`.
 */
@ApiTags('Bodegas y Productores')
@ApiBearerAuth()
@Controller('wineries')
export class WineriesController {
  constructor(private readonly wineriesService: WineriesService) {}

  /** Las rutas `my` de la plataforma necesitan `?wineryId=` también al leer. */
  private requireTenant(tenantId: string | undefined): string {
    if (!tenantId) {
      throw ValidationException.forField(
        'wineryId',
        'El personal de plataforma debe indicar la bodega (?wineryId=)',
      );
    }
    return tenantId;
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  @OrgType('PLATFORM')
  @Roles('SUPERADMIN', 'ADMIN', 'OPERATIONS', 'SUPPORT')
  @ApiOperation({
    summary: 'Listar todas las bodegas registradas (solo plataforma)',
    description:
      'Retorna el directorio completo de bodegas con soporte de filtros por estado, categoría y paginación.',
  })
  @ApiForbiddenResponse({
    description: 'Requiere la organización de plataforma activa',
  })
  @ApiPaginatedResponse(WineryResponseDto, {
    description: 'Directorio de bodegas (página)',
  })
  async findAllWineries(
    @Query() query: QueryWineriesDto,
  ): Promise<Paginated<WineryResponseDto>> {
    return this.wineriesService.findAllWineries(query);
  }

  @Get('my')
  @HttpCode(HttpStatus.OK)
  @OrgType('WINERY')
  @RequireActiveOrg({ allow: ['SUSPENDED'] })
  @ApiOperation({
    summary: 'Obtener datos institucionales de la bodega del usuario',
    description:
      'Retorna el perfil de la bodega vinculada a la membresía activa del usuario autenticado.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Perfil de la bodega obtenido exitosamente',
    type: WineryResponseDto,
  })
  @ApiNotFoundResponse({ description: 'Bodega no encontrada' })
  async getMyWinery(
    @TenantId() tenantId: string | undefined,
  ): Promise<WineryResponseDto> {
    return this.wineriesService.getMyWinery(this.requireTenant(tenantId));
  }

  @Patch('my')
  @HttpCode(HttpStatus.OK)
  @OrgType('WINERY')
  @Roles('OWNER')
  @RequireActiveOrg()
  @ApiOperation({
    summary: 'Actualizar datos de la bodega',
    description:
      'Permite al administrador de la bodega actualizar dirección, teléfono, logo y correo institucional.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Datos de la bodega actualizados exitosamente',
    type: WineryResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'No autorizado para modificar datos de la bodega',
  })
  async updateMyWinery(
    @TenantId() tenantId: string,
    @Body() dto: UpdateWineryDto,
  ): Promise<WineryResponseDto> {
    return this.wineriesService.updateMyWinery(tenantId, dto);
  }
}
