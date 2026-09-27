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
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@modules/auth/guards/roles.guard';
import { TenantGuard } from '@modules/auth/guards/tenant.guard';
import { Roles } from '@modules/auth/decorators/roles.decorator';
import { SkipTenant } from '@modules/auth/decorators/skip-tenant.decorator';
import {
  CurrentUser,
  AuthenticatedUser,
} from '@shared/decorators/current-user.decorator';
import { TenantId } from '@shared/decorators/tenant-id.decorator';
import { UserRoleEnum } from '@prisma/client';
import { ApiPaginatedResponse } from '@shared/decorators/api-paginated-response.decorator';
import { PaginationQueryDto } from '@shared/dto/pagination-query.dto';
import type { Paginated } from '@shared/interfaces/api-response.interface';

@ApiTags('Bodegas y Productores')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, TenantGuard)
@Controller('wineries')
export class WineriesController {
  constructor(private readonly wineriesService: WineriesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @SkipTenant()
  @ApiOperation({
    summary: 'Solicitar alta y registro de una nueva bodega',
    description:
      'Crea una bodega en estado PENDING, asocia al creador como OWNER y asigna una billetera custodial institucional.',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Bodega registrada exitosamente en estado PENDING',
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
  @SkipTenant()
  @Roles(UserRoleEnum.PLATFORM_ADMIN)
  @ApiOperation({
    summary: 'Listar todas las bodegas registradas (Solo Platform Admin)',
    description:
      'Retorna el directorio completo de bodegas con soporte de filtros por estado, categoría y paginación.',
  })
  @ApiForbiddenResponse({ description: 'Requiere rol PLATFORM_ADMIN' })
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
  async getMyWinery(@TenantId() tenantId: string): Promise<WineryResponseDto> {
    return this.wineriesService.getMyWinery(tenantId);
  }

  @Patch('my')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRoleEnum.WINERY_ADMIN, UserRoleEnum.PLATFORM_ADMIN)
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
  @Roles(UserRoleEnum.WINERY_ADMIN, UserRoleEnum.PLATFORM_ADMIN)
  @ApiOperation({
    summary: 'Incorporar un nuevo miembro operativo a la bodega',
    description:
      'Asocia a un usuario existente como enólogo, agrónomo, operador o contador de la bodega.',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Miembro incorporado exitosamente',
    type: WineryMemberItemDto,
  })
  @ApiConflictResponse({ description: 'El usuario ya es miembro de la bodega' })
  @ApiNotFoundResponse({ description: 'El usuario no existe' })
  async addMember(
    @TenantId() tenantId: string,
    @Body() dto: AddMemberDto,
  ): Promise<WineryMemberItemDto> {
    return this.wineriesService.addMember(tenantId, dto);
  }

  @Post('my/members/create')
  @HttpCode(HttpStatus.CREATED)
  @Roles(UserRoleEnum.WINERY_ADMIN, UserRoleEnum.PLATFORM_ADMIN)
  @ApiOperation({
    summary:
      'Registrar y dar de alta a un nuevo miembro operativo en la bodega',
    description:
      'Crea la cuenta de usuario, aprovisiona su billetera custodial y lo asocia a la bodega en un solo paso.',
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
  @ApiOperation({
    summary: 'Listar miembros operativos de la bodega',
    description: 'Retorna la lista de miembros activos en la bodega actual.',
  })
  @ApiPaginatedResponse(WineryMemberItemDto, {
    description: 'Página de miembros activos de la bodega',
  })
  async getMyMembers(
    @TenantId() tenantId: string,
    @Query() query: PaginationQueryDto,
  ): Promise<Paginated<WineryMemberItemDto>> {
    return this.wineriesService.getMyMembers(tenantId, query);
  }

  @Get('pending')
  @HttpCode(HttpStatus.OK)
  @SkipTenant()
  @Roles(UserRoleEnum.PLATFORM_ADMIN)
  @ApiOperation({
    summary: 'Listar bodegas pendientes de aprobación (Solo Platform Admin)',
    description:
      'Obtiene todas las solicitudes de bodegas en estado PENDING para revisión y certificación legal.',
  })
  @ApiForbiddenResponse({ description: 'Requiere rol PLATFORM_ADMIN' })
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
  @SkipTenant()
  @Roles(UserRoleEnum.PLATFORM_ADMIN)
  @ApiOperation({
    summary: 'Aprobar y certificar una bodega (Solo Platform Admin)',
    description:
      'Cambia el estado de la bodega a ACTIVE y ejecuta el hook C-01 ProducerRegistry para registrarla on-chain.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Bodega aprobada y registrada exitosamente',
    type: WineryResponseDto,
  })
  @ApiForbiddenResponse({ description: 'Requiere rol PLATFORM_ADMIN' })
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
  @SkipTenant()
  @Roles(UserRoleEnum.PLATFORM_ADMIN)
  @ApiOperation({
    summary: 'Rechazar una solicitud de bodega (Solo Platform Admin)',
    description:
      'Cambia el estado de la bodega a REJECTED registrando formalmente el motivo legal o técnico.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Bodega rechazada exitosamente',
    type: WineryResponseDto,
  })
  @ApiForbiddenResponse({ description: 'Requiere rol PLATFORM_ADMIN' })
  @ApiNotFoundResponse({ description: 'Bodega no encontrada' })
  async rejectWinery(
    @Param('id', ParseUUIDPipe) wineryId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RejectWineryDto,
  ): Promise<WineryResponseDto> {
    return this.wineriesService.rejectWinery(wineryId, user.id, dto);
  }
}
