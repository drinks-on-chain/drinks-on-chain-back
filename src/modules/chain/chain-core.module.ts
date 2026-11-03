import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '@shared/audit/audit.service';
import { OutboxModule } from '@shared/outbox/outbox.module';
import { PrismaModule } from '@shared/prisma/prisma.module';
import { ChainAlertsWriter } from './alerts/chain-alerts.writer';
import {
  DOSSIER_ANCHOR_LEDGER,
  anchorLedgerFromConfig,
  type DossierAnchorLedger,
} from './anchor/dossier-anchor.port';
import { DossierAnchorService } from './anchor/dossier-anchor.service';
import { SimulatedDossierAnchorLedger } from './anchor/simulated-dossier-anchor.ledger';
import { ReconciliationRunsService } from './reconciliation/reconciliation-runs.service';
import { ChainSettingsModule } from './chain-settings.module';
import { WineryIdentityService } from './identity/winery-identity.service';
import { ChainIntentsService } from './tx/chain-intents.service';

/**
 * Núcleo de la cadena que comparten la API y el worker: registro de
 * intenciones (outbox), identidad de las bodegas y alertas. Solo escribe en
 * la base; sin claves ni acceso a la red.
 *
 * `DOSSIER_ANCHOR_LEDGER` es el puerto del anclaje del expediente: Stellar
 * (`DossierAnchorService`) o simulado (`ANCHOR_LEDGER=SIMULATED`).
 */
@Module({
  imports: [PrismaModule, OutboxModule, ChainSettingsModule],
  providers: [
    ChainIntentsService,
    WineryIdentityService,
    ChainAlertsWriter,
    DossierAnchorService,
    // El anclaje simulado escribe la bitácora; el worker no carga AuditModule
    // (global solo en la API), así que se declara aquí como en ChainJobsModule
    AuditService,
    SimulatedDossierAnchorLedger,
    {
      provide: DOSSIER_ANCHOR_LEDGER,
      inject: [
        ConfigService,
        DossierAnchorService,
        SimulatedDossierAnchorLedger,
      ],
      useFactory: (
        config: ConfigService,
        stellar: DossierAnchorService,
        simulated: SimulatedDossierAnchorLedger,
      ): DossierAnchorLedger =>
        anchorLedgerFromConfig(config) === 'SIMULATED' ? simulated : stellar,
    },
    ReconciliationRunsService,
  ],
  exports: [
    ChainSettingsModule,
    OutboxModule,
    ChainIntentsService,
    WineryIdentityService,
    ChainAlertsWriter,
    DossierAnchorService,
    DOSSIER_ANCHOR_LEDGER,
    ReconciliationRunsService,
  ],
})
export class ChainCoreModule {}
