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
   * Efecto externo del alta de la bóveda (registro/activación en el proveedor).
   * Lo ejecuta el worker a partir de los eventos del outbox `winery.created` y
   * `member.added` (OP-01); debe ser idempotente. Simulado hasta la Ola 3.
   */
  activateCustodialVault(
    vaultId: string,
    ownerIdentifier: string,
    purpose: WalletPurposeEnum,
  ): Promise<{ activated: boolean; provider: string }>;

  /**
   * Placeholder / Hook listo para firmar transacciones on-chain en fases futuras.
   */
  signTransactionPlaceholder(
    vaultId: string,
    transactionPayload: unknown,
  ): Promise<{ signedPayload: string; txHashPlaceholder: string }>;
}
