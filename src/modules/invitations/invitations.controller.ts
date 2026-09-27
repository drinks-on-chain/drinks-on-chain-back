import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ApiErrorResponseDto } from '@shared/dto/api-error-response.dto';
import { ApiPaginatedResponse } from '@shared/decorators/api-paginated-response.decorator';
import { AppException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';
import type { Paginated } from '@shared/interfaces/api-response.interface';
import {
  AuthenticatedUser,
  CurrentUser,
} from '@shared/decorators/current-user.decorator';
import {
  OptionalAuth,
  Public,
} from '@modules/auth/decorators/public.decorator';
import { Audience } from '@modules/auth/decorators/authorization.decorators';
import { AuthResponseDto } from '@modules/auth/dto/auth-response.dto';
import { MfaChallengeResponseDto } from '@modules/auth/dto/mfa.dto';
import { readRefreshToken } from '@modules/auth/sessions/refresh-cookie';
import {
  SESSION_SETTINGS,
  SessionSettings,
} from '@modules/auth/sessions/session.config';
import {
  clientInfo,
  respondWithSession,
} from '@modules/auth/sessions/session-response';
import {
  AcceptInvitationDto,
  CreateInvitationDto,
  InvitationDto,
  InvitationPreviewDto,
  InvitationsQueryDto,
  OptionalReasonDto,
} from './dto/invitation.dto';
import { InvitationsService } from './invitations.service';

/**
 * Rutas públicas de una invitación, identificada por el token del enlace
 * (contrato O1 §2). Con el límite de `/auth/*` por IP y ruta.
 */
@ApiTags('Invitaciones')
@Controller('invitations')
export class PublicInvitationsController {
  constructor(
    private readonly invitations: InvitationsService,
    @Inject(SESSION_SETTINGS) private readonly settings: SessionSettings,
  ) {}

  @Public()
  @Get(':token')
  @ApiOperation({
    summary: 'Ver una invitación por su token',
    description:
      'Datos para la pantalla de aceptar: organización, rol, quién invita, caducidad, estado y si el correo ya tiene cuenta (`accountExists`).',
  })
  @ApiOkResponse({ type: InvitationPreviewDto })
  @ApiNotFoundResponse({
    description: 'INVITATION_NOT_FOUND',
    type: ApiErrorResponseDto,
  })
  async preview(@Param('token') token: string): Promise<InvitationPreviewDto> {
    return this.invitations.preview(token);
  }

  @Public()
  @OptionalAuth()
  @Post(':token/accept')
  @HttpCode(HttpStatus.OK)
  @ApiExtraModels(AuthResponseDto, MfaChallengeResponseDto)
  @ApiOperation({
    summary: 'Aceptar una invitación',
    description:
      'Cuenta nueva (sin sesión): `{ fullName, password }`; la cuenta nace con el correo verificado. Cuenta existente: `{}` con la sesión (acceso y cookie `doc_rt`) de la persona con **ese mismo correo**. Responde como el login con la organización invitada activa y pone la cookie `doc_rt`. Una invitación de plataforma responde el reto del segundo factor (`{ mfa }`, sin cookie): la sesión se abre con `/v1/auth/mfa/*`.',
  })
  @ApiOkResponse({
    description: 'Sesión con la organización invitada activa, o reto TOTP',
    schema: {
      oneOf: [
        { $ref: getSchemaPath(AuthResponseDto) },
        { $ref: getSchemaPath(MfaChallengeResponseDto) },
      ],
    },
  })
  @ApiUnauthorizedResponse({
    description:
      'AUTH_LOGIN_REQUIRED (la cuenta existe: iniciar sesión), AUTH_REFRESH_INVALID o acceso inválido',
    type: ApiErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description:
      'INVITATION_EMAIL_MISMATCH, ORG_REVOKED u ORG_BLOCKED_BY_PLATFORM',
    type: ApiErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'INVITATION_NOT_FOUND',
    type: ApiErrorResponseDto,
  })
  @ApiConflictResponse({
    description: 'INVITATION_NOT_PENDING u ORG_ALREADY_MEMBER',
    type: ApiErrorResponseDto,
  })
  @ApiUnprocessableEntityResponse({
    description:
      'INVITATION_EXPIRED, AUTH_WEAK_PASSWORD o VALIDATION_ERROR (faltan `fullName`/`password`)',
    type: ApiErrorResponseDto,
  })
  async accept(
    @Param('token') token: string,
    @Body() dto: AcceptInvitationDto,
    @Req() req: Request & { user?: AuthenticatedUser },
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponseDto | MfaChallengeResponseDto> {
    const outcome = await this.invitations.accept(
      token,
      dto,
      req.user ?? null,
      readRefreshToken(req, undefined),
      clientInfo(req),
    );
    if (outcome.kind === 'mfa') {
      return outcome.body;
    }
    return respondWithSession(req, res, outcome.issued, this.settings);
  }
}

/** Reenviar y anular (dueño de la organización o back office). */
@ApiTags('Invitaciones')
@ApiBearerAuth()
@Audience('STAFF')
@Controller('invitations')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Post(':id/resend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reenviar una invitación',
    description:
      'Token y caducidad nuevos (el enlace anterior deja de valer). Pendiente o caducada. La gestiona el dueño de la organización (activa) o el back office (las de usuarios internos, solo administración).',
  })
  @ApiOkResponse({ type: InvitationDto })
  @ApiNotFoundResponse({
    description: 'INVITATION_NOT_FOUND (también si es de otra organización)',
    type: ApiErrorResponseDto,
  })
  @ApiConflictResponse({
    description: 'INVITATION_NOT_PENDING',
    type: ApiErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'AUTH_INSUFFICIENT_PERMISSIONS u ORG_NOT_ACTIVE',
    type: ApiErrorResponseDto,
  })
  async resend(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OptionalReasonDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<InvitationDto> {
    return this.invitations.resend(id, user, dto.reason ?? null);
  }

  @Post(':id/revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Anular una invitación pendiente',
  })
  @ApiOkResponse({ type: InvitationDto })
  @ApiNotFoundResponse({
    description: 'INVITATION_NOT_FOUND',
    type: ApiErrorResponseDto,
  })
  @ApiConflictResponse({
    description: 'INVITATION_NOT_PENDING',
    type: ApiErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'AUTH_INSUFFICIENT_PERMISSIONS u ORG_NOT_ACTIVE',
    type: ApiErrorResponseDto,
  })
  async revoke(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OptionalReasonDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<InvitationDto> {
    return this.invitations.revoke(id, user, dto.reason ?? null);
  }
}

/**
 * Invitaciones de la organización activa (dueño de bodega o encargado de
 * punto; contrato O1 §2). La organización debe estar `ACTIVE`.
 */
@ApiTags('Invitaciones')
@ApiBearerAuth()
@Audience('STAFF')
@Controller('organizations/current/invitations')
export class CurrentOrganizationInvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  private organizationOf(user: AuthenticatedUser): string {
    const manages =
      (user.organizationType === 'WINERY' && user.role === 'OWNER') ||
      (user.organizationType === 'PICKUP_POINT' && user.role === 'MANAGER');
    if (!manages || !user.organizationId) {
      throw new AppException(
        403,
        ErrorCode.AUTH_INSUFFICIENT_PERMISSIONS,
        'Solo el dueño de la bodega (o el encargado del punto) gestiona las invitaciones',
      );
    }
    if (user.organizationStatus !== 'ACTIVE') {
      throw new AppException(
        403,
        ErrorCode.ORG_NOT_ACTIVE,
        'La organización no está activa',
        [{ field: null, message: user.organizationStatus ?? 'UNKNOWN' }],
      );
    }
    return user.organizationId;
  }

  @Get()
  @ApiOperation({
    summary: 'Invitaciones de mi organización',
    description:
      'Más recientes primero. `status` filtra por el estado presentado (una pendiente vencida es `EXPIRED`).',
  })
  @ApiPaginatedResponse(InvitationDto)
  @ApiForbiddenResponse({
    description: 'AUTH_INSUFFICIENT_PERMISSIONS u ORG_NOT_ACTIVE',
    type: ApiErrorResponseDto,
  })
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: InvitationsQueryDto,
  ): Promise<Paginated<InvitationDto>> {
    return this.invitations.list(this.organizationOf(user), query);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Invitar a alguien a mi organización',
    description:
      'Envía el correo con el enlace (caduca en `invitacion.caducidadHoras`, 72 h). El rol de dueño está reservado a la plataforma.',
  })
  @ApiCreatedResponse({ type: InvitationDto })
  @ApiForbiddenResponse({
    description:
      'ORG_OWNER_ROLE_RESERVED, AUTH_INSUFFICIENT_PERMISSIONS u ORG_NOT_ACTIVE',
    type: ApiErrorResponseDto,
  })
  @ApiConflictResponse({
    description: 'ORG_ALREADY_MEMBER o INVITATION_ALREADY_PENDING',
    type: ApiErrorResponseDto,
  })
  @ApiUnprocessableEntityResponse({
    description: 'ORG_MEMBER_LIMIT_REACHED (en `email`) o VALIDATION_ERROR',
    type: ApiErrorResponseDto,
  })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateInvitationDto,
  ): Promise<InvitationDto> {
    const organizationId = this.organizationOf(user);
    const inviter = await this.invitations.inviterName(user.id);
    return this.invitations.create({
      organizationId,
      email: dto.email,
      role: dto.role,
      invitedBy: { userId: user.id, fullName: inviter, viaPlatform: false },
    });
  }
}
