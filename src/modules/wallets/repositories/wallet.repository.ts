import { Injectable } from '@nestjs/common';
import { PrismaService } from '@shared/prisma/prisma.service';
import {
  Prisma,
  UserWallet,
  WalletPurposeEnum,
  WalletTypeEnum,
} from '@prisma/client';

/** Los métodos aceptan `tx` para participar en una transacción (OP-01). */
@Injectable()
export class WalletRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    data: {
      userId: string;
      wineryId?: string | null;
      stellarPublicAddress: string;
      dynamicVaultId: string;
      walletType?: WalletTypeEnum;
      walletPurpose: WalletPurposeEnum;
      isPrimary?: boolean;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<UserWallet> {
    return (tx ?? this.prisma).userWallet.create({
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

  async findByUserId(
    userId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<UserWallet | null> {
    return (tx ?? this.prisma).userWallet.findFirst({
      where: { userId, isPrimary: true },
    });
  }

  async findByWineryId(
    wineryId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<UserWallet | null> {
    return (tx ?? this.prisma).userWallet.findFirst({
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
