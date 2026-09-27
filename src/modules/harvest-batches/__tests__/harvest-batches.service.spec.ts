import { Test, TestingModule } from '@nestjs/testing';
import { HarvestBatchesService } from '../harvest-batches.service';
import { PrismaService } from '@shared/prisma/prisma.service';
import { AuditService } from '@shared/audit/audit.service';
import { createAuditServiceMock } from '@shared/audit/__tests__/audit-service.mock';
import { NotFoundException } from '@nestjs/common';
import { Prisma, PhytoStatusEnum } from '@prisma/client';
import { ValidationException } from '@shared/exceptions/validation.exception';

describe('HarvestBatchesService', () => {
  let service: HarvestBatchesService;
  let prisma: PrismaService;

  const mockWineryId = '11111111-1111-1111-1111-111111111111';
  const mockTerroirId = '22222222-2222-2222-2222-222222222222';
  const mockHarvestId = '33333333-3333-3333-3333-333333333333';
  const mockUserId = '44444444-4444-4444-4444-444444444444';
  const mockMemberId = '55555555-5555-5555-5555-555555555555';

  const mockTerroir = {
    id: mockTerroirId,
    wineryId: mockWineryId,
    parcelName: 'Cuartel 4 - La Finca El Potrero',
    cadastreCode: 'CAT-4022',
  };

  const mockHarvestBatch = {
    id: mockHarvestId,
    wineryId: mockWineryId,
    terroirId: mockTerroirId,
    harvestBatchCode: 'HARV-2026-CUARTEL4-001',
    intakeDate: new Date('2026-03-15'),
    harvestYear: 2026,
    grossWeightKg: new Prisma.Decimal(15000.0),
    tareWeightKg: new Prisma.Decimal(150.0),
    netWeightKg: new Prisma.Decimal(14850.0),
    brixDegrees: new Prisma.Decimal(22.4),
    initialPh: new Prisma.Decimal(3.45),
    initialAcidityGl: new Prisma.Decimal(6.8),
    temperatureAtIntakeC: new Prisma.Decimal(16.5),
    phytosanitaryStatus: PhytoStatusEnum.PENDING_INSPECTION,
    phytoInspectionPdfUrl: null,
    certifiedByMemberId: null,
    notes: 'Cosecha manual',
    createdAt: new Date(),
  };

  const mockPrismaService = {
    terroir: {
      findFirst: jest.fn(),
    },
    wineryMember: {
      findFirst: jest.fn(),
    },
    harvestBatch: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HarvestBatchesService,
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

    service = module.get<HarvestBatchesService>(HarvestBatchesService);
    prisma = module.get<PrismaService>(PrismaService);
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('debe registrar un lote de vendimia calculando el peso neto (gross - tare)', async () => {
      mockPrismaService.terroir.findFirst.mockResolvedValue(mockTerroir);
      mockPrismaService.harvestBatch.count.mockResolvedValue(0);
      mockPrismaService.harvestBatch.create.mockResolvedValue(mockHarvestBatch);

      const dto = {
        terroirId: mockTerroirId,
        intakeDate: '2026-03-15',
        harvestYear: 2026,
        grossWeightKg: 15000.0,
        tareWeightKg: 150.0,
        brixDegrees: 22.4,
        initialPh: 3.45,
        initialAcidityGl: 6.8,
      };

      const result = await service.create(mockWineryId, dto);

      expect(prisma.terroir.findFirst).toHaveBeenCalledWith({
        where: { id: mockTerroirId, wineryId: mockWineryId },
      });
      expect(prisma.harvestBatch.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          wineryId: mockWineryId,
          terroirId: mockTerroirId,
          harvestBatchCode: 'HARV-2026-CUARTEL4-001',
          grossWeightKg: new Prisma.Decimal(15000.0),
          tareWeightKg: new Prisma.Decimal(150.0),
          netWeightKg: new Prisma.Decimal(14850.0),
        }),
      });
      expect(result).toEqual(mockHarvestBatch);
    });

    it('debe lanzar 422 VALIDATION_ERROR en grossWeightKg si grossWeightKg <= tareWeightKg', async () => {
      mockPrismaService.terroir.findFirst.mockResolvedValue(mockTerroir);

      const dto = {
        terroirId: mockTerroirId,
        intakeDate: '2026-03-15',
        harvestYear: 2026,
        grossWeightKg: 100.0,
        tareWeightKg: 150.0,
        brixDegrees: 22.4,
        initialPh: 3.45,
        initialAcidityGl: 6.8,
      };

      await expect(service.create(mockWineryId, dto)).rejects.toMatchObject({
        statusCode: 422,
        errorCode: 'VALIDATION_ERROR',
        details: [{ field: 'grossWeightKg', message: expect.any(String) }],
      });
      await expect(service.create(mockWineryId, dto)).rejects.toThrow(
        ValidationException,
      );
    });

    it('debe lanzar NotFoundException si la parcela no pertenece a la bodega', async () => {
      mockPrismaService.terroir.findFirst.mockResolvedValue(null);

      const dto = {
        terroirId: 'random-terroir',
        intakeDate: '2026-03-15',
        harvestYear: 2026,
        grossWeightKg: 15000.0,
        tareWeightKg: 150.0,
        brixDegrees: 22.4,
        initialPh: 3.45,
        initialAcidityGl: 6.8,
      };

      await expect(service.create(mockWineryId, dto)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('findAll', () => {
    it('debe retornar lotes de vendimia paginados', async () => {
      mockPrismaService.harvestBatch.findMany.mockResolvedValue([
        mockHarvestBatch,
      ]);
      mockPrismaService.harvestBatch.count.mockResolvedValue(1);

      const result = await service.findAll(mockWineryId, {
        limit: 10,
        offset: 0,
      });

      expect(result).toEqual({
        items: [mockHarvestBatch],
        total: 1,
        limit: 10,
        offset: 0,
      });
      expect(mockPrismaService.harvestBatch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 10, skip: 0 }),
      );
    });
  });

  describe('findById', () => {
    it('debe retornar lote si existe', async () => {
      mockPrismaService.harvestBatch.findFirst.mockResolvedValue(
        mockHarvestBatch,
      );

      const result = await service.findById(mockWineryId, mockHarvestId);

      expect(result.id).toBe(mockHarvestId);
    });

    it('debe lanzar NotFoundException si no existe', async () => {
      mockPrismaService.harvestBatch.findFirst.mockResolvedValue(null);

      await expect(service.findById(mockWineryId, 'random-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('updatePhytoStatus', () => {
    it('debe actualizar el estado fitosanitario', async () => {
      mockPrismaService.harvestBatch.findFirst.mockResolvedValue(
        mockHarvestBatch,
      );
      mockPrismaService.wineryMember.findFirst.mockResolvedValue({
        id: mockMemberId,
      });
      mockPrismaService.harvestBatch.update.mockResolvedValue({
        ...mockHarvestBatch,
        phytosanitaryStatus: PhytoStatusEnum.APPROVED,
        certifiedByMemberId: mockMemberId,
      });

      const result = await service.updatePhytoStatus(
        mockWineryId,
        mockHarvestId,
        mockUserId,
        { phytosanitaryStatus: PhytoStatusEnum.APPROVED },
      );

      expect(result.phytosanitaryStatus).toBe(PhytoStatusEnum.APPROVED);
      expect(prisma.harvestBatch.update).toHaveBeenCalled();
    });
  });
});
