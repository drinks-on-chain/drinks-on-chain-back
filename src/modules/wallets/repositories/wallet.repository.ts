import { Injectable } from '@nestjs/common';
import { PrismaService } from '@shared/prisma/prisma.service';
import { UserWallet, WalletPurposeEnum, WalletTypeEnum } from '@prisma/client';

@Injectable()
export class WalletRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: {
    userId: string;
    wineryId?: string | null;
    stellarPublicAddress: string;
    dynamicVaultId: string;
    walletType?: WalletTypeEnum;
    walletPurpose: WalletPurposeEnum;
    isPrimary?: boolean;
  }): Promise<UserWallet> {
    return this.prisma.userWallet.create({
      data: {
        userId: data.userId,
        wineryId: data.wineryId ?? null,
        stellarPublicAddress: data.stellarPublicAddress,
        dynamicVaultId: data.dynamicVaultId,
        walletType: data.walletType ?? WalletTypeEnum.CUSTODIAL,
        walletPurpose: data.walletPurpose,
        isPrimary: data.isPrimary ?? true,
      },
    });
  }

  async findByUserId(userId: string): Promise<UserWallet | null> {
    return this.prisma.userWallet.findFirst({
      where: { userId, isPrimary: true },
    });
  }

  async findByWineryId(wineryId: string): Promise<UserWallet | null> {
    return this.prisma.userWallet.findFirst({
      where: { wineryId, isPrimary: true },
    });
  }

  async findByAddress(
    stellarPublicAddress: string,
  ): Promise<UserWallet | null> {
    return this.prisma.userWallet.findUnique({
      where: { stellarPublicAddress },
    });
  }
}
