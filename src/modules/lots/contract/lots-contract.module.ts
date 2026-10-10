import { Module } from '@nestjs/common';
import { OutboxModule } from '@shared/outbox/outbox.module';
import { PrismaModule } from '@shared/prisma/prisma.module';
import { TraceabilityModule } from '@modules/traceability/traceability.module';
import { LotBottlingService } from '../lot-bottling.service';
import { LotCertificationModule } from '../lot-certification.module';
import { LotViewsModule } from '../views/lot-views.module';
import { BottleCodesController } from './bottle-codes.controller';
import {
  CorrectionsController,
  TerroirCorrectionsController,
} from './corrections.controller';
import { DossierController } from './dossier.controller';
import { LotBottlingController } from './lot-bottling.controller';
import { LotLabAnalysesController } from './lot-lab-analyses.controller';
import { PublicWineriesDirectoryController } from './public-wineries.controller';
import { PublicWineriesDirectoryService } from './public-wineries-directory.service';
import {
  ProductionActionsController,
  WineAgingActionsController,
} from './stage-actions.controller';
import { TankTransitionsController } from './tank-transitions.controller';

/**
 * Rutas del contrato de la Ola 2 (contrato O2 §16.1). Se publicaron en la
 * apertura con `501 NOT_IMPLEMENTED` y la Etapa 2 (pasos 2.3–2.10) las
 * implementó todas: ya no queda ninguna con 501. Aquí viven los controladores
 * del embotellado del lote, los códigos de botella y el expediente
 * (`LotCertificationModule`), el laboratorio por lote, las correcciones, las
 * transiciones del tanque, los descartes y el cierre de la destilación, y el
 * directorio público de bodegas. Las vistas del lote, sus archivos y el
 * pasaporte público están en `LotViewsModule`.
 */
@Module({
  imports: [
    PrismaModule,
    OutboxModule,
    TraceabilityModule,
    LotViewsModule,
    LotCertificationModule,
  ],
  controllers: [
    LotBottlingController,
    BottleCodesController,
    LotLabAnalysesController,
    CorrectionsController,
    TerroirCorrectionsController,
    DossierController,
    TankTransitionsController,
    WineAgingActionsController,
    ProductionActionsController,
    PublicWineriesDirectoryController,
  ],
  providers: [PublicWineriesDirectoryService, LotBottlingService],
})
export class LotsContractModule {}
