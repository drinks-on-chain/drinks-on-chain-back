import { Test, TestingModule } from '@nestjs/testing';
import { WineAgingService } from '../services/wine-aging.service';
import { PrismaService } from '@shared/prisma/prisma.service';
import { AuditService } from '@shared/audit/audit.service';
import { createAuditServiceMock } from '@shared/audit/__tests__/audit-service.mock';
import { NotFoundException } from '@nestjs/common';
import { Prisma, AgingStatusEnum } from '@prisma/client';

describe('WineAgingService', () => {
  let service: WineAgingService;
  let prisma: PrismaService;

  const mockWineryId = '11111111-1111-1111-1111-111111111111';
  const mockTankId = '22222222-2222-2222-2222-222222222222';
  const mockAgingId = '33333333-3333-3333-3333-333333333333';

  const mockTank = {
    id: mockTankId,
    wineryId: mockWineryId,
    tankCode: 'TK-01',
    wineAgingBatch: null,
  };

  const mockAgingBatch = {
    id: mockAgingId,
    wineryId: mockWineryId,
    fermentationTankId: mockTankId,
    containerType: 'Barrica',
    containerMaterial: 'Roble Francés',
    containerCode: 'BAR-01',
    barrelUseCycle: 1,
    volumeLiters: new Prisma.Decimal(225.0),
    plannedMonths: 12,
    lockUntilDate: new Date(),
    agingStatus: AgingStatusEnum.AGING,
    notes: null,
    createdAt: new Date(),
  };

  const mockPrismaService = {
    fermentationTank: {
      findFirst: jest.fn(),
    },
    wineAgingBatch: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WineAgingService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
        {
          provide: AuditService,
          useValue: createAuditServiceMock(mockPrismaService),
        },
      ],
    }).compile();

    service = module.get<WineAgingService>(WineAgingService);
    prisma = module.get<PrismaService>(PrismaService);
    jest.clearAllMocks();
  });

  describe('createAgingBatch', () => {
    it('debe registrar un lote de crianza calculando la fecha de bloqueo (lockUntilDate)', async () => {
      mockPrismaService.fermentationTank.findFirst.mockResolvedValue(mockTank);
      mockPrismaService.wineAgingBatch.create.mockResolvedValue(mockAgingBatch);

      const dto = {
        fermentationTankId: mockTankId,
        containerType: 'Barrica',
        plannedMonths: 12,
      };

      const result = await service.createAgingBatch(mockWineryId, dto);

      expect(prisma.fermentationTank.findFirst).toHaveBeenCalledWith({
        where: { id: mockTankId, wineryId: mockWineryId },
        include: { wineAgingBatch: true },
      });
      expect(prisma.wineAgingBatch.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          wineryId: mockWineryId,
          fermentationTankId: mockTankId,
          plannedMonths: 12,
          agingStatus: AgingStatusEnum.AGING,
        }),
      });
      expect(result).toEqual(mockAgingBatch);
    });

    it('debe lanzar 409 FERMENTATION_TANK_ALREADY_TRANSFERRED si la cuba ya tiene un lote de crianza asignado', async () => {
      mockPrismaService.fermentationTank.findFirst.mockResolvedValue({
        ...mockTank,
        wineAgingBatch: { id: 'existing-aging' },
      });

      const dto = {
        fermentationTankId: mockTankId,
        containerType: 'Barrica',
        plannedMonths: 12,
      };

      await expect(
        service.createAgingBatch(mockWineryId, dto),
      ).rejects.toMatchObject({
        statusCode: 409,
        errorCode: 'FERMENTATION_TANK_ALREADY_TRANSFERRED',
      });
    });
  });

  describe('findAgingBatchById', () => {
    it('debe retornar el lote de crianza si existe', async () => {
      mockPrismaService.wineAgingBatch.findFirst.mockResolvedValue(
        mockAgingBatch,
      );

      const result = await service.findAgingBatchById(
        mockWineryId,
        mockAgingId,
      );

      expect(result.id).toBe(mockAgingId);
    });

    it('debe lanzar NotFoundException si no existe', async () => {
      mockPrismaService.wineAgingBatch.findFirst.mockResolvedValue(null);

      await expect(
        service.findAgingBatchById(mockWineryId, 'random'),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
