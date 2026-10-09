import {
  Controller,
  Get,
  Patch,
  Post,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiUnauthorizedResponse,
  ApiNotFoundResponse,
  ApiNoContentResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { ApiErrorResponseDto } from '@shared/dto/api-error-response.dto';
import { AccountService } from '@modules/auth/account/account.service';
import { ChangePasswordDto } from '@modules/auth/dto/account.dto';
import { UsersService } from './users.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { MeResponseDto } from './dto/user-profile-response.dto';
import { WalletResponseDto } from '@modules/wallets/dto/wallet-response.dto';
import {
  CurrentUser,
  AuthenticatedUser,
} from '@shared/decorators/current-user.decorator';

@ApiTags('Usuarios')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly account: AccountService,
  ) {}

  @Get('me')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Obtener la persona autenticada con sus membresías',
    description:
      'Devuelve `{ user, memberships, activeOrganizationId }` (contrato O0 §5): el perfil (con `audience` y la dirección pública de su billetera custodial), todas sus membresías y la organización activa de la sesión.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Persona, membresías y organización activa',
    type: MeResponseDto,
  })
  @ApiUnauthorizedResponse({ description: 'No autenticado o token inválido' })
  @ApiNotFoundResponse({ description: 'Usuario no encontrado' })
  async getProfile(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MeResponseDto> {
    return this.usersService.getMe(user);
  }

  @Patch('me')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Actualizar mi perfil y mis preferencias',
    description:
      'Nombre, teléfono, idioma (`es`/`en`), preferencias de comunicación (`notificationPrefs`, parcial) y consentimiento de promociones (se guarda con su fecha). Responde como `GET /v1/users/me`: `{ user, memberships, activeOrganizationId }` (contrato O1 §1).',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Perfil actualizado',
    type: MeResponseDto,
  })
  @ApiUnauthorizedResponse({ description: 'No autenticado' })
  @ApiUnprocessableEntityResponse({
    description: 'VALIDATION_ERROR',
    type: ApiErrorResponseDto,
  })
  async updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateUserDto,
  ): Promise<MeResponseDto> {
    return this.usersService.updateMe(user, dto);
  }

  @Post('me/password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Cambiar mi contraseña',
    description:
      'Con la contraseña actual. Cierra las **demás** sesiones de la persona (esta sigue abierta) y avisa por correo.',
  })
  @ApiNoContentResponse({ description: 'Contraseña cambiada' })
  @ApiUnprocessableEntityResponse({
    description:
      'AUTH_INVALID_CURRENT_PASSWORD (en `currentPassword`), AUTH_WEAK_PASSWORD (en `newPassword`) o VALIDATION_ERROR',
    type: ApiErrorResponseDto,
  })
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
  ): Promise<void> {
    await this.account.changePassword(user, dto);
  }

  @Get('me/wallet')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Dirección custodial del consumidor (ruta legada)',
    description:
      'Contrato O3 §3.3 y §12.2 (SE-02): las billeteras simuladas se retiraron. El **personal** (bodega y ' +
      'plataforma) ya no tiene billetera: 404 `CHN_WALLET_NOT_AVAILABLE` (la cuenta de la bodega en la red está ' +
      'en `GET /v1/organizations/current/chain-account`). Un **consumidor** recibe su dirección custodial ' +
      'derivada (`walletType: CUSTODIAL`, `walletPurpose: CONSUMER_NFT`) cuando la tenga asignada (Ola 4); ' +
      'hasta entonces, el mismo 404. La ruta se retira en la Ola 4.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Dirección custodial del consumidor',
    type: WalletResponseDto,
  })
  @ApiUnauthorizedResponse({ description: 'No autenticado' })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description:
      'CHN_WALLET_NOT_AVAILABLE: personal, o consumidor sin dirección asignada',
    type: ApiErrorResponseDto,
  })
  async getWallet(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WalletResponseDto> {
    return this.usersService.getUserWallet(user);
  }
}
