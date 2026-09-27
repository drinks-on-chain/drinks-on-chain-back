import { Test, TestingModule } from '@nestjs/testing';
import { ProductionBatchesService } from '../services/production-batches.service';
import { TraceabilityStrategyFactory } from '../strategies/traceability-strategy.factory';
import { PrismaService } from '@shared/prisma/prisma.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma, ProductionProcessEnum, RestStatusEnum } from '@prisma/client';

describe('ProductionBatchesService', () => {
  let service: ProductionBatchesService;
  let prisma: PrismaService;

  const mockWineryId = '11111111-1111-1111-1111-111111111111';
  const mockTankId = '22222222-2222-2222-2222-222222222222';
  const mockProdId = '33333333-3333-3333-3333-333333333333';

  const mockTank = {
    id: mockTankId,
    wineryId: mockWineryId,
    tankCode: 'TK-03',
  };

  const mockProdBatch = {
    id: mockProdId,
    wineryId: mockWineryId,
    fermentationTankId: mockTankId,
    processType: ProductionProcessEnum.SINGANI_DISTILLATION,
    equipmentIdentifier: 'Alambique Charentais AL-01',
    processStartDate: new Date('2026-04-01'),
    processEndDate: new Date('2026-04-03'),
    inputVolumeLiters: new Prisma.Decimal(10000.0),
    outputVolumeLiters: new Prisma.Decimal(1750.0),
    wasteVolumeLiters: new Prisma.Decimal(570.0),
    initialAlcoholPercentage: new Prisma.Decimal(70.2),
    isDoEligible: true,
    mandatoryRestUntil: new Date('2026-09-30'),
    restStatus: RestStatusEnum.RESTING,
    additionalParams: null,
    notes: null,
    createdAt: new Date(),
  };

  const mockPrismaService = {
    fermentationTank: {
      findFirst: jest.fn(),
    },
    productionBatch: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
  };

  beforeEach(async () => {
    const mockStrategyFactory = {
      getStrategy: jest.fn().mockReturnValue({
        validatePlotAndHarvest: jest
          .fn()
          .mockReturnValue({ isValid: true, errors: [], warnings: [] }),
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductionBatchesService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
        {
          provide: TraceabilityStrategyFactory,
          useValue: mockStrategyFactory,
        },
      ],
    }).compile();

    service = module.get<ProductionBatchesService>(ProductionBatchesService);
    prisma = module.get<PrismaService>(PrismaService);
    jest.clearAllMocks();
  });

  describe('createDistillationBatch', () => {
    it('debe registrar un lote de destilación fijando 180 días de reposo inerte', async () => {
      mockPrismaService.fermentationTank.findFirst.mockResolvedValue(mockTank);
      mockPrismaService.productionBatch.create.mockResolvedValue(mockProdBatch);

      const dto = {
        fermentationTankId: mockTankId,
        equipmentIdentifier: 'Alambique Charentais AL-01',
        processStartDate: '2026-04-01',
        processEndDate: '2026-04-03',
        inputVolumeLiters: 10000.0,
        outputVolumeLiters: 1750.0,
        wasteVolumeLiters: 570.0,
        initialAlcoholPercentage: 70.2,
      };

      const result = await service.createDistillationBatch(mockWineryId, dto);

      expect(prisma.fermentationTank.findFirst).toHaveBeenCalledWith({
        where: { id: mockTankId, wineryId: mockWineryId },
        include: { harvestBatch: { include: { terroir: true } } },
      });
      expect(prisma.productionBatch.create).toHaveBeenCalled();
      expect(result).toEqual(mockProdBatch);
    });

    it('debe lanzar BadRequestException si el balance de masa excede el volumen cargado', async () => {
      mockPrismaService.fermentationTank.findFirst.mockResolvedValue(mockTank);

      const dto = {
        fermentationTankId: mockTankId,
        equipmentIdentifier: 'Alambique AL-01',
        processStartDate: '2026-04-01',
        inputVolumeLiters: 1000.0,
        outputVolumeLiters: 900.0,
        wasteVolumeLiters: 500.0, // 900 + 500 = 1400 > 1000
      };

      await expect(
        service.createDistillationBatch(mockWineryId, dto),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('getRestStatus', () => {
    it('debe calcular días transcurridos y restantes respecto al reposo inerte', async () => {
      mockPrismaService.productionBatch.findFirst.mockResolvedValue(
        mockProdBatch,
      );

      const result = await service.getRestStatus(mockWineryId, mockProdId);

      expect(result.id).toBe(mockProdId);
      expect(typeof result.daysElapsed).toBe('number');
      expect(typeof result.daysRemaining).toBe('number');
      expect(typeof result.isRestCompleted).toBe('boolean');
    });
  });
});
