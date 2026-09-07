import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
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
  ApiConflictResponse,
} from '@nestjs/swagger';
import { WineriesService } from './wineries.service';
import { CreateWineryDto } from './dto/create-winery.dto';
import { UpdateWineryDto } from './dto/update-winery.dto';
import { AddMemberDto } from './dto/add-member.dto';
import { ApproveWineryDto } from './dto/approve-winery.dto';
import {
  WineryResponseDto,
  WineryMemberItemDto,
} from './dto/winery-response.dto';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@modules/auth/guards/roles.guard';
import { TenantGuard } from '@modules/auth/guards/tenant.guard';
import { Roles } from '@modules/auth/decorators/roles.decorator';
import { SkipTenant } from '@modules/auth/decorators/skip-tenant.decorator';
import { CurrentUser, AuthenticatedUser } from '@shared/decorators/current-user.decorator';
import { TenantId } from '@shared/decorators/tenant-id.decorator';
import { UserRoleEnum } from '@prisma/client';

@ApiTags('Bodegas y Productores')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard, RolesGuard, TenantGuard)
@Controller('v1/wineries')
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
  @ApiForbiddenResponse({ description: 'No autorizado para modificar datos de la bodega' })
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

  @Get('my/members')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Listar miembros operativos de la bodega',
    description: 'Retorna la lista de miembros activos en la bodega actual.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Lista de miembros obtenida exitosamente',
    type: [WineryMemberItemDto],
  })
  async getMyMembers(
    @TenantId() tenantId: string,
  ): Promise<WineryMemberItemDto[]> {
    return this.wineriesService.getMyMembers(tenantId);
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
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Lista de bodegas pendientes',
    type: [WineryResponseDto],
  })
  @ApiForbiddenResponse({ description: 'Requiere rol PLATFORM_ADMIN' })
  async getPendingWineries(): Promise<WineryResponseDto[]> {
    return this.wineriesService.getPendingWineries();
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
}
