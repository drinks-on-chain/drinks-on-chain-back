import { Test, TestingModule } from '@nestjs/testing';
import { TerroirsService } from '../terroirs.service';
import { PrismaService } from '@shared/prisma/prisma.service';
import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

describe('TerroirsService', () => {
  let service: TerroirsService;
  let prisma: PrismaService;

  const mockWineryId = '11111111-1111-1111-1111-111111111111';
  const mockTerroirId = '22222222-2222-2222-2222-222222222222';

  const mockTerroir = {
    id: mockTerroirId,
    wineryId: mockWineryId,
    parcelName: 'Cuartel 4 - La Finca El Potrero',
    cadastreCode: 'CAT-4022',
    surfaceHectares: new Prisma.Decimal(4.5),
    altitudeMasl: new Prisma.Decimal(1850.0),
    latitude: new Prisma.Decimal(-21.48512),
    longitude: new Prisma.Decimal(-64.78921),
    geographicPolygonGeojson: { type: 'Polygon', coordinates: [] },
    rawMaterialType: 'uva',
    varietyName: 'Moscatel de Alejandría',
    soilType: 'Franco-arcilloso',
    irrigationSystem: 'Goteo',
    isDoEligible: true,
    doType: 'D.O. Singani',
    doCertificateUrl: 'https://example.com/cert.pdf',
    isActive: true,
    createdAt: new Date(),
  };

  const mockPrismaService = {
    terroir: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TerroirsService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
      ],
    }).compile();

    service = module.get<TerroirsService>(TerroirsService);
    prisma = module.get<PrismaService>(PrismaService);
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('debe registrar una nueva parcela exitosamente', async () => {
      mockPrismaService.terroir.create.mockResolvedValue(mockTerroir);

      const dto = {
        parcelName: 'Cuartel 4 - La Finca El Potrero',
        surfaceHectares: 4.5,
        altitudeMasl: 1850.0,
        rawMaterialType: 'uva',
        varietyName: 'Moscatel de Alejandría',
        isDoEligible: true,
      };

      const result = await service.create(mockWineryId, dto);

      expect(prisma.terroir.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          wineryId: mockWineryId,
          parcelName: dto.parcelName,
          surfaceHectares: new Prisma.Decimal(4.5),
          altitudeMasl: new Prisma.Decimal(1850.0),
        }),
      });
      expect(result).toEqual(mockTerroir);
    });
  });

  describe('findAll', () => {
    it('debe retornar lista paginada de parcelas', async () => {
      mockPrismaService.terroir.findMany.mockResolvedValue([mockTerroir]);
      mockPrismaService.terroir.count.mockResolvedValue(1);

      const result = await service.findAll(mockWineryId, {
        limit: 10,
        offset: 0,
      });

      expect(result).toEqual({
        items: [mockTerroir],
        total: 1,
        limit: 10,
        offset: 0,
      });
      expect(prisma.terroir.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 10, skip: 0 }),
      );
    });
  });

  describe('findById', () => {
    it('debe retornar una parcela si existe y pertenece a la bodega', async () => {
      mockPrismaService.terroir.findFirst.mockResolvedValue(mockTerroir);

      const result = await service.findById(mockWineryId, mockTerroirId);

      expect(result.id).toBe(mockTerroirId);
      expect(prisma.terroir.findFirst).toHaveBeenCalledWith({
        where: { id: mockTerroirId, wineryId: mockWineryId },
        include: { harvestBatches: { orderBy: { intakeDate: 'desc' } } },
      });
    });

    it('debe lanzar NotFoundException si no pertenece a la bodega o no existe', async () => {
      mockPrismaService.terroir.findFirst.mockResolvedValue(null);

      await expect(service.findById(mockWineryId, 'random-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('update', () => {
    it('debe actualizar una parcela existente', async () => {
      mockPrismaService.terroir.findFirst.mockResolvedValue(mockTerroir);
      mockPrismaService.terroir.update.mockResolvedValue({
        ...mockTerroir,
        altitudeMasl: new Prisma.Decimal(1900.0),
      });

      const result = await service.update(mockWineryId, mockTerroirId, {
        altitudeMasl: 1900.0,
      });

      expect(result.altitudeMasl).toEqual(new Prisma.Decimal(1900.0));
      expect(prisma.terroir.update).toHaveBeenCalled();
    });
  });
});
