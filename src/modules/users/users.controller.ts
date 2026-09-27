import {
  Controller,
  Get,
  Patch,
  Body,
  UseGuards,
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
} from '@nestjs/swagger';
import { UsersService } from './users.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserProfileResponseDto } from './dto/user-profile-response.dto';
import { WalletResponseDto } from '@modules/wallets/dto/wallet-response.dto';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import {
  CurrentUser,
  AuthenticatedUser,
} from '@shared/decorators/current-user.decorator';

@ApiTags('Usuarios')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Obtener el perfil del usuario autenticado',
    description:
      'Retorna los datos de identidad, roles, membresías en bodegas y dirección pública de su billetera custodial.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Perfil de usuario obtenido exitosamente',
    type: UserProfileResponseDto,
  })
  @ApiUnauthorizedResponse({ description: 'No autenticado o token inválido' })
  @ApiNotFoundResponse({ description: 'Usuario no encontrado' })
  async getProfile(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<UserProfileResponseDto> {
    return this.usersService.getProfile(user.id);
  }

  @Patch('me')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Actualizar datos de perfil del usuario',
    description:
      'Permite modificar nombre completo, teléfono y preferencia de idioma.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Perfil de usuario actualizado exitosamente',
    type: UserProfileResponseDto,
  })
  @ApiUnauthorizedResponse({ description: 'No autenticado' })
  async updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateUserDto,
  ): Promise<UserProfileResponseDto> {
    return this.usersService.updateProfile(user.id, dto);
  }

  @Get('me/wallet')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Obtener la billetera custodial del usuario autenticado',
    description:
      'Retorna la dirección pública de Stellar y estado de la bóveda custodial.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Billetera obtenida exitosamente',
    type: WalletResponseDto,
  })
  @ApiUnauthorizedResponse({ description: 'No autenticado' })
  async getWallet(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WalletResponseDto> {
    return this.usersService.getUserWallet(user.id);
  }
}
