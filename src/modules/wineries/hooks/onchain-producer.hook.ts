import { Injectable, Logger } from '@nestjs/common';
import { Winery } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';

export interface OnchainProducerRegistrationResult {
  onchainProducerId: string;
  txHash: string;
  isSimulated: boolean;
}

@Injectable()
export class OnchainProducerHook {
  private readonly logger = new Logger(OnchainProducerHook.name);

  /**
   * Hook ejecutado durante la aprobación institucional de una bodega.
   *
   * ETAPA 1 (Actual - Sin Blockchain en vivo):
   * - Retorna un ID on-chain determinista y un hash simulado.
   *
   * ETAPA 2 (Integración Blockchain / Soroban RPC):
   * - Invocará el contrato Soroban C-01 ProducerRegistry:
   *   `register_producer(producer_address, legal_name, tax_id)`
   * - Confirmará en el ledger y devolverá el transaction hash real.
   */
  async executeProducerRegistration(
    winery: Winery,
    stellarPublicKey: string,
  ): Promise<OnchainProducerRegistrationResult> {
    this.logger.log(
      `[ONCHAIN HOOK - ETAPA 1] Preparando registro de productor para Bodega: "${winery.commercialName}" (NIT: ${winery.taxIdNit}) con Stellar Key: ${stellarPublicKey}`,
    );

    // Identificador on-chain canónico basado en el código de país y NIT
    const sanitizedNit = winery.taxIdNit.replace(/\s+/g, '');
    const onchainProducerId = `PROD_${winery.countryCode}_${sanitizedNit}`;
    const txHash = `0x_simulated_tx_${uuidv4().replace(/-/g, '')}`;

    this.logger.log(
      `[ONCHAIN HOOK - ETAPA 1] Productor registrado simuladamente -> ID: ${onchainProducerId}, TX: ${txHash}`,
    );

    return {
      onchainProducerId,
      txHash,
      isSimulated: true,
    };
  }
}
