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
  ApiAcceptedResponse,
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
import type { Paginated } from '@shared/interfaces/api-response.interface';
import {
  AuthenticatedUser,
  CurrentUser,
} from '@shared/decorators/current-user.decorator';
import {
  Audience,
  OrgType,
  Roles,
} from '@modules/auth/decorators/authorization.decorators';
import {
  CreatePlatformUserDto,
  InvitationDto,
  InvitationsQueryDto,
  OptionalReasonDto,
  PlatformCreateInvitationDto,
  RequiredReasonDto,
} from '@modules/invitations/dto/invitation.dto';
import {
  AccountDetailDto,
  PermissionMatrixDto,
  PlatformUserDto,
  PlatformUsersQueryDto,
  UpdatePlatformUserDto,
  UserAccountStatusDto,
} from './dto/platform-users.dto';
import { PlatformUsersService } from './platform-users.service';
import { permissionMatrix, platformRolesWith } from './permissions';

/** Usuarios internos: administración (y el superusuario). */
const USER_ADMINS = platformRolesWith('platform.users', 'FULL');
/** Equipo de cualquier organización: todo el personal de plataforma. */
const TEAM_STAFF = platformRolesWith('team', 'FULL');
/** Bloquear la cuenta completa: administración. */
const ACCOUNT_ADMINS = platformRolesWith('wineries.revoke', 'FULL');

const FORBIDDEN = {
  description:
    'AUTH_INSUFFICIENT_PERMISSIONS (rol), PLATFORM_SUPERADMIN_PROTECTED u ORG_CANNOT_MODIFY_SELF',
  type: ApiErrorResponseDto,
};

/**
 * Back office · usuarios internos y acciones sobre personas (PLT-02…05,
 * contrato O1 §5). Organización activa de plataforma (que exige el segundo
 * factor en la sesión); permisos de la matriz de `permissions.ts`.
 */
@ApiTags('Back office · usuarios internos')
@ApiBearerAuth()
@Audience('STAFF')
@OrgType('PLATFORM')
@Controller('platform')
export class PlatformUsersController {
  constructor(private readonly platformUsers: PlatformUsersService) {}

  @Get('permissions')
  @ApiOperation({
    summary: 'Matriz de permisos por rol',
    description:
      'Cada capacidad con el nivel de cada rol (FULL, READ, OWN, NONE). Es la misma matriz que aplican las rutas del back office (PLT-04).',
  })
  @ApiOkResponse({ type: PermissionMatrixDto })
  permissions(): PermissionMatrixDto {
    return permissionMatrix();
  }

  @Get('users')
  @Roles(...USER_ADMINS)
  @ApiOperation({
    summary: 'Usuarios internos',
    description:
      'Miembros de la organización de plataforma y las invitaciones pendientes (`status: INVITED`, `membershipId: null`, con `invitationId`).',
  })
  @ApiPaginatedResponse(PlatformUserDto)
  @ApiForbiddenResponse(FORBIDDEN)
  async list(
    @Query() query: PlatformUsersQueryDto,
  ): Promise<Paginated<PlatformUserDto>> {
    return this.platformUsers.list(query);
  }

  @Post('users')
  @Roles(...USER_ADMINS)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Invitar a un usuario interno',
    description:
      '`ADMIN`, `OPERATIONS` o `SUPPORT` (`SUPERADMIN` no se asigna). El correo lleva al Backoffice; al aceptar, la persona inscribe su segundo factor.',
  })
  @ApiCreatedResponse({ type: InvitationDto })
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiConflictResponse({
    description: 'ORG_ALREADY_MEMBER o INVITATION_ALREADY_PENDING',
    type: ApiErrorResponseDto,
  })
  async invite(
    @Body() dto: CreatePlatformUserDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<InvitationDto> {
    return this.platformUsers.invite(dto, user);
  }

  @Patch('users/:membershipId')
  @Roles(...USER_ADMINS)
  @ApiOperation({
    summary: 'Cambiar el rol de un usuario interno',
    description:
      'Con motivo. Cierra sus sesiones de plataforma (el rol viaja en el acceso). El superusuario no se degrada.',
  })
  @ApiOkResponse({ type: PlatformUserDto })
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse({
    description: 'NOT_FOUND: no es una membresía de plataforma',
    type: ApiErrorResponseDto,
  })
  @ApiUnprocessableEntityResponse({
    description: 'VALIDATION_ERROR (falta `reason`)',
    type: ApiErrorResponseDto,
  })
  async update(
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @Body() dto: UpdatePlatformUserDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PlatformUserDto> {
    return this.platformUsers.update(membershipId, dto, user);
  }

  @Post('users/:membershipId/block')
  @Roles(...USER_ADMINS)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Bloquear la membresía de plataforma de un usuario interno',
    description:
      'Solo el id de una **membresía** de plataforma (la cuenta completa: `/v1/platform/accounts/{userId}/block`). Cierra sus sesiones de plataforma al instante.',
  })
  @ApiOkResponse({ type: PlatformUserDto })
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse({ description: 'NOT_FOUND', type: ApiErrorResponseDto })
  @ApiConflictResponse({
    description: 'CONFLICT: ya bloqueado',
    type: ApiErrorResponseDto,
  })
  async block(
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @Body() dto: RequiredReasonDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PlatformUserDto> {
    return this.platformUsers.setMembershipBlocked(
      membershipId,
      true,
      dto.reason,
      user,
    );
  }

  @Post('users/:membershipId/unblock')
  @Roles(...USER_ADMINS)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Desbloquear la membresía de plataforma' })
  @ApiOkResponse({ type: PlatformUserDto })
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse({ description: 'NOT_FOUND', type: ApiErrorResponseDto })
  @ApiConflictResponse({
    description: 'CONFLICT: no está bloqueado',
    type: ApiErrorResponseDto,
  })
  async unblock(
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @Body() dto: RequiredReasonDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PlatformUserDto> {
    return this.platformUsers.setMembershipBlocked(
      membershipId,
      false,
      dto.reason,
      user,
    );
  }

  @Post('users/:membershipId/reset-mfa')
  @Roles(...USER_ADMINS)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Restablecer el segundo factor de un usuario interno',
    description:
      'Borra su TOTP y sus códigos de recuperación, cierra todas sus sesiones y le avisa por correo: inscribirá de nuevo al entrar. El del superusuario solo lo restablece otro superusuario.',
  })
  @ApiOkResponse({ type: PlatformUserDto })
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse({ description: 'NOT_FOUND', type: ApiErrorResponseDto })
  async resetMfa(
    @Param('membershipId', ParseUUIDPipe) membershipId: string,
    @Body() dto: RequiredReasonDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PlatformUserDto> {
    return this.platformUsers.resetMfa(membershipId, dto.reason, user);
  }

  @Post('users/:userId/send-password-reset')
  @Roles(...TEAM_STAFF)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Enviar a una persona un enlace para restablecer su contraseña',
    description:
      'Enlace de un solo uso (60 min) al Backoffice si es personal de plataforma o al ERP si no. Nunca se envían contraseñas.',
  })
  @ApiAcceptedResponse({
    description: 'Enviado (`data: null`)',
    schema: { type: 'object', nullable: true, example: null },
  })
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse({
    description: 'USER_NOT_FOUND',
    type: ApiErrorResponseDto,
  })
  async sendPasswordReset(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: OptionalReasonDto,
  ): Promise<null> {
    await this.platformUsers.sendPasswordReset(userId, dto.reason ?? null);
    return null;
  }

  @Get('accounts/:userId')
  @Roles(...TEAM_STAFF)
  @ApiOperation({
    summary: 'Estado de la cuenta completa de una persona',
    description:
      'Ampliación del contrato O1: estado (ACTIVE/BLOCKED), motivo y fecha del bloqueo y todas sus membresías.',
  })
  @ApiOkResponse({ type: AccountDetailDto })
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse({
    description: 'USER_NOT_FOUND',
    type: ApiErrorResponseDto,
  })
  async account(
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<AccountDetailDto> {
    return this.platformUsers.accountDetail(userId);
  }

  @Post('accounts/:userId/block')
  @Roles(...ACCOUNT_ADMINS)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Bloquear la cuenta completa de una persona',
    description:
      'No entra a ningún sistema y todas sus sesiones se cierran al instante. Solo administración; el superusuario está protegido.',
  })
  @ApiOkResponse({ type: UserAccountStatusDto })
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse({
    description: 'USER_NOT_FOUND',
    type: ApiErrorResponseDto,
  })
  @ApiConflictResponse({
    description: 'CONFLICT: ya bloqueada',
    type: ApiErrorResponseDto,
  })
  async blockAccount(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: RequiredReasonDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<UserAccountStatusDto> {
    return this.platformUsers.setAccountBlocked(userId, true, dto.reason, user);
  }

  @Post('accounts/:userId/unblock')
  @Roles(...ACCOUNT_ADMINS)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Desbloquear la cuenta completa de una persona' })
  @ApiOkResponse({ type: UserAccountStatusDto })
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse({
    description: 'USER_NOT_FOUND',
    type: ApiErrorResponseDto,
  })
  @ApiConflictResponse({
    description: 'CONFLICT: no está bloqueada',
    type: ApiErrorResponseDto,
  })
  async unblockAccount(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: RequiredReasonDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<UserAccountStatusDto> {
    return this.platformUsers.setAccountBlocked(
      userId,
      false,
      dto.reason,
      user,
    );
  }

  @Get('organizations/:organizationId/invitations')
  @Roles(...TEAM_STAFF)
  @ApiOperation({
    summary: 'Invitaciones de una bodega',
    description:
      'Ampliación del contrato O1. Más recientes primero; status filtra por el estado presentado (una pendiente vencida es EXPIRED).',
  })
  @ApiPaginatedResponse(InvitationDto)
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse({
    description: 'ORG_NOT_FOUND',
    type: ApiErrorResponseDto,
  })
  async organizationInvitations(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Query() query: InvitationsQueryDto,
  ): Promise<Paginated<InvitationDto>> {
    return this.platformUsers.organizationInvitations(organizationId, query);
  }

  @Post('organizations/:organizationId/invitations')
  @Roles(...TEAM_STAFF)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Invitar a una persona al equipo de una bodega',
    description:
      'En nombre de la bodega (`ACTIVE` o `SUSPENDED`), con motivo opcional; avisa por correo al dueño (EQP-10). El rol de dueño está reservado al alta y a la transferencia.',
  })
  @ApiCreatedResponse({ type: InvitationDto })
  @ApiForbiddenResponse({
    description:
      'AUTH_INSUFFICIENT_PERMISSIONS, ORG_OWNER_ROLE_RESERVED u ORG_NOT_ACTIVE',
    type: ApiErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'ORG_NOT_FOUND (no es una bodega)',
    type: ApiErrorResponseDto,
  })
  @ApiConflictResponse({
    description: 'ORG_ALREADY_MEMBER o INVITATION_ALREADY_PENDING',
    type: ApiErrorResponseDto,
  })
  @ApiUnprocessableEntityResponse({
    description: 'ORG_MEMBER_LIMIT_REACHED o VALIDATION_ERROR',
    type: ApiErrorResponseDto,
  })
  async inviteToOrganization(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() dto: PlatformCreateInvitationDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<InvitationDto> {
    return this.platformUsers.inviteToOrganization(organizationId, dto, user);
  }
}
