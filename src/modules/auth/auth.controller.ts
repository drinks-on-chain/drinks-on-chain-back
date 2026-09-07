import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { SignupDto } from './dto/signup.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { AuthResponseDto, AuthTokensDto } from './dto/auth-response.dto';
import { Public } from './decorators/public.decorator';

@ApiTags('Autenticación')
@Controller('auth')
@UseGuards(ThrottlerGuard)
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('signup')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({
    summary: 'Registrar un nuevo usuario en la plataforma',
    description:
      'Crea una nueva cuenta de usuario con contraseña hasheada y emite el primer par de tokens JWT.',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Usuario registrado exitosamente',
    type: AuthResponseDto,
  })
  @ApiBadRequestResponse({ description: 'Datos de registro inválidos' })
  @ApiConflictResponse({ description: 'El correo electrónico ya existe' })
  async signup(@Body() dto: SignupDto): Promise<AuthResponseDto> {
    return this.authService.signup(dto);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({
    summary: 'Iniciar sesión con credenciales',
    description:
      'Valida el correo electrónico y la contraseña, retornando el par de tokens y el perfil del usuario.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Autenticación exitosa',
    type: AuthResponseDto,
  })
  @ApiUnauthorizedResponse({ description: 'Credenciales inválidas' })
  async login(@Body() dto: LoginDto): Promise<AuthResponseDto> {
    return this.authService.login(dto);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({
    summary: 'Renovar tokens de acceso',
    description:
      'Emite un nuevo accessToken y refreshToken a partir de un refreshToken válido.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Tokens renovados exitosamente',
    type: AuthTokensDto,
  })
  @ApiUnauthorizedResponse({ description: 'Token de actualización inválido o expirado' })
  async refreshTokens(@Body() dto: RefreshTokenDto): Promise<AuthTokensDto> {
    return this.authService.refreshTokens(dto.refreshToken);
  }
}
