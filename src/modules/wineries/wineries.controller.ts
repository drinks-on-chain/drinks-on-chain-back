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
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiConflictResponse,
} from '@nestjs/swagger';
import { WineriesService } from './wineries.service';
import { CreateWineryDto } from './dto/create-winery.dto';
import { UpdateWineryDto } from './dto/update-winery.dto';
import { AddMemberDto } from './dto/add-member.dto';
import { CreateMemberDto } from './dto/create-member.dto';
import { ApproveWineryDto } from './dto/approve-winery.dto';
import { RejectWineryDto } from './dto/reject-winery.dto';
import { QueryWineriesDto } from './dto/query-wineries.dto';
import {
  WineryResponseDto,
  WineryMemberItemDto,
} from './dto/winery-response.dto';
import {
  OrgType,
  RequireActiveOrg,
  Roles,
} from '@modules/auth/decorators/authorization.decorators';
import { DeprecatedRoute } from '@shared/decorators/deprecated-route.decorator';
import {
  CurrentUser,
  AuthenticatedUser,
} from '@shared/decorators/current-user.decorator';
import { TenantId } from '@shared/decorators/tenant-id.decorator';
import { ValidationException } from '@shared/exceptions/validation.exception';
import { ApiPaginatedResponse } from '@shared/decorators/api-paginated-response.decorator';
import {
  PaginationQueryDto,
  WineryScopedPaginationQueryDto,
} from '@shared/dto/pagination-query.dto';
import type { Paginated } from '@shared/interfaces/api-response.interface';

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

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @DeprecatedRoute('/v1/public/winery-applications')
  @ApiOperation({
    deprecated: true,
    summary: 'Solicitar alta y registro de una nueva bodega (obsoleta, H1)',
    description:
      'Obsoleta: se retira al cerrar la Ola 1 (H1). Sustituida por el formulario público `POST /v1/public/winery-applications` y el alta directa `POST /v1/platform/wineries`. Crea una bodega en estado INVITED con su organización, asocia al creador como OWNER y asigna una billetera custodial institucional. Para operar con ella, cambia la organización activa (`POST /v1/auth/switch-organization`) o renueva la sesión.',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Bodega registrada exitosamente en estado INVITED',
    type: WineryResponseDto,
  })
  @ApiConflictResponse({ description: 'El NIT ya se encuentra registrado' })
  async createWinery(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateWineryDto,
  ): Promise<WineryResponseDto> {
    return this.wineriesService.createWinery(user.id, dto);
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

  @Post('my/members')
  @HttpCode(HttpStatus.CREATED)
  @OrgType('WINERY')
  @Roles('OWNER')
  @RequireActiveOrg()
  @DeprecatedRoute('/v1/organizations/current/invitations')
  @ApiOperation({
    deprecated: true,
    summary: 'Incorporar un nuevo miembro operativo a la bodega (obsoleta, H1)',
    description:
      'Obsoleta: se retira al cerrar la Ola 1 (H1); el equipo se forma por invitación (`POST /v1/organizations/current/invitations`). Añade o reactiva la membresía de un usuario existente en **esta** bodega (enólogo, agrónomo, operario o contador). Nunca modifica su rol global ni sus membresías en otras organizaciones (SE-01).',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Miembro incorporado exitosamente',
    type: WineryMemberItemDto,
  })
  @ApiConflictResponse({
    description:
      'ORG_ALREADY_MEMBER: el usuario ya es miembro activo de la bodega',
  })
  @ApiForbiddenResponse({
    description:
      'ORG_BLOCKED_BY_PLATFORM: la plataforma bloqueó esa membresía; el dueño no puede reactivarla',
  })
  @ApiNotFoundResponse({ description: 'El usuario no existe' })
  async addMember(
    @TenantId() tenantId: string,
    @Body() dto: AddMemberDto,
  ): Promise<WineryMemberItemDto> {
    return this.wineriesService.addMember(tenantId, dto);
  }

  @Post('my/members/create')
  @HttpCode(HttpStatus.CREATED)
  @OrgType('WINERY')
  @Roles('OWNER')
  @RequireActiveOrg()
  @DeprecatedRoute('/v1/organizations/current/invitations')
  @ApiOperation({
    deprecated: true,
    summary:
      'Registrar y dar de alta a un nuevo miembro operativo en la bodega (obsoleta, H1)',
    description:
      'Obsoleta: se retira al cerrar la Ola 1 (H1); el equipo se forma por invitación (`POST /v1/organizations/current/invitations`, la persona elige su contraseña). Crea la cuenta de usuario, aprovisiona su billetera custodial y lo asocia a la bodega en un solo paso.',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Miembro operativo creado e incorporado exitosamente',
    type: WineryMemberItemDto,
  })
  @ApiConflictResponse({
    description: 'El correo electrónico ya se encuentra registrado',
  })
  async createAndAddMember(
    @TenantId() tenantId: string,
    @Body() dto: CreateMemberDto,
  ): Promise<WineryMemberItemDto> {
    return this.wineriesService.createAndAddMember(tenantId, dto);
  }

  @Get('my/members')
  @HttpCode(HttpStatus.OK)
  @OrgType('WINERY')
  @RequireActiveOrg()
  @DeprecatedRoute('/v1/organizations/current/members')
  @ApiOperation({
    deprecated: true,
    summary: 'Listar miembros operativos de la bodega (obsoleta, H1)',
    description:
      'Obsoleta: se retira al cerrar la Ola 1 (H1); sustituida por `GET /v1/organizations/current/members`. Retorna la lista de miembros activos en la bodega actual.',
  })
  @ApiPaginatedResponse(WineryMemberItemDto, {
    description: 'Página de miembros activos de la bodega',
  })
  async getMyMembers(
    @TenantId() tenantId: string | undefined,
    @Query() query: WineryScopedPaginationQueryDto,
  ): Promise<Paginated<WineryMemberItemDto>> {
    return this.wineriesService.getMyMembers(
      this.requireTenant(tenantId),
      query,
    );
  }

  @Get('pending')
  @HttpCode(HttpStatus.OK)
  @OrgType('PLATFORM')
  @Roles('SUPERADMIN', 'ADMIN', 'OPERATIONS', 'SUPPORT')
  @DeprecatedRoute('/v1/platform/winery-applications')
  @ApiOperation({
    deprecated: true,
    summary:
      'Listar bodegas pendientes de aprobación (solo plataforma; obsoleta, H1)',
    description:
      'Obsoleta: se retira al cerrar la Ola 1 (H1); sustituida por la bandeja de solicitudes (`GET /v1/platform/winery-applications`) y el directorio (`GET /v1/platform/wineries?status=INVITED`). Obtiene todas las solicitudes de bodegas en estado INVITED para revisión y certificación legal.',
  })
  @ApiForbiddenResponse({
    description: 'Requiere la organización de plataforma activa',
  })
  @ApiPaginatedResponse(WineryResponseDto, {
    description: 'Página de bodegas pendientes',
  })
  async getPendingWineries(
    @Query() query: PaginationQueryDto,
  ): Promise<Paginated<WineryResponseDto>> {
    return this.wineriesService.getPendingWineries(query);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @OrgType('PLATFORM')
  @Roles('SUPERADMIN', 'ADMIN', 'OPERATIONS')
  @DeprecatedRoute('/v1/platform/winery-applications/{id}/approve')
  @ApiOperation({
    deprecated: true,
    summary: 'Aprobar y certificar una bodega (solo plataforma; obsoleta, H1)',
    description:
      'Obsoleta: se retira al cerrar la Ola 1 (H1); sustituida por la aprobación de solicitudes y la activación al aceptar el dueño su invitación. Asigna el prefijo de lote. Cambia el estado de la bodega a ACTIVE y ejecuta el hook C-01 ProducerRegistry para registrarla on-chain.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Bodega aprobada y registrada exitosamente',
    type: WineryResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'Requiere la organización de plataforma activa',
  })
  @ApiNotFoundResponse({ description: 'Bodega no encontrada' })
  async approveWinery(
    @Param('id', ParseUUIDPipe) wineryId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto?: ApproveWineryDto,
  ): Promise<WineryResponseDto> {
    return this.wineriesService.approveWinery(wineryId, user.id, dto);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @OrgType('PLATFORM')
  @Roles('SUPERADMIN', 'ADMIN', 'OPERATIONS')
  @DeprecatedRoute('/v1/platform/winery-applications/{id}/reject')
  @ApiOperation({
    deprecated: true,
    summary: 'Rechazar una solicitud de bodega (solo plataforma; obsoleta, H1)',
    description:
      'Obsoleta: se retira al cerrar la Ola 1 (H1); sustituida por `POST /v1/platform/winery-applications/{id}/reject` y `POST /v1/platform/wineries/{id}/revoke`. Cambia el estado de la bodega a REJECTED registrando formalmente el motivo legal o técnico.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Bodega rechazada exitosamente',
    type: WineryResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'Requiere la organización de plataforma activa',
  })
  @ApiNotFoundResponse({ description: 'Bodega no encontrada' })
  async rejectWinery(
    @Param('id', ParseUUIDPipe) wineryId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RejectWineryDto,
  ): Promise<WineryResponseDto> {
    return this.wineriesService.rejectWinery(wineryId, user.id, dto);
  }
}
