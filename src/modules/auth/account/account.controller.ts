import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiNoContentResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { ApiErrorResponseDto } from '@shared/dto/api-error-response.dto';
import { Public } from '../decorators/public.decorator';
import {
  ForgotPasswordDto,
  ResendVerificationDto,
  ResetPasswordDto,
  VerifyEmailDto,
} from '../dto/account.dto';
import { AccountService } from './account.service';

/**
 * Recuperación de contraseña y verificación del correo (IAM-05, IAM-06;
 * contrato O1 §1). Públicas, con captcha donde se envía un correo y el límite
 * de `/auth/*` por IP y ruta.
 */
@ApiTags('Autenticación')
@Controller('auth')
export class AccountController {
  constructor(private readonly account: AccountService) {}

  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Pedir un enlace para restablecer la contraseña',
    description:
      'Siempre 202 (no revela si el correo tiene cuenta). Si la tiene y está activa, envía un enlace de un solo uso que caduca en 60 minutos a la app de `X-Client-App` (ERP por defecto). Con captcha (Turnstile) y campo trampa `website`.',
  })
  @ApiAcceptedResponse({ description: 'Petición recibida (`data: null`)' })
  @ApiUnprocessableEntityResponse({
    description: 'VALIDATION_ERROR o CAPTCHA_INVALID (en `captchaToken`)',
    type: ApiErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'CAPTCHA_UNAVAILABLE: no se pudo comprobar el captcha',
    type: ApiErrorResponseDto,
  })
  async forgotPassword(
    @Body() dto: ForgotPasswordDto,
    @Req() req: Request,
  ): Promise<null> {
    await this.account.forgotPassword(dto, { ip: req.ip ?? null });
    return null;
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Elegir una contraseña nueva con el enlace del correo',
    description:
      'Cambia la contraseña, gasta el enlace, cierra **todas** las sesiones de la persona y le avisa por correo.',
  })
  @ApiNoContentResponse({ description: 'Contraseña cambiada' })
  @ApiUnprocessableEntityResponse({
    description:
      'AUTH_RESET_TOKEN_INVALID (en `token`), AUTH_WEAK_PASSWORD (en `password`) o VALIDATION_ERROR',
    type: ApiErrorResponseDto,
  })
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<void> {
    await this.account.resetPassword(dto);
  }

  @Public()
  @Post('verify-email')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Confirmar el correo con el enlace recibido',
  })
  @ApiNoContentResponse({ description: 'Correo verificado' })
  @ApiUnprocessableEntityResponse({
    description: 'AUTH_EMAIL_TOKEN_INVALID (en `token`)',
    type: ApiErrorResponseDto,
  })
  async verifyEmail(@Body() dto: VerifyEmailDto): Promise<void> {
    await this.account.verifyEmail(dto);
  }

  @Public()
  @Post('resend-verification')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Reenviar el enlace de verificación del correo',
    description:
      'Siempre 202. Si el correo tiene una cuenta activa sin verificar, envía un enlace nuevo (el anterior deja de valer). Con captcha y campo trampa `website`.',
  })
  @ApiAcceptedResponse({ description: 'Petición recibida (`data: null`)' })
  @ApiUnprocessableEntityResponse({
    description: 'VALIDATION_ERROR o CAPTCHA_INVALID (en `captchaToken`)',
    type: ApiErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: 'CAPTCHA_UNAVAILABLE',
    type: ApiErrorResponseDto,
  })
  async resendVerification(
    @Body() dto: ResendVerificationDto,
    @Req() req: Request,
  ): Promise<null> {
    await this.account.resendVerification(dto, { ip: req.ip ?? null });
    return null;
  }
}
