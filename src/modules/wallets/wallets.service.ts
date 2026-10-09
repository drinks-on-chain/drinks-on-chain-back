import { Injectable } from '@nestjs/common';
import { WalletPurposeEnum, WalletTypeEnum } from '@prisma/client';
import { AppException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';
import { PrismaService } from '@shared/prisma/prisma.service';
import type { AuthenticatedUser } from '@shared/decorators/current-user.decorator';
import { WalletResponseDto } from './dto/wallet-response.dto';

/**
 * Ruta legada `GET /v1/users/me/wallet` (contrato O3 §3.3.5 y §12.2; SE-02).
 *
 * Las billeteras simuladas se retiraron: `user_wallets` eran direcciones sin
 * clave, quedaron marcadas `INVALID_SIMULATED` por la migración de la Ola 3 y
 * **no se leen ni se crean**. El personal (de bodega o de plataforma) no
 * tiene billetera personal: la cuenta de una bodega en la red es de la bodega.
 * Un consumidor tiene una dirección custodial derivada (`consumer_addresses`,
 * §4), que se le asigna en su registro de la Ola 4.
 */
@Injectable()
export class WalletsService {
  constructor(private readonly prisma: PrismaService) {}

  async getWallet(
    principal: Pick<AuthenticatedUser, 'id' | 'audience'>,
  ): Promise<WalletResponseDto> {
    if (principal.audience !== 'CONSUMER') {
      throw notAvailable(
        'El personal no tiene billetera: la cuenta de la bodega en la red está en /v1/organizations/current/chain-account',
      );
    }
    const address = await this.prisma.consumerAddress.findUnique({
      where: { userId: principal.id },
    });
    if (!address || address.status !== 'ACTIVE') {
      throw notAvailable('Tu cuenta aún no tiene una dirección asignada');
    }
    return {
      // La dirección es única por persona: su id es el de la persona
      id: address.userId,
      userId: address.userId,
      wineryId: null,
      stellarPublicAddress: address.address,
      walletType: WalletTypeEnum.CUSTODIAL,
      walletPurpose: WalletPurposeEnum.CONSUMER_NFT,
      isPrimary: true,
      createdAt: address.createdAt,
    };
  }
}

function notAvailable(message: string): AppException {
  return new AppException(404, ErrorCode.CHN_WALLET_NOT_AVAILABLE, message);
}
