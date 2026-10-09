import { Module } from '@nestjs/common';
import { PrismaModule } from '@shared/prisma/prisma.module';
import { WineTraceabilityStrategy } from './strategies/wine-traceability.strategy';
import { SinganiTraceabilityStrategy } from './strategies/singani-traceability.strategy';
import { BeerTraceabilityStrategy } from './strategies/beer-traceability.strategy';
import { TraceabilityStrategyFactory } from './strategies/traceability-strategy.factory';
import { FermentationService } from './services/fermentation.service';
import { WineAgingService } from './services/wine-aging.service';
import { ProductionBatchesService } from './services/production-batches.service';
import { BottlingService } from './services/bottling.service';
import { LabAnalysesService } from './services/lab-analyses.service';
import { TankTransitionsService } from './services/tank-transitions.service';
import { StageActionsService } from './services/stage-actions.service';
import { CorrectionsService } from './services/corrections.service';
import { FermentationController } from './controllers/fermentation.controller';
import { WineAgingController } from './controllers/wine-aging.controller';
import { ProductionBatchesController } from './controllers/production-batches.controller';
import { BottlingController } from './controllers/bottling.controller';
import { LabAnalysesController } from './controllers/lab-analyses.controller';

@Module({
  imports: [PrismaModule],
  controllers: [
    FermentationController,
    WineAgingController,
    ProductionBatchesController,
    BottlingController,
    LabAnalysesController,
  ],
  providers: [
    WineTraceabilityStrategy,
    SinganiTraceabilityStrategy,
    BeerTraceabilityStrategy,
    TraceabilityStrategyFactory,
    FermentationService,
    WineAgingService,
    ProductionBatchesService,
    BottlingService,
    LabAnalysesService,
    TankTransitionsService,
    StageActionsService,
    CorrectionsService,
  ],
  exports: [
    TraceabilityStrategyFactory,
    WineTraceabilityStrategy,
    SinganiTraceabilityStrategy,
    BeerTraceabilityStrategy,
    FermentationService,
    WineAgingService,
    ProductionBatchesService,
    BottlingService,
    LabAnalysesService,
    TankTransitionsService,
    StageActionsService,
    CorrectionsService,
  ],
})
export class TraceabilityModule {}
