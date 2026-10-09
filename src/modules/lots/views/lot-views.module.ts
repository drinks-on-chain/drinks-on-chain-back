import { Module } from '@nestjs/common';
import { PrismaModule } from '@shared/prisma/prisma.module';
import { LotAttachmentsController } from '../contract/lot-attachments.controller';
import { LotViewsController } from '../contract/lot-views.controller';
import { PublicPassportsController } from '../contract/public-passports.controller';
import { PublicVerificationController } from '../contract/public-verification.controller';
import { TraceabilityInsightsController } from '../contract/traceability-insights.controller';
import { LotsModule } from '../lots.module';
import { PassportLookupLimiter } from '../passport/passport-lookup-limiter';
import { PublicPassportService } from '../passport/public-passport.service';
import { LotAttachmentsService } from './lot-attachments.service';
import { LotViewsService } from './lot-views.service';
import { TraceInsightsService } from './trace-insights.service';

/**
 * Vistas del lote y pasaporte público (Ola 2, pasos 2.9 y 2.10; contrato O2
 * §11 y §12): línea de tiempo, balance, grafo, panel, reportes, archivos del
 * lote y pasaporte de lotes y botellas. Solo lectura sobre la cadena, salvo
 * los adjuntos.
 */
@Module({
  imports: [PrismaModule, LotsModule],
  controllers: [
    LotViewsController,
    TraceabilityInsightsController,
    LotAttachmentsController,
    PublicPassportsController,
    PublicVerificationController,
  ],
  providers: [
    LotViewsService,
    TraceInsightsService,
    LotAttachmentsService,
    PassportLookupLimiter,
    PublicPassportService,
  ],
})
export class LotViewsModule {}
