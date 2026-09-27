import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { WalletRepository } from './repositories/wallet.repository';
import { IWalletProvider } from './interfaces/wallet-provider.interface';
import {
  Prisma,
  UserWallet,
  WalletPurposeEnum,
  WalletTypeEnum,
} from '@prisma/client';
import { WalletResponseDto } from './dto/wallet-response.dto';

@Injectable()
export class WalletsService {
  private readonly logger = new Logger(WalletsService.name);

  constructor(
    private readonly walletRepository: WalletRepository,
    private readonly walletProvider: IWalletProvider,
  ) {}

  /**
   * Aprovisiona una billetera custodial para un usuario (consumidor o personal).
   * Con `tx`, la fila se escribe dentro de esa transacción (OP-01).
   */
  async provisionUserWallet(
    userId: string,
    purpose: WalletPurposeEnum = WalletPurposeEnum.CONSUMER_NFT,
    tx?: Prisma.TransactionClient,
  ): Promise<UserWallet> {
    const existingWallet = await this.walletRepository.findByUserId(userId, tx);
    if (existingWallet) {
      return existingWallet;
    }

    const { vaultId, stellarPublicKey } =
      await this.walletProvider.createCustodialVault(userId, purpose);

    const wallet = await this.walletRepository.create(
      {
        userId,
        stellarPublicAddress: stellarPublicKey,
        dynamicVaultId: vaultId,
        walletType: WalletTypeEnum.CUSTODIAL,
        walletPurpose: purpose,
        isPrimary: true,
      },
      tx,
    );

    this.logger.log(
      `Billetera custodial creada exitosamente para usuario: ${userId} -> ${wallet.stellarPublicAddress}`,
    );

    return wallet;
  }

  /**
   * Aprovisiona una billetera custodial institucional para una bodega.
   * Con `tx`, la fila se escribe dentro de esa transacción (OP-01).
   */
  async provisionWineryWallet(
    userId: string,
    wineryId: string,
    purpose: WalletPurposeEnum = WalletPurposeEnum.PRODUCER_SIGNING,
    tx?: Prisma.TransactionClient,
  ): Promise<UserWallet> {
    const existingWallet = await this.walletRepository.findByWineryId(
      wineryId,
      tx,
    );
    if (existingWallet) {
      return existingWallet;
    }

    const { vaultId, stellarPublicKey } =
      await this.walletProvider.createCustodialVault(wineryId, purpose);

    const wallet = await this.walletRepository.create(
      {
        userId,
        wineryId,
        stellarPublicAddress: stellarPublicKey,
        dynamicVaultId: vaultId,
        walletType: WalletTypeEnum.CUSTODIAL,
        walletPurpose: purpose,
        isPrimary: true,
      },
      tx,
    );

    this.logger.log(
      `Billetera custodial creada exitosamente para bodega: ${wineryId} -> ${wallet.stellarPublicAddress}`,
    );

    return wallet;
  }

  /**
   * Obtiene la billetera primaria del usuario autenticado
   */
  async getUserPrimaryWallet(userId: string): Promise<WalletResponseDto> {
    let wallet = await this.walletRepository.findByUserId(userId);
    if (!wallet) {
      // Si por alguna razón no tuviese billetera, se aprovisiona on-demand
      wallet = await this.provisionUserWallet(userId);
    }

    return {
      id: wallet.id,
      userId: wallet.userId,
      wineryId: wallet.wineryId,
      stellarPublicAddress: wallet.stellarPublicAddress,
      walletType: wallet.walletType,
      walletPurpose: wallet.walletPurpose,
      isPrimary: wallet.isPrimary,
      createdAt: wallet.createdAt,
    };
  }

  /**
   * Obtiene la billetera de una bodega
   */
  async getWineryWallet(wineryId: string): Promise<WalletResponseDto> {
    const wallet = await this.walletRepository.findByWineryId(wineryId);
    if (!wallet) {
      throw new NotFoundException('Billetera de bodega no encontrada');
    }

    return {
      id: wallet.id,
      userId: wallet.userId,
      wineryId: wallet.wineryId,
      stellarPublicAddress: wallet.stellarPublicAddress,
      walletType: wallet.walletType,
      walletPurpose: wallet.walletPurpose,
      isPrimary: wallet.isPrimary,
      createdAt: wallet.createdAt,
    };
  }
}
