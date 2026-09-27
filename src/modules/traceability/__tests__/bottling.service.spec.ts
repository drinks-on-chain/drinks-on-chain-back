import { Test, TestingModule } from '@nestjs/testing';
import { BottlingService } from '../services/bottling.service';
import { PrismaService } from '@shared/prisma/prisma.service';
import { TraceabilityStrategyFactory } from '../strategies/traceability-strategy.factory';
import { UnprocessableEntityException } from '@nestjs/common';
import { Prisma, BeverageTypeEnum } from '@prisma/client';
import { CreateBottlingBatchDto } from '../dto/create-bottling-batch.dto';

describe('BottlingService', () => {
  let service: BottlingService;
  let prisma: PrismaService;

  const mockWineryId = '11111111-1111-1111-1111-111111111111';
  const mockProdId = '22222222-2222-2222-2222-222222222222';
  const mockBottlingId = '33333333-3333-3333-3333-333333333333';
  const mockUserId = '44444444-4444-4444-4444-444444444444';
  const mockMemberId = '55555555-5555-5555-5555-555555555555';

  const mockWinery = {
    id: mockWineryId,
    legalName: 'Destilería Casa Real S.A.',
    commercialName: 'Kuhlmann & Cia',
  };

  const mockProdBatch = {
    id: mockProdId,
    wineryId: mockWineryId,
    processEndDate: new Date('2025-01-01'), // Fecha antigua (>180 días)
  };

  const mockBottlingBatch = {
    id: mockBottlingId,
    wineryId: mockWineryId,
    productionBatchId: mockProdId,
    productType: BeverageTypeEnum.SINGANI,
    internationalLotCode: 'KUH-2026-SINGANI-001',
    finalAlcoholAbv: new Prisma.Decimal(40.0),
    totalBottlesPackaged: 4080,
    packagingFormatCl: 75,
    bottlingDate: new Date('2026-10-01'),
    blockchainDataHash: 'abcdef1234567890',
    isAnchoredOnChain: false,
    qrBatchUrl: 'https://drinksonchain.com/trace/batch/KUH-2026-SINGANI-001',
    createdAt: new Date(),
  };

  const mockStrategy = {
    validateBottlingEligibility: jest.fn(),
  };

  const mockStrategyFactory = {
    getStrategy: jest.fn().mockReturnValue(mockStrategy),
  };

  const mockPrismaService = {
    winery: {
      findUnique: jest.fn(),
    },
    wineAgingBatch: {
      findFirst: jest.fn(),
    },
    productionBatch: {
      findFirst: jest.fn(),
    },
    bottlingBatch: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    wineryMember: {
      findFirst: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BottlingService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: TraceabilityStrategyFactory, useValue: mockStrategyFactory },
      ],
    }).compile();

    service = module.get<BottlingService>(BottlingService);
    prisma = module.get<PrismaService>(PrismaService);
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('debe registrar un lote de embotellado generando código internacional y hash criptográfico', async () => {
      mockPrismaService.winery.findUnique.mockResolvedValue(mockWinery);
      mockPrismaService.productionBatch.findFirst.mockResolvedValue(
        mockProdBatch,
      );
      mockStrategy.validateBottlingEligibility.mockReturnValue({
        isValid: true,
        errors: [],
      });
      mockPrismaService.bottlingBatch.count.mockResolvedValue(0);
      mockPrismaService.wineryMember.findFirst.mockResolvedValue({
        id: mockMemberId,
      });
      mockPrismaService.bottlingBatch.create.mockResolvedValue(
        mockBottlingBatch,
      );

      const dto = {
        productionBatchId: mockProdId,
        productType: BeverageTypeEnum.SINGANI,
        finalAlcoholAbv: 40.0,
        waterDilutionLiters: 1321.0,
        totalBottlesPackaged: 4080,
        packagingFormatCl: 75,
        bottlingDate: '2026-10-01',
      };

      const result = await service.create(mockWineryId, mockUserId, dto);

      expect(prisma.winery.findUnique).toHaveBeenCalledWith({
        where: { id: mockWineryId },
      });
      expect(mockStrategy.validateBottlingEligibility).toHaveBeenCalledWith(
        mockProdBatch,
      );
      expect(prisma.bottlingBatch.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          wineryId: mockWineryId,
          internationalLotCode: 'KUH-2026-SINGANI-001',
          totalBottlesPackaged: 4080,
          isAnchoredOnChain: false,
        }),
      });
      expect(result).toEqual(mockBottlingBatch);
    });

    it('debe lanzar 422 VALIDATION_ERROR si no se especifica lote de crianza ni de destilación', async () => {
      const dto = {
        productType: BeverageTypeEnum.SINGANI,
        finalAlcoholAbv: 40.0,
        totalBottlesPackaged: 1000,
        packagingFormatCl: 75,
        bottlingDate: '2026-10-01',
      };

      await expect(
        service.create(mockWineryId, mockUserId, dto as CreateBottlingBatchDto),
      ).rejects.toMatchObject({
        statusCode: 422,
        errorCode: 'VALIDATION_ERROR',
        details: [
          { field: 'wineAgingBatchId', message: expect.any(String) },
          { field: 'productionBatchId', message: expect.any(String) },
        ],
      });
    });

    it('debe lanzar UnprocessableEntityException si la estrategia rechaza el embotellado (ej: reposo < 180 días)', async () => {
      mockPrismaService.winery.findUnique.mockResolvedValue(mockWinery);
      mockPrismaService.productionBatch.findFirst.mockResolvedValue(
        mockProdBatch,
      );
      mockStrategy.validateBottlingEligibility.mockReturnValue({
        isValid: false,
        errors: ['D.O. Singani exige reposo mínimo de 180 días'],
      });

      const dto = {
        productionBatchId: mockProdId,
        productType: BeverageTypeEnum.SINGANI,
        finalAlcoholAbv: 40.0,
        totalBottlesPackaged: 4080,
        packagingFormatCl: 75,
        bottlingDate: '2026-10-01',
      };

      await expect(
        service.create(mockWineryId, mockUserId, dto),
      ).rejects.toThrow(UnprocessableEntityException);
    });
  });
});
