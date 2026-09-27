import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
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
  Roles,
} from '@modules/auth/decorators/authorization.decorators';
import { Public } from '@modules/auth/decorators/public.decorator';
import {
  AUTH_THROTTLER,
  DEFAULT_RATE_LIMITS,
  authRouteLimit,
} from '@modules/auth/rate-limit/app-throttler.guard';
import { platformRolesWith } from '@modules/platform-users/permissions';
import {
  AddApplicationNoteDto,
  ApproveApplicationDto,
  ApproveApplicationResponseDto,
  CreateWineryApplicationDto,
  CreateWineryApplicationResponseDto,
  MeetingDoneDto,
  RejectApplicationDto,
  ScheduleMeetingDto,
  VerifyWineryApplicationDto,
  WineryApplicationDto,
  WineryApplicationSummaryDto,
  WineryApplicationsQueryDto,
} from './dto/winery-application.dto';
import { WineryApplicationsService } from './winery-applications.service';

/** Lectura: todo el personal de plataforma (soporte, solo lectura). */
const READERS = platformRolesWith('applications', 'FULL', 'READ');
/** Tomar, notas, reunión, aprobar y rechazar: administración y operaciones. */
const WRITERS = platformRolesWith('applications', 'FULL');

const TRANSITION = {
  description: 'APPLICATION_INVALID_TRANSITION',
  type: ApiErrorResponseDto,
};
const FORBIDDEN = {
  description: 'AUTH_INSUFFICIENT_PERMISSIONS (rol)',
  type: ApiErrorResponseDto,
};
const NOT_FOUND = { description: 'NOT_FOUND', type: ApiErrorResponseDto };

/**
 * Formulario público de alta (sitio de bodegas `/unirse`; contrato O1 §3,
 * docs-back/07 §10). Con el límite de peticiones por IP de `/auth/*` y uno
 * propio para el envío.
 */
@ApiTags('Público')
@Controller('public/winery-applications')
export class PublicWineryApplicationsController {
  constructor(private readonly applications: WineryApplicationsService) {}

  @Public()
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({
    [AUTH_THROTTLER]: {
      limit: authRouteLimit(
        'RATE_LIMIT_APPLICATION_PER_MINUTE',
        DEFAULT_RATE_LIMITS.applicationPerMinute,
      ),
      ttl: 60_000,
    },
  })
  @ApiOperation({
    summary: 'Enviar una solicitud de alta de bodega',
    description:
      'Con captcha (Turnstile) y campo trampa `website`. Siempre 202 `{ id, status: UNVERIFIED }` y un correo al contacto con el enlace de verificación (`/unirse/verificar?token=`, 72 h). Campo trampa relleno, NIT ya registrado (se avisa a operaciones) o más de 3 envíos por correo / 10 por IP en una hora → 202 sin crear nada. Reenviar la misma solicitud sin verificar la actualiza y manda un enlace nuevo.',
  })
  @ApiAcceptedResponse({ type: CreateWineryApplicationResponseDto })
  @ApiUnprocessableEntityResponse({
    description: 'VALIDATION_ERROR o CAPTCHA_INVALID (en `captchaToken`)',
    type: ApiErrorResponseDto,
  })
  @ApiTooManyRequestsResponse({
    description: 'TOO_MANY_REQUESTS (por IP y minuto), con Retry-After',
    type: ApiErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'CAPTCHA_UNAVAILABLE',
    type: ApiErrorResponseDto,
  })
  async submit(
    @Body() dto: CreateWineryApplicationDto,
    @Req() req: Request,
  ): Promise<CreateWineryApplicationResponseDto> {
    return this.applications.submit(dto, { ip: req.ip ?? null });
  }

  @Public()
  @Post('verify')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Verificar el correo de contacto de una solicitud',
    description:
      'La solicitud pasa de UNVERIFIED a RECEIVED: le llega a operaciones (aviso por correo) y el contacto recibe la confirmación.',
  })
  @ApiNoContentResponse({ description: 'Solicitud verificada' })
  @ApiUnprocessableEntityResponse({
    description:
      'APPLICATION_TOKEN_INVALID (en `token`): desconocido, usado o caducado',
    type: ApiErrorResponseDto,
  })
  async verify(@Body() dto: VerifyWineryApplicationDto): Promise<void> {
    await this.applications.verify(dto);
  }
}

/** Back office · solicitudes de alta (contrato O1 §3; ORG-01, ORG-02). */
@ApiTags('Back office · solicitudes de alta')
@ApiBearerAuth()
@Audience('STAFF')
@OrgType('PLATFORM')
@Controller('platform/winery-applications')
export class PlatformWineryApplicationsController {
  constructor(private readonly applications: WineryApplicationsService) {}

  @Get()
  @Roles(...READERS)
  @ApiOperation({
    summary: 'Bandeja de solicitudes',
    description:
      'Más recientes primero, sin `notes`. Por defecto excluye las UNVERIFIED (se ven con `status=UNVERIFIED`).',
  })
  @ApiPaginatedResponse(WineryApplicationSummaryDto)
  @ApiForbiddenResponse(FORBIDDEN)
  async list(
    @Query() query: WineryApplicationsQueryDto,
  ): Promise<Paginated<WineryApplicationSummaryDto>> {
    return this.applications.list(query);
  }

  @Get(':id')
  @Roles(...READERS)
  @ApiOperation({ summary: 'Detalle de una solicitud (con notas)' })
  @ApiOkResponse({ type: WineryApplicationDto })
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse(NOT_FOUND)
  async detail(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<WineryApplicationDto> {
    return this.applications.detail(id);
  }

  @Post(':id/take')
  @Roles(...WRITERS)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Tomar una solicitud',
    description: 'RECEIVED → IN_REVIEW, asignada a quien la toma.',
  })
  @ApiOkResponse({ type: WineryApplicationDto })
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse(TRANSITION)
  async take(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WineryApplicationDto> {
    return this.applications.take(id, user);
  }

  @Post(':id/notes')
  @Roles(...WRITERS)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Añadir una nota interna',
    description: 'En cualquier estado salvo UNVERIFIED (409).',
  })
  @ApiOkResponse({ type: WineryApplicationDto })
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse(TRANSITION)
  async addNote(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddApplicationNoteDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WineryApplicationDto> {
    return this.applications.addNote(id, dto, user);
  }

  @Post(':id/schedule-meeting')
  @Roles(...WRITERS)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Agendar una reunión',
    description: 'IN_REVIEW → MEETING_SCHEDULED.',
  })
  @ApiOkResponse({ type: WineryApplicationDto })
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse(TRANSITION)
  async scheduleMeeting(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ScheduleMeetingDto,
  ): Promise<WineryApplicationDto> {
    return this.applications.scheduleMeeting(id, dto);
  }

  @Post(':id/meeting-done')
  @Roles(...WRITERS)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Registrar la reunión hecha',
    description:
      'MEETING_SCHEDULED → IN_REVIEW; las notas quedan en la reunión y como nota interna.',
  })
  @ApiOkResponse({ type: WineryApplicationDto })
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse(TRANSITION)
  async meetingDone(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MeetingDoneDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WineryApplicationDto> {
    return this.applications.meetingDone(id, dto, user);
  }

  @Post(':id/approve')
  @Roles(...WRITERS)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Aprobar una solicitud',
    description:
      'IN_REVIEW → APPROVED. En una transacción crea la bodega INVITED e invita a su dueño (por defecto, el contacto de la solicitud); avisa al contacto por correo.',
  })
  @ApiOkResponse({ type: ApproveApplicationResponseDto })
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse({
    description:
      'APPLICATION_INVALID_TRANSITION, ORG_TAX_ID_TAKEN, ORG_ALREADY_MEMBER o INVITATION_ALREADY_PENDING',
    type: ApiErrorResponseDto,
  })
  async approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveApplicationDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ApproveApplicationResponseDto> {
    return this.applications.approve(id, dto, user);
  }

  @Post(':id/reject')
  @Roles(...WRITERS)
  @RequiresReason()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rechazar una solicitud',
    description:
      'IN_REVIEW → REJECTED con motivo, que se envía al contacto por correo.',
  })
  @ApiOkResponse({ type: WineryApplicationDto })
  @ApiForbiddenResponse(FORBIDDEN)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse(TRANSITION)
  @ApiUnprocessableEntityResponse({
    description: 'VALIDATION_ERROR (falta `reason`)',
    type: ApiErrorResponseDto,
  })
  async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectApplicationDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WineryApplicationDto> {
    return this.applications.reject(id, dto, user);
  }
}
