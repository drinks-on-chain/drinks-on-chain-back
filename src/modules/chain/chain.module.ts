import { Module } from '@nestjs/common';
import { PrismaModule } from '@shared/prisma/prisma.module';
import { PlatformAccountsService } from './accounts/platform-accounts.service';
import { ChainCoreModule } from './chain-core.module';
import { PublicChainRegistryService } from './identity/public-chain-registry.service';
import { WineryChainActionsService } from './identity/winery-chain-actions.service';
import { ChainMonitoringService } from './monitoring/chain-monitoring.service';
import { PlatformChainController } from './platform-chain.controller';
import {
  PublicChainController,
  StellarTomlController,
} from './public-chain.controller';
import { SimulatedWalletsAuditRunner } from './simulated-wallets-audit.runner';
import { ChainTransactionsService } from './tx/chain-transactions.service';
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
  imports: [PrismaModule, ChainCoreModule],
  controllers: [
    PlatformChainController,
    PlatformWineryChainController,
    CurrentOrganizationChainController,
    PublicChainController,
    StellarTomlController,
  ],
  providers: [
    SimulatedWalletsAuditRunner,
    ChainTransactionsService,
    PlatformAccountsService,
    WineryChainActionsService,
    PublicChainRegistryService,
    ChainMonitoringService,
  ],
  exports: [ChainCoreModule],
})
export class ChainModule {}
