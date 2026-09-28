import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@shared/prisma/prisma.service';
import { AuditService, AUDIT_TX_OPTIONS } from '@shared/audit/audit.service';
import { AuditAction } from '@shared/audit/audit.actions';
import { UserRepository } from './repositories/user.repository';
import { WalletsService } from '@modules/wallets/wallets.service';
import { UpdateUserDto } from './dto/update-user.dto';
import {
  MeResponseDto,
  NotificationPrefsDto,
  UserProfileResponseDto,
} from './dto/user-profile-response.dto';
import { WalletResponseDto } from '@modules/wallets/dto/wallet-response.dto';
import { MembershipsService } from '@modules/organizations/memberships.service';
import {
  RevocationReason,
  SessionsService,
} from '@modules/auth/sessions/sessions.service';
import type { AuthenticatedUser } from '@shared/decorators/current-user.decorator';

/** Preferencias de comunicación por defecto (IAM-09). */
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefsDto = {
  lotProgress: true,
  redemptionReminders: true,
};

/** Preferencias guardadas, completadas con los valores por defecto. */
export function notificationPrefsOf(stored: unknown): NotificationPrefsDto {
  const value =
    typeof stored === 'object' && stored !== null
      ? (stored as Record<string, unknown>)
      : {};
  return {
    lotProgress:
      typeof value.lotProgress === 'boolean'
        ? value.lotProgress
        : DEFAULT_NOTIFICATION_PREFS.lotProgress,
    redemptionReminders:
      typeof value.redemptionReminders === 'boolean'
        ? value.redemptionReminders
        : DEFAULT_NOTIFICATION_PREFS.redemptionReminders,
  };
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly userRepository: UserRepository,
    private readonly walletsService: WalletsService,
    private readonly memberships: MembershipsService,
    private readonly sessions: SessionsService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * `GET /v1/users/me` (contrato O0 §5): perfil (con `audience` y las
   * preferencias de la Ola 1), membresías y organización activa de la sesión.
   */
  async getMe(principal: AuthenticatedUser): Promise<MeResponseDto> {
    const [user, memberships] = await Promise.all([
      this.userRepository.findById(principal.id),
      this.memberships.listForUser(principal.id),
    ]);
    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }
    return {
      user: {
        ...this.toProfile(user),
        audience: memberships.length > 0 ? 'STAFF' : 'CONSUMER',
        notificationPrefs: notificationPrefsOf(user.notificationPrefs),
        promotionsConsent: user.promotionsConsentAt !== null,
      },
      memberships,
      activeOrganizationId: principal.organizationId,
    };
  }

  /**
   * `PATCH /v1/users/me` (contrato O1 §1 y §11 bis): nombre, teléfono,
   * idioma, preferencias (parciales) y consentimiento de promociones con su
   * fecha. Responde como `GET /v1/users/me`.
   */
  async updateMe(
    principal: AuthenticatedUser,
    dto: UpdateUserDto,
  ): Promise<MeResponseDto> {
    const current = await this.prisma.user.findUnique({
      where: { id: principal.id },
    });
    if (!current) {
      throw new NotFoundException('Usuario no encontrado');
    }
    const prefsBefore = notificationPrefsOf(current.notificationPrefs);
    const prefsAfter = dto.notificationPrefs
      ? { ...prefsBefore, ...definedOnly(dto.notificationPrefs) }
      : prefsBefore;
    const consentBefore = current.promotionsConsentAt !== null;
    const data: Prisma.UserUpdateInput = {
      ...(dto.fullName !== undefined ? { fullName: dto.fullName.trim() } : {}),
      ...(dto.phoneNumber !== undefined
        ? { phoneNumber: dto.phoneNumber.trim() || null }
        : {}),
      ...(dto.preferredLocale !== undefined
        ? { preferredLocale: dto.preferredLocale }
        : {}),
      ...(dto.notificationPrefs
        ? { notificationPrefs: { ...prefsAfter } }
        : {}),
      ...(dto.promotionsConsent !== undefined &&
      dto.promotionsConsent !== consentBefore
        ? { promotionsConsentAt: dto.promotionsConsent ? new Date() : null }
        : {}),
    };
    if (Object.keys(data).length > 0) {
      await this.prisma.$transaction(async (tx) => {
        const updated = await tx.user.update({
          where: { id: principal.id },
          data,
        });
        await this.audit.record(tx, {
          action: AuditAction.USER_PROFILE_UPDATED,
          resource: { type: 'user', id: principal.id },
          organizationId: null,
          before: {
            fullName: current.fullName,
            phoneNumber: current.phoneNumber,
            preferredLocale: current.preferredLocale,
            notificationPrefs: prefsBefore,
            promotionsConsent: consentBefore,
          },
          after: {
            fullName: updated.fullName,
            phoneNumber: updated.phoneNumber,
            preferredLocale: updated.preferredLocale,
            notificationPrefs: notificationPrefsOf(updated.notificationPrefs),
            promotionsConsent: updated.promotionsConsentAt !== null,
          },
        });
      }, AUDIT_TX_OPTIONS);
      this.logger.log(`Perfil de usuario actualizado: ${principal.id}`);
    }
    return this.getMe(principal);
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
    return this.toProfile(user);
  }

  private toProfile(
    user: NonNullable<Awaited<ReturnType<UserRepository['findById']>>>,
  ): UserProfileResponseDto {
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
   * Obtiene los datos de la billetera custodial del usuario
   */
  async getUserWallet(userId: string): Promise<WalletResponseDto> {
    return this.walletsService.getUserPrimaryWallet(userId);
  }
}

/** Solo las claves con valor (un `PATCH` parcial no borra las demás). */
function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}
