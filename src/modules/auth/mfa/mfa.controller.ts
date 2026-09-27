import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ApiErrorResponseDto } from '@shared/dto/api-error-response.dto';
import { AuthService } from '../auth.service';
import { Public } from '../decorators/public.decorator';
import { AuthResponseDto } from '../dto/auth-response.dto';
import {
  MfaCodeDto,
  MfaEnrollConfirmResponseDto,
  MfaEnrollResponseDto,
  MfaTokenDto,
} from '../dto/mfa.dto';
import { SESSION_SETTINGS, SessionSettings } from '../sessions/session.config';
import { clientInfo, respondWithSession } from '../sessions/session-response';
import { MfaService } from './mfa.service';

const COOKIE =
  'Además, `Set-Cookie: doc_rt=<refresco>; HttpOnly; Secure; SameSite=Lax`';

/**
 * Segundo factor TOTP del personal de plataforma (PLT-05, contrato O1 §1).
 * Rutas públicas: la prueba es el `mfaToken` del login (5 min, un solo uso).
 * Límite de `/auth/*` por IP y ruta.
 */
@ApiTags('Autenticación')
@Controller('auth/mfa')
export class MfaController {
  constructor(
    private readonly mfa: MfaService,
    private readonly auth: AuthService,
    @Inject(SESSION_SETTINGS) private readonly settings: SessionSettings,
  ) {}

  @Public()
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Superar el segundo factor',
    description: `Con el \`mfaToken\` del login y un código TOTP de 6 dígitos (±30 s; un código no vale dos veces) o un código de recuperación (un solo uso) abre la sesión, como el login. ${COOKIE}. Cinco códigos incorrectos seguidos anulan el reto, bloquean el segundo factor 5 minutos (429 con \`Retry-After\`) y avisan por correo.`,
  })
  @ApiOkResponse({ type: AuthResponseDto, description: 'Sesión abierta' })
  @ApiUnauthorizedResponse({
    description:
      'AUTH_MFA_TOKEN_INVALID (reto caducado, usado o desconocido) o AUTH_MFA_INVALID_CODE (en `code`)',
    type: ApiErrorResponseDto,
  })
  @ApiConflictResponse({
    description: 'AUTH_MFA_NOT_ENROLLED: hay que inscribirlo primero',
    type: ApiErrorResponseDto,
  })
  @ApiTooManyRequestsResponse({
    description: 'AUTH_TOO_MANY_ATTEMPTS con `Retry-After`',
    type: ApiErrorResponseDto,
  })
  async verify(
    @Body() dto: MfaCodeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponseDto> {
    const passed = await this.mfa.verify(dto.mfaToken, dto.code);
    const issued = await this.auth.completeMfa(passed, clientInfo(req));
    return respondWithSession(req, res, issued, this.settings);
  }

  @Public()
  @Post('enroll')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Empezar a inscribir el segundo factor',
    description:
      'Con el `mfaToken` de un login con `enrolled: false`: devuelve el secreto (y la URI `otpauth://` para el QR) que hay que confirmar con `/v1/auth/mfa/enroll/confirm`. Repetirlo con el mismo reto devuelve el mismo secreto.',
  })
  @ApiOkResponse({ type: MfaEnrollResponseDto })
  @ApiUnauthorizedResponse({
    description: 'AUTH_MFA_TOKEN_INVALID',
    type: ApiErrorResponseDto,
  })
  @ApiConflictResponse({
    description: 'AUTH_MFA_ALREADY_ENROLLED: usar /v1/auth/mfa/verify',
    type: ApiErrorResponseDto,
  })
  async enroll(@Body() dto: MfaTokenDto): Promise<MfaEnrollResponseDto> {
    return this.mfa.enroll(dto.mfaToken);
  }

  @Public()
  @Post('enroll/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confirmar la inscripción del segundo factor',
    description: `Con el primer código de la app de autenticación: deja el segundo factor inscrito, abre la sesión (como el login) y devuelve 10 códigos de recuperación de un solo uso que solo se muestran esta vez. ${COOKIE}.`,
  })
  @ApiOkResponse({ type: MfaEnrollConfirmResponseDto })
  @ApiUnauthorizedResponse({
    description: 'AUTH_MFA_TOKEN_INVALID o AUTH_MFA_INVALID_CODE (en `code`)',
    type: ApiErrorResponseDto,
  })
  @ApiConflictResponse({
    description:
      'AUTH_MFA_ALREADY_ENROLLED o AUTH_MFA_ENROLLMENT_NOT_STARTED (falta /mfa/enroll)',
    type: ApiErrorResponseDto,
  })
  @ApiTooManyRequestsResponse({
    description: 'AUTH_TOO_MANY_ATTEMPTS con `Retry-After`',
    type: ApiErrorResponseDto,
  })
  async confirm(
    @Body() dto: MfaCodeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MfaEnrollConfirmResponseDto> {
    const passed = await this.mfa.confirmEnrollment(dto.mfaToken, dto.code);
    const issued = await this.auth.completeMfa(passed, clientInfo(req));
    const body = respondWithSession(req, res, issued, this.settings);
    return { ...body, recoveryCodes: passed.recoveryCodes ?? [] };
  }
}
