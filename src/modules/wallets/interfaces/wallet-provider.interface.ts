import { WalletPurposeEnum } from '@prisma/client';

export interface CustodialVaultResult {
  vaultId: string;
  stellarPublicKey: string;
  provider: string; // 'DYNAMIC_SIMULATED' | 'DYNAMIC_PRODUCTION'
}

export interface IWalletProvider {
  /**
   * Crea una bóveda custodial y obtiene la clave pública de Stellar asociada.
   * En la Etapa 1: Genera claves públicas Stellar válidas (G...) y vault IDs simulados.
   * En la Etapa 2+: Invocará la API de Dynamic SDK y contratos Soroban.
   */
  createCustodialVault(
    ownerIdentifier: string,
    purpose: WalletPurposeEnum,
  ): Promise<CustodialVaultResult>;

  /**
   * Placeholder / Hook listo para firmar transacciones on-chain en fases futuras.
   */
  signTransactionPlaceholder(
    vaultId: string,
    transactionPayload: unknown,
  ): Promise<{ signedPayload: string; txHashPlaceholder: string }>;
}
