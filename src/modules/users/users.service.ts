import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { UserRepository } from './repositories/user.repository';
import { WalletsService } from '@modules/wallets/wallets.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserProfileResponseDto } from './dto/user-profile-response.dto';
import { WalletResponseDto } from '@modules/wallets/dto/wallet-response.dto';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly userRepository: UserRepository,
    private readonly walletsService: WalletsService,
  ) {}

  /**
   * Obtiene el perfil completo del usuario autenticado
   */
  async getProfile(userId: string): Promise<UserProfileResponseDto> {
    const user = await this.userRepository.findById(userId);

    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    const primaryWallet = user.wallets[0]
      ? {
          id: user.wallets[0].id,
          userId: user.wallets[0].userId,
          wineryId: user.wallets[0].wineryId,
          stellarPublicAddress: user.wallets[0].stellarPublicAddress,
          walletType: user.wallets[0].walletType,
          walletPurpose: user.wallets[0].walletPurpose,
          isPrimary: user.wallets[0].isPrimary,
          createdAt: user.wallets[0].createdAt,
        }
      : null;

    const wineryMemberships = user.wineryMemberships.map((membership) => ({
      wineryId: membership.wineryId,
      wineryName: membership.winery.commercialName,
      memberRole: membership.memberRole,
      professionalLicenseNumber: membership.professionalLicenseNumber,
      isActive: membership.isActive,
      joinedAt: membership.joinedAt,
    }));

    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      userRole: user.userRole,
      phoneNumber: user.phoneNumber,
      preferredLocale: user.preferredLocale,
      isActive: user.isActive,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
      wineryMemberships,
      primaryWallet,
    };
  }

  /**
   * Actualiza los datos permitidos del perfil del usuario autenticado
   */
  async updateProfile(
    userId: string,
    dto: UpdateUserDto,
  ): Promise<UserProfileResponseDto> {
    await this.userRepository.update(userId, {
      fullName: dto.fullName?.trim(),
      phoneNumber: dto.phoneNumber?.trim(),
      preferredLocale: dto.preferredLocale?.trim(),
    });

    this.logger.log(`Perfil de usuario actualizado: ${userId}`);
    return this.getProfile(userId);
  }

  /**
   * Obtiene los datos de la billetera custodial del usuario
   */
  async getUserWallet(userId: string): Promise<WalletResponseDto> {
    return this.walletsService.getUserPrimaryWallet(userId);
  }
}
