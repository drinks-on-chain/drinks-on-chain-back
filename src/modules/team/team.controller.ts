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
import {
  Audience,
  OrgType,
  RequireActiveOrg,
  Roles,
} from '@modules/auth/decorators/authorization.decorators';
import { platformRolesWith } from '@modules/platform-users/permissions';
import { ROLES_BY_ORGANIZATION_TYPE } from '@modules/organizations/organization.constants';
import {
  MemberBlockDto,
  MemberDto,
  MembersQueryDto,
  PlatformMemberActionDto,
  PlatformUpdateMemberRoleDto,
  UpdateMemberRoleDto,
} from './dto/member.dto';
import { TeamService } from './team.service';

/** Equipo de cualquier bodega: todo el personal de plataforma (matriz §9). */
const TEAM_STAFF = platformRolesWith('team', 'FULL');

const OWNER_FORBIDDEN = {
  description:
    'AUTH_INSUFFICIENT_PERMISSIONS (no es el dueño), ORG_NOT_ACTIVE, ORG_CANNOT_MODIFY_SELF, ORG_OWNER_ROLE_RESERVED u ORG_BLOCKED_BY_PLATFORM',
  type: ApiErrorResponseDto,
};
const MEMBER_NOT_FOUND = {
  description: 'NOT_FOUND: la membresía no es de esta bodega',
  type: ApiErrorResponseDto,
};

/**
 * Equipo de la bodega activa (contrato O1 §5; EQP-04…07). El dueño ve y
 * gestiona todo; los demás roles leen solo nombres y roles de los miembros
 * activos. Bodega no `ACTIVE` → 403 `ORG_NOT_ACTIVE`.
 */
@ApiTags('Equipo')
@ApiBearerAuth()
@Audience('STAFF')
@Controller('organizations/current/members')
export class CurrentTeamController {
  constructor(private readonly team: TeamService) {}

  @Get()
  @Roles(...ROLES_BY_ORGANIZATION_TYPE.WINERY)
  @RequireActiveOrg()
  @ApiOperation({
    summary: 'Equipo de mi bodega',
    description:
      'El dueño: todos los miembros con su estado. Los demás roles: solo los activos, con nombre y rol (`lastLoginAt: null`).',
  })
  @ApiPaginatedResponse(MemberDto)
  @ApiForbiddenResponse({
    description: 'AUTH_INSUFFICIENT_PERMISSIONS u ORG_NOT_ACTIVE',
    type: ApiErrorResponseDto,
  })
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: MembersQueryDto,
  ): Promise<Paginated<MemberDto>> {
    return this.team.list(
      user.organizationId!,
      query,
      user.role === 'OWNER' ? 'FULL' : 'BASIC',
    );
  }

  @Patch(':membershipId')
  @Roles('OWNER')
  @RequireActiveOrg()
  @ApiOperation({
    summary: 'Cambiar el rol de un miembro (dueño)',
    description:
      'Rol de bodega (no `OWNER`); no a sí mismo. Cierra las sesiones de la persona con la bodega (el rol viaja en el acceso).',
  })
  @ApiOkResponse({ type: MemberDto })
  @ApiForbiddenResponse(OWNER_FORBIDDEN)
  @ApiNotFoundResponse(MEMBER_NOT_FOUND)
  async changeRole(
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @Body() dto: UpdateMemberRoleDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MemberDto> {
    return this.team.changeRole(
      user.organizationId!,
      membershipId,
      dto.role,
      { principal: user, viaPlatform: false },
      null,
    );
  }

  @Post(':membershipId/block')
  @Roles('OWNER')
  @RequireActiveOrg()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Bloquear a un miembro (dueño)',
    description:
      'No a sí mismo. Sus sesiones con la bodega se cierran al instante.',
  })
  @ApiOkResponse({ type: MemberDto })
  @ApiForbiddenResponse(OWNER_FORBIDDEN)
  @ApiNotFoundResponse(MEMBER_NOT_FOUND)
  @ApiConflictResponse({
    description: 'CONFLICT: ya bloqueado',
    type: ApiErrorResponseDto,
  })
  async block(
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @Body() dto: MemberBlockDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MemberDto> {
    return this.team.setBlocked(
      user.organizationId!,
      membershipId,
      true,
      { principal: user, viaPlatform: false },
      dto.reason ?? null,
    );
  }

  @Post(':membershipId/unblock')
  @Roles('OWNER')
  @RequireActiveOrg()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Desbloquear a un miembro (dueño)',
    description:
      'Solo lo que bloqueó el dueño (lo de la plataforma → 403 `ORG_BLOCKED_BY_PLATFORM`). Respeta el límite de colaboradores.',
  })
  @ApiOkResponse({ type: MemberDto })
  @ApiForbiddenResponse(OWNER_FORBIDDEN)
  @ApiNotFoundResponse(MEMBER_NOT_FOUND)
  @ApiConflictResponse({
    description: 'CONFLICT: no está bloqueado',
    type: ApiErrorResponseDto,
  })
  @ApiUnprocessableEntityResponse({
    description: 'ORG_MEMBER_LIMIT_REACHED',
    type: ApiErrorResponseDto,
  })
  async unblock(
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @Body() dto: MemberBlockDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MemberDto> {
    return this.team.setBlocked(
      user.organizationId!,
      membershipId,
      false,
      { principal: user, viaPlatform: false },
      dto.reason ?? null,
    );
  }
}

/**
 * Back office · equipo de cualquier bodega (contrato O1 §5; EQP-08, EQP-10).
 * Con motivo obligatorio y aviso por correo al dueño salvo que sea el
 * afectado. Incluye el estado de la cuenta completa (§11 bis).
 */
@ApiTags('Back office · equipos')
@ApiBearerAuth()
@Audience('STAFF')
@OrgType('PLATFORM')
@Roles(...TEAM_STAFF)
@Controller('platform/organizations/:organizationId/members')
export class PlatformTeamController {
  constructor(private readonly team: TeamService) {}

  @Get()
  @ApiOperation({ summary: 'Equipo de una bodega' })
  @ApiPaginatedResponse(MemberDto)
  @ApiNotFoundResponse({
    description: 'ORG_NOT_FOUND (no es una bodega)',
    type: ApiErrorResponseDto,
  })
  async list(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Query() query: MembersQueryDto,
  ): Promise<Paginated<MemberDto>> {
    await this.team.wineryOrganization(organizationId);
    return this.team.list(organizationId, query, 'PLATFORM');
  }

  @Patch(':membershipId')
  @RequiresReason()
  @ApiOperation({
    summary: 'Cambiar el rol de un miembro',
    description:
      'Con motivo. `OWNER` no se asigna ni se quita (transferencia de titularidad). Avisa al dueño y cierra las sesiones de la persona con la bodega.',
  })
  @ApiOkResponse({ type: MemberDto })
  @ApiForbiddenResponse({
    description:
      'AUTH_INSUFFICIENT_PERMISSIONS, ORG_OWNER_ROLE_RESERVED u ORG_CANNOT_MODIFY_SELF',
    type: ApiErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'ORG_NOT_FOUND o NOT_FOUND (membresía de otra organización)',
    type: ApiErrorResponseDto,
  })
  @ApiUnprocessableEntityResponse({
    description: 'VALIDATION_ERROR (falta `reason`)',
    type: ApiErrorResponseDto,
  })
  async changeRole(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @Body() dto: PlatformUpdateMemberRoleDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MemberDto> {
    await this.team.wineryOrganization(organizationId);
    return this.team.changeRole(
      organizationId,
      membershipId,
      dto.role,
      { principal: user, viaPlatform: true },
      dto.reason,
    );
  }

  @Post(':membershipId/block')
  @RequiresReason()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Bloquear a un miembro',
    description:
      'Con motivo; queda bloqueado por la plataforma (el dueño no puede desbloquearlo). Sus sesiones con la bodega se cierran al instante. Avisa al dueño.',
  })
  @ApiOkResponse({ type: MemberDto })
  @ApiNotFoundResponse({
    description: 'ORG_NOT_FOUND o NOT_FOUND',
    type: ApiErrorResponseDto,
  })
  @ApiConflictResponse({
    description: 'CONFLICT: ya bloqueado',
    type: ApiErrorResponseDto,
  })
  async block(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @Body() dto: PlatformMemberActionDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MemberDto> {
    await this.team.wineryOrganization(organizationId);
    return this.team.setBlocked(
      organizationId,
      membershipId,
      true,
      { principal: user, viaPlatform: true },
      dto.reason,
    );
  }

  @Post(':membershipId/unblock')
  @RequiresReason()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Desbloquear a un miembro',
    description:
      'Con motivo (lo bloqueara el dueño o la plataforma). Respeta el límite de colaboradores. Avisa al dueño.',
  })
  @ApiOkResponse({ type: MemberDto })
  @ApiNotFoundResponse({
    description: 'ORG_NOT_FOUND o NOT_FOUND',
    type: ApiErrorResponseDto,
  })
  @ApiConflictResponse({
    description: 'CONFLICT: no está bloqueado',
    type: ApiErrorResponseDto,
  })
  @ApiUnprocessableEntityResponse({
    description: 'ORG_MEMBER_LIMIT_REACHED o VALIDATION_ERROR',
    type: ApiErrorResponseDto,
  })
  async unblock(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @Body() dto: PlatformMemberActionDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MemberDto> {
    await this.team.wineryOrganization(organizationId);
    return this.team.setBlocked(
      organizationId,
      membershipId,
      false,
      { principal: user, viaPlatform: true },
      dto.reason,
    );
  }
}
