import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { ApiErrorResponseDto } from '@shared/dto/api-error-response.dto';
import { ApiPaginatedResponse } from '@shared/decorators/api-paginated-response.decorator';
import { RequiresReason } from '@shared/audit/requires-reason';
import type { Paginated } from '@shared/interfaces/api-response.interface';
import {
  AuthenticatedUser,
  CurrentUser,
} from '@shared/decorators/current-user.decorator';
import { AppException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';
import {
  Audience,
  OrgType,
  RequireActiveOrg,
  Roles,
} from '@modules/auth/decorators/authorization.decorators';
import { Public } from '@modules/auth/decorators/public.decorator';
import { platformRolesWith } from '@modules/platform-users/permissions';
import { ROLES_BY_ORGANIZATION_TYPE } from '@modules/organizations/organization.constants';
import {
  CreatePlatformWineryDto,
  PublicWineryProfileDto,
  TransferOwnershipDto,
  UpdateCurrentOrganizationDto,
  UpdatePlatformWineryDto,
  WineriesQueryDto,
  WineryDetailDto,
  WineryStatusActionDto,
  WinerySummaryDto,
  WineryWithInvitationDto,
} from './dto/winery.dto';
import { WineryManagementService } from './winery-management.service';

/** Directorio y ficha: todo el personal de plataforma. */
const READERS = platformRolesWith('applications', 'FULL', 'READ');
/** Alta directa y edición: administración y operaciones. */
const WRITERS = platformRolesWith('applications', 'FULL');
/** Suspender y reactivar: administración y operaciones. */
const SUSPENDERS = platformRolesWith('wineries.suspend', 'FULL');
/** Revocar y transferir la titularidad: administración. */
const ADMINS = platformRolesWith('wineries.revoke', 'FULL');

const FORBIDDEN = {
  description: 'AUTH_INSUFFICIENT_PERMISSIONS (rol)',
  type: ApiErrorResponseDto,
};
const NOT_FOUND = { description: 'ORG_NOT_FOUND', type: ApiErrorResponseDto };
const NEEDS_REASON = {
  description: 'VALIDATION_ERROR (falta `reason`, 3–500 caracteres)',
  type: ApiErrorResponseDto,
};

/**
 * Back office · bodegas (contrato O1 §4; ORG-03, 07, 08, 09, 10). Toda acción
 * sobre una bodega queda en la bitácora con su motivo.
 */
@ApiTags('Back office · bodegas')
@ApiBearerAuth()
@Audience('STAFF')
@OrgType('PLATFORM')
@Controller('platform/wineries')
export class PlatformWineriesController {
  constructor(private readonly wineries: WineryManagementService) {}

  @Get()
  @Roles(...READERS)
  @ApiOperation({
    summary: 'Directorio de bodegas',
    description:
      'Ordenado por nombre comercial. `region` y `q` (razón social, nombre, NIT, slug) son coincidencias parciales.',
  })
  @ApiPaginatedResponse(WinerySummaryDto)
  @ApiForbiddenResponse(FORBIDDEN)
  async list(
    @Query() query: WineriesQueryDto,
  ): Promise<Paginated<WinerySummaryDto>> {
    return this.wineries.list(query);
  }

  @Post()
  @Roles(...WRITERS)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Alta directa de una bodega (camino B)',
    description:
      'Crea la bodega `INVITED` e invita a su dueño (`OWNER`, correo al ERP) en la misma transacción. Al aceptar, la bodega pasa a `ACTIVE` con su prefijo de lote.',
  })
  @ApiCreatedResponse({ type: WineryWithInvitationDto })
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiConflictResponse({
    description:
      'ORG_TAX_ID_TAKEN (NIT de otra bodega o de una solicitud abierta), CONFLICT (registro SENASAG), ORG_ALREADY_MEMBER o INVITATION_ALREADY_PENDING',
    type: ApiErrorResponseDto,
  })
  async create(
    @Body() dto: CreatePlatformWineryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WineryWithInvitationDto> {
    return this.wineries.createDirect(dto, user);
  }

  @Get(':id')
  @Roles(...READERS)
  @ApiOperation({
    summary: 'Ficha de una bodega (con su historial de estados)',
  })
  @ApiOkResponse({ type: WineryDetailDto })
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse(NOT_FOUND)
  async detail(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<WineryDetailDto> {
    return this.wineries.detail(id);
  }

  @Patch(':id')
  @Roles(...WRITERS)
  @RequiresReason()
  @ApiOperation({
    summary: 'Editar una bodega',
    description:
      'Todo el perfil, datos legales incluidos (razón social, NIT, categoría, región). `null` vacía un campo opcional. El `slug` no cambia.',
  })
  @ApiOkResponse({ type: WineryDetailDto })
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse({
    description: 'ORG_TAX_ID_TAKEN o CONFLICT (registro SENASAG)',
    type: ApiErrorResponseDto,
  })
  @ApiUnprocessableEntityResponse(NEEDS_REASON)
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePlatformWineryDto,
  ): Promise<WineryDetailDto> {
    return this.wineries.updateByPlatform(id, dto);
  }

  @Post(':id/suspend')
  @Roles(...SUSPENDERS)
  @RequiresReason()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Suspender una bodega',
    description:
      'Desde `ACTIVE`. Cierra al instante las sesiones con la bodega activa; el ERP responde 403 `ORG_NOT_ACTIVE` salvo el perfil y la bitácora propia. Aviso por correo al dueño.',
  })
  @ApiOkResponse({ type: WineryDetailDto })
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse({
    description: 'ORG_INVALID_TRANSITION',
    type: ApiErrorResponseDto,
  })
  @ApiUnprocessableEntityResponse(NEEDS_REASON)
  async suspend(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: WineryStatusActionDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WineryDetailDto> {
    return this.wineries.changeStatus(id, 'SUSPEND', dto.reason, user);
  }

  @Post(':id/reactivate')
  @Roles(...SUSPENDERS)
  @RequiresReason()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reactivar una bodega suspendida',
    description: 'Desde `SUSPENDED`. Aviso por correo al dueño.',
  })
  @ApiOkResponse({ type: WineryDetailDto })
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse({
    description: 'ORG_INVALID_TRANSITION',
    type: ApiErrorResponseDto,
  })
  @ApiUnprocessableEntityResponse(NEEDS_REASON)
  async reactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: WineryStatusActionDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WineryDetailDto> {
    return this.wineries.changeStatus(id, 'REACTIVATE', dto.reason, user);
  }

  @Post(':id/revoke')
  @Roles(...ADMINS)
  @RequiresReason()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Revocar una bodega (baja definitiva)',
    description:
      'Solo administración. Desde `INVITED`, `ACTIVE` o `SUSPENDED`. Cierra las sesiones con la bodega activa y anula sus invitaciones pendientes. Aviso por correo al dueño.',
  })
  @ApiOkResponse({ type: WineryDetailDto })
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse({
    description: 'ORG_INVALID_TRANSITION',
    type: ApiErrorResponseDto,
  })
  @ApiUnprocessableEntityResponse(NEEDS_REASON)
  async revoke(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: WineryStatusActionDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WineryDetailDto> {
    return this.wineries.changeStatus(id, 'REVOKE', dto.reason, user);
  }

  @Post(':id/transfer-ownership')
  @Roles(...ADMINS)
  @RequiresReason()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Transferir la titularidad',
    description:
      'Solo administración; bodega `ACTIVE` o `SUSPENDED` con dueño activo. Invita a la nueva persona titular (`OWNER`); al aceptar, la anterior queda como `ENOLOGIST` activa o bloqueada por la plataforma según `keepPreviousOwnerAs` (`BLOCKED` por defecto) y sus sesiones con la bodega se cierran. Anula una transferencia pendiente anterior.',
  })
  @ApiOkResponse({ type: WineryWithInvitationDto })
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse({
    description:
      'ORG_INVALID_TRANSITION, CONFLICT (sin dueño activo), ORG_ALREADY_MEMBER (ya es la dueña) o INVITATION_ALREADY_PENDING',
    type: ApiErrorResponseDto,
  })
  @ApiUnprocessableEntityResponse(NEEDS_REASON)
  async transferOwnership(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransferOwnershipDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WineryWithInvitationDto> {
    return this.wineries.transferOwnership(id, dto, user);
  }
}

/**
 * Perfil de la bodega activa (contrato O1 §4, ORG-07): lo leen sus miembros
 * (también con la bodega suspendida) y lo edita el dueño (sin NIT ni razón
 * social). El back office usa `/v1/platform/wineries/{id}`.
 */
@ApiTags('Bodegas y Productores')
@ApiBearerAuth()
@Audience('STAFF')
@Controller('organizations/current')
export class CurrentOrganizationController {
  constructor(private readonly wineries: WineryManagementService) {}

  private wineryOf(user: AuthenticatedUser): string {
    if (user.organizationType !== 'WINERY' || !user.organizationId) {
      throw new AppException(
        403,
        ErrorCode.AUTH_INSUFFICIENT_PERMISSIONS,
        'Requiere una bodega activa (el back office usa /v1/platform/wineries/{id})',
      );
    }
    return user.organizationId;
  }

  @Get()
  @Roles(...ROLES_BY_ORGANIZATION_TYPE.WINERY)
  @RequireActiveOrg({ allow: ['SUSPENDED'] })
  @ApiOperation({
    summary: 'Perfil de mi bodega',
    description:
      'Ficha de la bodega activa (`WineryDetail`). Se lee también con la bodega suspendida.',
  })
  @ApiOkResponse({ type: WineryDetailDto })
  @ApiForbiddenResponse({
    description:
      'AUTH_INSUFFICIENT_PERMISSIONS u ORG_NOT_ACTIVE (INVITED o REVOKED)',
    type: ApiErrorResponseDto,
  })
  async get(@CurrentUser() user: AuthenticatedUser): Promise<WineryDetailDto> {
    return this.wineries.detail(this.wineryOf(user));
  }

  @Patch()
  @Roles('OWNER')
  @RequireActiveOrg()
  @ApiOperation({
    summary: 'Editar el perfil de mi bodega (dueño)',
    description:
      'Nombre comercial, dirección, registro SENASAG, contacto, logo, historia pública y web. El NIT y la razón social solo los cambia el back office.',
  })
  @ApiOkResponse({ type: WineryDetailDto })
  @ApiForbiddenResponse({
    description:
      'AUTH_INSUFFICIENT_PERMISSIONS (no es el dueño) u ORG_NOT_ACTIVE',
    type: ApiErrorResponseDto,
  })
  @ApiConflictResponse({
    description: 'CONFLICT (registro SENASAG de otra bodega)',
    type: ApiErrorResponseDto,
  })
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateCurrentOrganizationDto,
  ): Promise<WineryDetailDto> {
    return this.wineries.updateCurrent(this.wineryOf(user), dto);
  }
}

/** Perfil público de una bodega activa (sitio de bodegas y landing). */
@ApiTags('Público')
@Controller('public/wineries')
export class PublicWineriesController {
  constructor(private readonly wineries: WineryManagementService) {}

  @Public()
  @Get(':slug')
  @ApiOperation({
    summary: 'Perfil público de una bodega',
    description:
      'Solo bodegas `ACTIVE`; cualquier otra (o un slug desconocido) → 404.',
  })
  @ApiOkResponse({ type: PublicWineryProfileDto })
  @ApiNotFoundResponse(NOT_FOUND)
  async get(@Param('slug') slug: string): Promise<PublicWineryProfileDto> {
    return this.wineries.publicProfile(slug);
  }
}
