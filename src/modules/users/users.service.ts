import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { UserRepository } from './repositories/user.repository';
import { WalletsService } from '@modules/wallets/wallets.service';
import { UpdateUserDto } from './dto/update-user.dto';
import {
  MeResponseDto,
  UserProfileResponseDto,
} from './dto/user-profile-response.dto';
import { WalletResponseDto } from '@modules/wallets/dto/wallet-response.dto';
import { MembershipsService } from '@modules/organizations/memberships.service';
import {
  RevocationReason,
  SessionsService,
} from '@modules/auth/sessions/sessions.service';
import type { AuthenticatedUser } from '@shared/decorators/current-user.decorator';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly userRepository: UserRepository,
    private readonly walletsService: WalletsService,
    private readonly memberships: MembershipsService,
    private readonly sessions: SessionsService,
  ) {}

  /**
   * `GET /v1/users/me` (contrato O0 §5): perfil (con `audience`), membresías y
   * organización activa de la sesión.
   */
  async getMe(principal: AuthenticatedUser): Promise<MeResponseDto> {
    const [profile, memberships] = await Promise.all([
      this.getProfile(principal.id),
      this.memberships.listForUser(principal.id),
    ]);
    return {
      user: {
        ...profile,
        audience: memberships.length > 0 ? 'STAFF' : 'CONSUMER',
      },
      memberships,
      activeOrganizationId: principal.organizationId,
    };
  }

  /**
   * Bloquea la cuenta completa (IAM-13): todas sus sesiones se revocan y los
   * accesos vigentes dejan de valer en la siguiente petición. Lo expondrá el
   * back office (contrato O1 §5).
   */
  async blockAccount(userId: string): Promise<void> {
    await this.userRepository.update(userId, { isActive: false });
    const revoked = await this.sessions.revokeAllForUser(
      userId,
      RevocationReason.USER_BLOCKED,
    );
    this.logger.log(
      `Cuenta ${userId} bloqueada; ${revoked} sesiones revocadas`,
    );
  }

  async unblockAccount(userId: string): Promise<void> {
    await this.userRepository.update(userId, { isActive: true });
  }

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
