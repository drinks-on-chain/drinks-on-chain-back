import { Module } from '@nestjs/common';
import { PrismaModule } from '@shared/prisma/prisma.module';
import { WineTraceabilityStrategy } from './strategies/wine-traceability.strategy';
import { SinganiTraceabilityStrategy } from './strategies/singani-traceability.strategy';
import { BeerTraceabilityStrategy } from './strategies/beer-traceability.strategy';
import { TraceabilityStrategyFactory } from './strategies/traceability-strategy.factory';
import { FermentationService } from './services/fermentation.service';
import { WineAgingService } from './services/wine-aging.service';
import { ProductionBatchesService } from './services/production-batches.service';
import { FermentationController } from './controllers/fermentation.controller';
import { WineAgingController } from './controllers/wine-aging.controller';
import { ProductionBatchesController } from './controllers/production-batches.controller';

@Module({
  imports: [PrismaModule],
  controllers: [
    FermentationController,
    WineAgingController,
    ProductionBatchesController,
  ],
  providers: [
    WineTraceabilityStrategy,
    SinganiTraceabilityStrategy,
    BeerTraceabilityStrategy,
    TraceabilityStrategyFactory,
    FermentationService,
    WineAgingService,
    ProductionBatchesService,
  ],
  exports: [
    TraceabilityStrategyFactory,
    WineTraceabilityStrategy,
    SinganiTraceabilityStrategy,
    BeerTraceabilityStrategy,
    FermentationService,
    WineAgingService,
    ProductionBatchesService,
  ],
})
export class TraceabilityModule {}
