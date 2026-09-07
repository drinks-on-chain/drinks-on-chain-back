import { Test, TestingModule } from '@nestjs/testing';
import { FermentationService } from '../services/fermentation.service';
import { PrismaService } from '@shared/prisma/prisma.service';
import { NotFoundException, ForbiddenException } from '@nestjs/common';
import { Prisma, TankStatusEnum, DestinationTypeEnum, TreatmentTypeEnum } from '@prisma/client';

describe('FermentationService', () => {
  let service: FermentationService;
  let prisma: PrismaService;

  const mockWineryId = '11111111-1111-1111-1111-111111111111';
  const mockHarvestId = '22222222-2222-2222-2222-222222222222';
  const mockTankId = '33333333-3333-3333-3333-333333333333';
  const mockUserId = '44444444-4444-4444-4444-444444444444';
  const mockMemberId = '55555555-5555-5555-5555-555555555555';

  const mockHarvestBatch = {
    id: mockHarvestId,
    wineryId: mockWineryId,
    harvestBatchCode: 'HARV-2026-POTRERO-001',
  };

  const mockTank = {
    id: mockTankId,
    wineryId: mockWineryId,
    harvestBatchId: mockHarvestId,
    tankCode: 'TK-03',
    capacityLiters: new Prisma.Decimal(15000),
    material: 'Acero Inoxidable',
    volumeFilledLiters: new Prisma.Decimal(10100),
    destinationType: DestinationTypeEnum.SINGANI_DIST,
    status: TankStatusEnum.FERMENTING,
    startDate: new Date(),
    endDate: null,
    createdAt: new Date(),
  };

  const mockPrismaService = {
    harvestBatch: {
      findFirst: jest.fn(),
    },
    fermentationTank: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      count: jest.fn(),
    },
    fermentationLog: {
      create: jest.fn(),
    },
    enologicalTreatment: {
      create: jest.fn(),
    },
    wineryMember: {
      findFirst: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FermentationService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
      ],
    }).compile();

    service = module.get<FermentationService>(FermentationService);
    prisma = module.get<PrismaService>(PrismaService);
    jest.clearAllMocks();
  });

  describe('createTank', () => {
    it('debe registrar una nueva cuba de fermentación vinculada a la vendimia', async () => {
      mockPrismaService.harvestBatch.findFirst.mockResolvedValue(mockHarvestBatch);
      mockPrismaService.fermentationTank.create.mockResolvedValue(mockTank);

      const dto = {
        harvestBatchId: mockHarvestId,
        tankCode: 'TK-03',
        capacityLiters: 15000,
        volumeFilledLiters: 10100,
        destinationType: DestinationTypeEnum.SINGANI_DIST,
        startDate: '2026-03-15T14:30:00Z',
      };

      const result = await service.createTank(mockWineryId, dto);

      expect(prisma.harvestBatch.findFirst).toHaveBeenCalledWith({
        where: { id: mockHarvestId, wineryId: mockWineryId },
      });
      expect(prisma.fermentationTank.create).toHaveBeenCalled();
      expect(result).toEqual(mockTank);
    });

    it('debe lanzar NotFoundException si el lote de vendimia no existe', async () => {
      mockPrismaService.harvestBatch.findFirst.mockResolvedValue(null);

      const dto = {
        harvestBatchId: 'random-harvest',
        tankCode: 'TK-03',
        startDate: '2026-03-15T14:30:00Z',
      };

      await expect(service.createTank(mockWineryId, dto)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('addLog', () => {
    it('debe registrar un log térmico append-only', async () => {
      mockPrismaService.fermentationTank.findFirst.mockResolvedValue(mockTank);
      mockPrismaService.fermentationLog.create.mockResolvedValue({
        id: 'log-1',
        fermentationTankId: mockTankId,
        temperatureCelsius: new Prisma.Decimal(15.5),
        recordedAt: new Date(),
        recordedByUserId: mockUserId,
      });

      const dto = {
        temperatureCelsius: 15.5,
        recordedAt: '2026-03-16T08:00:00Z',
      };

      const result = await service.addLog(mockWineryId, mockTankId, mockUserId, dto);

      expect(prisma.fermentationLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          fermentationTankId: mockTankId,
          temperatureCelsius: new Prisma.Decimal(15.5),
          recordedByUserId: mockUserId,
        }),
      });
      expect(result.id).toBe('log-1');
    });
  });

  describe('addTreatment', () => {
    it('debe registrar un tratamiento enológico autorizado por miembro acreditado', async () => {
      mockPrismaService.fermentationTank.findFirst.mockResolvedValue(mockTank);
      mockPrismaService.wineryMember.findFirst.mockResolvedValue({
        id: mockMemberId,
        userId: mockUserId,
        wineryId: mockWineryId,
        isActive: true,
      });
      mockPrismaService.enologicalTreatment.create.mockResolvedValue({
        id: 'treat-1',
        fermentationTankId: mockTankId,
        treatmentType: TreatmentTypeEnum.SO2_ADDITION,
        authorizedByMemberId: mockMemberId,
      });

      const dto = {
        treatmentType: TreatmentTypeEnum.SO2_ADDITION,
        additiveName: 'Metabisulfito de potasio',
        dosageAppliedGPerHl: 30.0,
        regulatoryAuthCode: 'SENASAG-88',
        appliedAt: '2026-03-15T15:00:00Z',
      };

      const result = await service.addTreatment(
        mockWineryId,
        mockTankId,
        mockUserId,
        dto,
      );

      expect(prisma.enologicalTreatment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          fermentationTankId: mockTankId,
          authorizedByMemberId: mockMemberId,
        }),
      });
      expect(result.id).toBe('treat-1');
    });

    it('debe lanzar ForbiddenException si el usuario no es miembro activo', async () => {
      mockPrismaService.fermentationTank.findFirst.mockResolvedValue(mockTank);
      mockPrismaService.wineryMember.findFirst.mockResolvedValue(null);

      const dto = {
        treatmentType: TreatmentTypeEnum.SO2_ADDITION,
        additiveName: 'Metabisulfito de potasio',
        dosageAppliedGPerHl: 30.0,
        regulatoryAuthCode: 'SENASAG-88',
        appliedAt: '2026-03-15T15:00:00Z',
      };

      await expect(
        service.addTreatment(mockWineryId, mockTankId, mockUserId, dto),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
