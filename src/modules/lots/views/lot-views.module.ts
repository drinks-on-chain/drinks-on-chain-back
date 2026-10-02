import { Module } from '@nestjs/common';
import { PrismaModule } from '@shared/prisma/prisma.module';
import { LotAttachmentsController } from '../contract/lot-attachments.controller';
import { LotViewsController } from '../contract/lot-views.controller';
import { TraceabilityInsightsController } from '../contract/traceability-insights.controller';
import { LotsModule } from '../lots.module';
import { LotAttachmentsService } from './lot-attachments.service';
import { LotViewsService } from './lot-views.service';
import { TraceInsightsService } from './trace-insights.service';

/**
 * Vistas del lote (Ola 2, paso 2.9; contrato O2 §11): línea de tiempo,
 * balance, grafo, panel, reportes y archivos del lote. Solo lectura sobre la
 * cadena, salvo los adjuntos.
 */
@Module({
  imports: [PrismaModule, LotsModule],
  controllers: [
    LotViewsController,
    TraceabilityInsightsController,
    LotAttachmentsController,
  ],
  providers: [LotViewsService, TraceInsightsService, LotAttachmentsService],
})
export class LotViewsModule {}
