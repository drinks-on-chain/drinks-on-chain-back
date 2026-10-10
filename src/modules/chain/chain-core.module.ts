import { Module } from '@nestjs/common';
import { OutboxModule } from '@shared/outbox/outbox.module';
import { PrismaModule } from '@shared/prisma/prisma.module';
import { ChainAlertsWriter } from './alerts/chain-alerts.writer';
import { DossierAnchorService } from './anchor/dossier-anchor.service';
import { ReconciliationRunsService } from './reconciliation/reconciliation-runs.service';
import { ChainSettingsModule } from './chain-settings.module';
import { WineryIdentityService } from './identity/winery-identity.service';
import { ChainIntentsService } from './tx/chain-intents.service';

/**
 * Núcleo de la cadena que comparten la API y el worker: registro de
 * intenciones (outbox), identidad de las bodegas y alertas. Solo escribe en
 * la base; sin claves ni acceso a la red.
 */
@Module({
  imports: [PrismaModule, OutboxModule, ChainSettingsModule],
  providers: [
    ChainIntentsService,
    WineryIdentityService,
    ChainAlertsWriter,
    DossierAnchorService,
    ReconciliationRunsService,
  ],
  exports: [
    ChainSettingsModule,
    OutboxModule,
    ChainIntentsService,
    WineryIdentityService,
    ChainAlertsWriter,
    DossierAnchorService,
    ReconciliationRunsService,
  ],
})
export class ChainCoreModule {}
