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
  ApiBearerAuth,
  ApiConflictResponse,
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { ApiErrorResponseDto } from '@shared/dto/api-error-response.dto';
import {
  AuthenticatedUser,
  CurrentUser,
} from '@shared/decorators/current-user.decorator';
import { AuthService, IssuedSession } from './auth.service';
import { SignupDto } from './dto/signup.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { SwitchOrganizationDto } from './dto/switch-organization.dto';
import { AuthResponseDto } from './dto/auth-response.dto';
import { MfaChallengeResponseDto } from './dto/mfa.dto';
import { Public } from './decorators/public.decorator';
import { bearerToken } from './guards/access-token.guard';
import {
  clearRefreshCookie,
  readRefreshToken,
  useSecureCookie,
} from './sessions/refresh-cookie';
import { SESSION_SETTINGS, SessionSettings } from './sessions/session.config';
import { clientInfo, respondWithSession } from './sessions/session-response';
import {
  AUTH_THROTTLER,
  DEFAULT_RATE_LIMITS,
  authRouteLimit,
} from './rate-limit/app-throttler.guard';

const SET_COOKIE_DESCRIPTION =
  'Además, `Set-Cookie: doc_rt=<refresco>; Max-Age=<7 días personal | 30 consumidores>; Path=/; HttpOnly; Secure; SameSite=Lax`';

@ApiTags('Autenticación')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    @Inject(SESSION_SETTINGS) private readonly settings: SessionSettings,
  ) {}

  private send(
    req: Request,
    res: Response,
    issued: IssuedSession,
  ): AuthResponseDto {
    return respondWithSession(req, res, issued, this.settings);
  }

  @Public()
  @Post('signup')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({
    [AUTH_THROTTLER]: {
      limit: authRouteLimit(
        'RATE_LIMIT_SIGNUP_PER_MINUTE',
        DEFAULT_RATE_LIMITS.signupPerMinute,
      ),
      ttl: 60_000,
    },
  })
  @ApiOperation({
    summary: 'Registrar un nuevo usuario en la plataforma',
    description: `Crea la cuenta (contraseña con bcrypt), su billetera custodial y abre una sesión. ${SET_COOKIE_DESCRIPTION}.`,
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Usuario registrado y sesión abierta',
    type: AuthResponseDto,
  })
  @ApiUnprocessableEntityResponse({
    description: 'VALIDATION_ERROR: datos de registro inválidos',
    type: ApiErrorResponseDto,
  })
  @ApiConflictResponse({ description: 'El correo electrónico ya existe' })
  async signup(
    @Body() dto: SignupDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponseDto> {
    return this.send(
      req,
      res,
      await this.authService.signup(dto, clientInfo(req)),
    );
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({
    [AUTH_THROTTLER]: {
      limit: authRouteLimit(
        'RATE_LIMIT_LOGIN_PER_MINUTE',
        DEFAULT_RATE_LIMITS.loginPerMinute,
      ),
      ttl: 60_000,
    },
  })
  @ApiOperation({
    summary: 'Iniciar sesión con credenciales',
    description: `Valida correo y contraseña y abre una sesión: persona (con \`audience\`), membresías, organización activa (la última usada o la primera activa, plataforma antes que bodega) y tokens (acceso de 15 min). ${SET_COOKIE_DESCRIPTION}. **Personal de plataforma** (membresía de plataforma activa): responde \`{ mfa: { required, enrolled, mfaToken } }\` sin tokens ni cookie; la sesión se abre con \`/v1/auth/mfa/verify\` o, la primera vez, \`/v1/auth/mfa/enroll\` + \`/v1/auth/mfa/enroll/confirm\` (PLT-05). Tras varios fallos seguidos (por correo o por IP) responde 429 \`AUTH_TOO_MANY_ATTEMPTS\` con \`Retry-After\` (bloqueo progresivo).`,
  })
  @ApiExtraModels(AuthResponseDto, MfaChallengeResponseDto)
  @ApiResponse({
    status: HttpStatus.OK,
    description:
      'Sesión abierta o, para el personal de plataforma, reto del segundo factor',
    schema: {
      oneOf: [
        { $ref: getSchemaPath(AuthResponseDto) },
        { $ref: getSchemaPath(MfaChallengeResponseDto) },
      ],
    },
  })
  @ApiUnauthorizedResponse({
    description: 'AUTH_INVALID_CREDENTIALS',
    type: ApiErrorResponseDto,
  })
  @ApiTooManyRequestsResponse({
    description: 'AUTH_TOO_MANY_ATTEMPTS o TOO_MANY_REQUESTS, con Retry-After',
    type: ApiErrorResponseDto,
  })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponseDto | MfaChallengeResponseDto> {
    const outcome = await this.authService.login(dto, clientInfo(req));
    if (outcome.kind === 'mfa') {
      return outcome.body;
    }
    return this.send(req, res, outcome.issued);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({
    [AUTH_THROTTLER]: {
      limit: authRouteLimit(
        'RATE_LIMIT_REFRESH_PER_MINUTE',
        DEFAULT_RATE_LIMITS.refreshPerMinute,
      ),
      ttl: 60_000,
    },
  })
  @ApiOperation({
    summary: 'Renovar la sesión (rotativa)',
    description: `Lee el refresco de la cookie \`doc_rt\` (o, hasta H1, del cuerpo), lo rota y responde como el login. ${SET_COOKIE_DESCRIPTION}. Un refresco ya rotado presentado otra vez dentro del periodo de gracia (20 s) devuelve el mismo par nuevo; fuera de él revoca la sesión (401 \`AUTH_REFRESH_REUSED\`).`,
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Sesión renovada',
    type: AuthResponseDto,
  })
  @ApiUnauthorizedResponse({
    description:
      'AUTH_REFRESH_INVALID, AUTH_REFRESH_REUSED, AUTH_SESSION_REVOKED o AUTH_SESSION_EXPIRED',
    type: ApiErrorResponseDto,
  })
  async refreshTokens(
    @Body() dto: RefreshTokenDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponseDto> {
    return this.send(
      req,
      res,
      await this.authService.refresh(readRefreshToken(req, dto?.refreshToken)),
    );
  }

  @Post('switch-organization')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Cambiar la organización activa',
    description: `Misma sesión (\`sid\`), tokens nuevos con la organización elegida. Necesita el acceso vigente y el refresco de esa sesión (cookie \`doc_rt\` o, hasta H1, el cuerpo), que se rota. ${SET_COOKIE_DESCRIPTION}.`,
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Organización activa cambiada',
    type: AuthResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'ORG_NOT_FOUND: sin membresía en esa organización',
    type: ApiErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description:
      'ORG_MEMBERSHIP_BLOCKED (membresía bloqueada), ORG_REVOKED (organización revocada) o AUTH_MFA_REQUIRED (organización de plataforma sin segundo factor en la sesión)',
    type: ApiErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'Acceso inválido o AUTH_REFRESH_INVALID (falta el refresco)',
    type: ApiErrorResponseDto,
  })
  async switchOrganization(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SwitchOrganizationDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponseDto> {
    return this.send(
      req,
      res,
      await this.authService.switchOrganization(
        user,
        dto.organizationId,
        readRefreshToken(req, dto.refreshToken),
      ),
    );
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiHeader({
    name: 'Authorization',
    required: false,
    description:
      'Bearer con el acceso (aunque haya caducado); si falta, se usa el refresco',
  })
  @ApiOperation({
    summary: 'Cerrar la sesión actual',
    description:
      'Revoca la sesión (identificada por el acceso, aunque haya caducado, o por el refresco) y borra la cookie (`doc_rt=; Max-Age=0`). Siempre 204.',
  })
  @ApiNoContentResponse({ description: 'Sesión cerrada' })
  async logout(
    @Body() dto: RefreshTokenDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.authService.logout(
      bearerToken(req),
      readRefreshToken(req, dto?.refreshToken),
    );
    clearRefreshCookie(res, useSecureCookie(this.settings.nodeEnv, req));
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Cerrar todas las sesiones de la persona',
    description:
      'Revoca todas sus sesiones (todas las pestañas y dispositivos) y borra la cookie. Los accesos vigentes dejan de valer en la siguiente petición.',
  })
  @ApiNoContentResponse({ description: 'Sesiones cerradas' })
  async logoutAll(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.authService.logoutAll(user);
    clearRefreshCookie(res, useSecureCookie(this.settings.nodeEnv, req));
  }
}
