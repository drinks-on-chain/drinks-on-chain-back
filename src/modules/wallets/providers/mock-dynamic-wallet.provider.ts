import { Injectable, Logger } from '@nestjs/common';
import {
  IWalletProvider,
  CustodialVaultResult,
} from '../interfaces/wallet-provider.interface';
import { WalletPurposeEnum } from '@prisma/client';
import { Keypair } from '@stellar/stellar-sdk';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class MockDynamicWalletProvider implements IWalletProvider {
  private readonly logger = new Logger(MockDynamicWalletProvider.name);

  async createCustodialVault(
    ownerIdentifier: string,
    purpose: WalletPurposeEnum,
  ): Promise<CustodialVaultResult> {
    // Genera un par de claves Stellar sintéticamente válido sin invocar la red en vivo
    const randomKeypair = Keypair.random();
    const vaultId = `dyn_vault_${uuidv4()}`;
    const stellarPublicKey = randomKeypair.publicKey();

    this.logger.log(
      `[SIMULATED WALLET] Bóveda creada para ${ownerIdentifier} (${purpose}) -> PubKey: ${stellarPublicKey}`,
    );

    return {
      vaultId,
      stellarPublicKey,
      provider: 'DYNAMIC_SIMULATED',
    };
  }

  async signTransactionPlaceholder(
    vaultId: string,
    _transactionPayload: unknown,
  ): Promise<{ signedPayload: string; txHashPlaceholder: string }> {
    this.logger.log(
      `[SIMULATED HOOK] Firma on-chain invocada para vault ${vaultId}`,
    );
    return {
      signedPayload: 'MOCK_SIGNED_XDR_PAYLOAD',
      txHashPlaceholder: `0x${uuidv4().replace(/-/g, '')}`,
    };
  }
}
