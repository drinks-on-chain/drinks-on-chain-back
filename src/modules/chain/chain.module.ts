import { Module } from '@nestjs/common';
import { ChainSettingsModule } from './chain-settings.module';
import { PlatformChainController } from './platform-chain.controller';
import {
  PublicChainController,
  StellarTomlController,
} from './public-chain.controller';
import { SimulatedWalletsAuditRunner } from './simulated-wallets-audit.runner';
import {
  CurrentOrganizationChainController,
  PlatformWineryChainController,
} from './winery-chain.controller';

/**
 * Cadena en la API (contrato O3 §2–§4, §7 y §8; `docs-back/03` §5): rutas del
 * back office, del ERP y públicas. La API registra intenciones y lee estado;
 * el custodio de claves y el firmante viven en el worker
 * (`jobs/chain-jobs.module.ts`).
 */
@Module({
  imports: [ChainSettingsModule],
  controllers: [
    PlatformChainController,
    PlatformWineryChainController,
    CurrentOrganizationChainController,
    PublicChainController,
    StellarTomlController,
  ],
  providers: [SimulatedWalletsAuditRunner],
  exports: [ChainSettingsModule],
})
export class ChainModule {}
