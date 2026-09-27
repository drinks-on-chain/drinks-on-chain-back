import { Test, TestingModule } from '@nestjs/testing';
import { WineTraceabilityStrategy } from '../strategies/wine-traceability.strategy';
import { SinganiTraceabilityStrategy } from '../strategies/singani-traceability.strategy';
import { BeerTraceabilityStrategy } from '../strategies/beer-traceability.strategy';
import { TraceabilityStrategyFactory } from '../strategies/traceability-strategy.factory';
import { OnchainStageEnum } from '../strategies/interfaces/traceability-strategy.interface';
import {
  Prisma,
  PhytoStatusEnum,
  ProductionBatch,
  WineAgingBatch,
} from '@prisma/client';

describe('Traceability Strategies & Factory', () => {
  let factory: TraceabilityStrategyFactory;
  let wineStrategy: WineTraceabilityStrategy;
  let singaniStrategy: SinganiTraceabilityStrategy;
  let beerStrategy: BeerTraceabilityStrategy;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WineTraceabilityStrategy,
        SinganiTraceabilityStrategy,
        BeerTraceabilityStrategy,
        TraceabilityStrategyFactory,
      ],
    }).compile();

    factory = module.get<TraceabilityStrategyFactory>(
      TraceabilityStrategyFactory,
    );
    wineStrategy = module.get<WineTraceabilityStrategy>(
      WineTraceabilityStrategy,
    );
    singaniStrategy = module.get<SinganiTraceabilityStrategy>(
      SinganiTraceabilityStrategy,
    );
    beerStrategy = module.get<BeerTraceabilityStrategy>(
      BeerTraceabilityStrategy,
    );
  });

  describe('TraceabilityStrategyFactory', () => {
    it('debe resolver la estrategia de vino para WINE o WINERY', () => {
      expect(factory.getStrategy('WINE')).toBe(wineStrategy);
      expect(factory.getStrategy('WINERY')).toBe(wineStrategy);
    });

    it('debe resolver la estrategia de singani para SINGANI o DISTILLERY', () => {
      expect(factory.getStrategy('SINGANI')).toBe(singaniStrategy);
      expect(factory.getStrategy('DISTILLERY')).toBe(singaniStrategy);
    });

    it('debe resolver la estrategia de cerveza para BEER o BREWERY', () => {
      expect(factory.getStrategy('BEER')).toBe(beerStrategy);
      expect(factory.getStrategy('BREWERY')).toBe(beerStrategy);
    });
  });

  describe('SinganiTraceabilityStrategy', () => {
    const mockTerroirSingani = {
      id: '1',
      wineryId: '1',
      parcelName: 'Finca Potrero',
      cadastreCode: null,
      surfaceHectares: new Prisma.Decimal(5),
      altitudeMasl: new Prisma.Decimal(1850.0),
      latitude: null,
      longitude: null,
      geographicPolygonGeojson: null,
      rawMaterialType: 'uva',
      varietyName: '100% Moscatel de Alejandría',
      soilType: null,
      irrigationSystem: null,
      isDoEligible: true,
      doType: 'D.O. Singani',
      doCertificateUrl: null,
      isActive: true,
      createdAt: new Date(),
    };

    const mockHarvestSingani = {
      id: '1',
      wineryId: '1',
      terroirId: '1',
      harvestBatchCode: 'HARV-2026-01',
      intakeDate: new Date(),
      harvestYear: 2026,
      grossWeightKg: new Prisma.Decimal(15000),
      tareWeightKg: new Prisma.Decimal(150),
      netWeightKg: new Prisma.Decimal(14850),
      brixDegrees: new Prisma.Decimal(22.4),
      initialPh: new Prisma.Decimal(3.45),
      initialAcidityGl: new Prisma.Decimal(6.8),
      temperatureAtIntakeC: null,
      phytosanitaryStatus: PhytoStatusEnum.APPROVED,
      phytoInspectionPdfUrl: null,
      certifiedByMemberId: null,
      notes: null,
      createdAt: new Date(),
    };

    it('debe aprobar parcela y vendimia que cumplan requisitos D.O. Singani (>1600m y Moscatel)', () => {
      const result = singaniStrategy.validatePlotAndHarvest(
        mockTerroirSingani,
        mockHarvestSingani,
      );
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('debe rechazar parcela con altitud < 1600 msnm para D.O. Singani', () => {
      const lowAltitudeTerroir = {
        ...mockTerroirSingani,
        altitudeMasl: new Prisma.Decimal(1200.0),
      };
      const result = singaniStrategy.validatePlotAndHarvest(
        lowAltitudeTerroir,
        mockHarvestSingani,
      );
      expect(result.isValid).toBe(false);
      expect(result.errors[0]).toContain('1,600 m.s.n.m.');
    });

    it('debe rechazar parcela si no es variedad Moscatel de Alejandría', () => {
      const wrongVarietyTerroir = {
        ...mockTerroirSingani,
        varietyName: 'Cabernet Sauvignon',
      };
      const result = singaniStrategy.validatePlotAndHarvest(
        wrongVarietyTerroir,
        mockHarvestSingani,
      );
      expect(result.isValid).toBe(false);
      expect(result.errors[0]).toContain('Moscatel de Alejandría');
    });

    it('debe bloquear embotellado de Singani si el reposo inerte es < 180 días', () => {
      const recentEnd = new Date();
      recentEnd.setDate(recentEnd.getDate() - 30); // Solo 30 días transcurridos

      const prodBatch = {
        processType: 'SINGANI_DISTILLATION',
        processEndDate: recentEnd,
      } as unknown as ProductionBatch;

      const result = singaniStrategy.validateBottlingEligibility(prodBatch);
      expect(result.isValid).toBe(false);
      expect(result.errors[0]).toContain('180 días');
    });

    it('debe calcular métricas Soroban escaladas x100 correctamente', () => {
      const metricsPlot = singaniStrategy.computeOnchainMetrics(
        OnchainStageEnum.Plot,
        {
          altitudeMasl: 1850.5,
        },
      );
      expect(metricsPlot).toEqual([185050]);

      const metricsDist = singaniStrategy.computeOnchainMetrics(
        OnchainStageEnum.Distillation,
        {
          initialAlcoholPercentage: 70.2,
        },
      );
      expect(metricsDist).toEqual([7020]);
    });
  });

  describe('WineTraceabilityStrategy', () => {
    it('debe bloquear embotellado si fecha actual < lockUntilDate', () => {
      const futureLockDate = new Date();
      futureLockDate.setMonth(futureLockDate.getMonth() + 6);

      const agingBatch = {
        plannedMonths: 12,
        lockUntilDate: futureLockDate,
      } as unknown as WineAgingBatch;

      const result = wineStrategy.validateBottlingEligibility(agingBatch);
      expect(result.isValid).toBe(false);
      expect(result.errors[0]).toContain('bloqueado por período de crianza');
    });
  });
});
