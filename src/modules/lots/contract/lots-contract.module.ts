import { Module } from '@nestjs/common';
import { PrismaModule } from '@shared/prisma/prisma.module';
import { TraceabilityModule } from '@modules/traceability/traceability.module';
import { LotBottlingService } from '../lot-bottling.service';
import { LotCertificationModule } from '../lot-certification.module';
import { BottleCodesController } from './bottle-codes.controller';
import {
  CorrectionsController,
  TerroirCorrectionsController,
} from './corrections.controller';
import { DossierController } from './dossier.controller';
import { LotAttachmentsController } from './lot-attachments.controller';
import { LotBottlingController } from './lot-bottling.controller';
import { LotLabAnalysesController } from './lot-lab-analyses.controller';
import { LotViewsController } from './lot-views.controller';
import { PublicPassportsController } from './public-passports.controller';
import { PublicWineriesDirectoryController } from './public-wineries.controller';
import { PublicWineriesDirectoryService } from './public-wineries-directory.service';
import {
  ProductionActionsController,
  WineAgingActionsController,
} from './stage-actions.controller';
import { TankTransitionsController } from './tank-transitions.controller';
import { TraceabilityInsightsController } from './traceability-insights.controller';

/**
 * Rutas del contrato de la Ola 2 publicadas en la apertura (contrato O2
 * §16.1): el OpenAPI las documenta completas y responden `501
 * NOT_IMPLEMENTED` hasta que llega su paso de la Etapa 2 (2.3–2.10). Al
 * implementar una, se mueve a su módulo y se retira de aquí. Ya son reales el
 * directorio público de bodegas (`GET /v1/public/wineries`) y el embotellado
 * del lote (`POST /v1/lots/{id}/bottling[/preview]`).
 */
@Module({
  imports: [PrismaModule, TraceabilityModule, LotCertificationModule],
  controllers: [
    LotViewsController,
    LotBottlingController,
    BottleCodesController,
    LotLabAnalysesController,
    CorrectionsController,
    TerroirCorrectionsController,
    DossierController,
    TraceabilityInsightsController,
    LotAttachmentsController,
    TankTransitionsController,
    WineAgingActionsController,
    ProductionActionsController,
    PublicPassportsController,
    PublicWineriesDirectoryController,
  ],
  providers: [PublicWineriesDirectoryService, LotBottlingService],
})
export class LotsContractModule {}
