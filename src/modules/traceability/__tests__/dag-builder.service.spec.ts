import { Test, TestingModule } from '@nestjs/testing';
import { DagBuilderService } from '../services/dag-builder.service';
import { PrismaService } from '@shared/prisma/prisma.service';
import { NotFoundException } from '@nestjs/common';
import { Prisma, BeverageTypeEnum, PhytoStatusEnum, TankStatusEnum } from '@prisma/client';

describe('DagBuilderService', () => {
  let service: DagBuilderService;
  let prisma: PrismaService;

  const mockBottlingId = '55555555-5555-5555-5555-555555555555';

  const mockFullBatch = {
    id: mockBottlingId,
    internationalLotCode: 'KUH-2026-SINGANI-001',
    productType: BeverageTypeEnum.SINGANI,
    finalAlcoholAbv: new Prisma.Decimal(40.0),
    waterDilutionLiters: new Prisma.Decimal(1321.0),
    totalBottlesPackaged: 4080,
    packagingFormatCl: 75,
    qrBatchUrl: 'https://drinksonchain.com/trace/batch/KUH-2026-SINGANI-001',
    bottlingDate: new Date('2026-10-01'),
    winery: {
      commercialName: 'Kuhlmann & Cia',
    },
    labAnalysis: {
      certifiedLaboratoryName: 'Laboratorio ISO 17025',
      accreditedLabCertificationCode: 'LAB-2026-991',
      actualAlcoholAbv: new Prisma.Decimal(40.05),
      methanolContentMgL: new Prisma.Decimal(48.0),
      conformsToSenasagStandards: true,
    },
    wineAgingBatch: null,
    productionBatch: {
      id: 'prod-1',
      equipmentIdentifier: 'Alambique Charentais AL-01',
      inputVolumeLiters: new Prisma.Decimal(10000.0),
      outputVolumeLiters: new Prisma.Decimal(1750.0),
      wasteVolumeLiters: new Prisma.Decimal(570.0),
      initialAlcoholPercentage: new Prisma.Decimal(70.2),
      isDoEligible: true,
      processStartDate: new Date('2026-04-01'),
      restStatus: 'READY' as any,
      fermentationTank: {
        id: 'tank-1',
        tankCode: 'TK-03',
        material: 'Acero Inox AISI 316',
        volumeFilledLiters: new Prisma.Decimal(10100.0),
        destinationType: 'SINGANI_DIST' as any,
        startDate: new Date('2026-03-15'),
        harvestBatch: {
          id: 'harvest-1',
          harvestBatchCode: 'HARV-2026-POTRERO-001',
          intakeDate: new Date('2026-03-15'),
          grossWeightKg: new Prisma.Decimal(15000.0),
          tareWeightKg: new Prisma.Decimal(150.0),
          netWeightKg: new Prisma.Decimal(14850.0),
          brixDegrees: new Prisma.Decimal(22.4),
          initialPh: new Prisma.Decimal(3.45),
          initialAcidityGl: new Prisma.Decimal(6.8),
          phytosanitaryStatus: PhytoStatusEnum.APPROVED,
          terroir: {
            id: 'terroir-1',
            parcelName: 'Cuartel 4 - La Finca El Potrero',
            varietyName: '100% Moscatel de Alejandría',
            altitudeMasl: new Prisma.Decimal(1850.0),
            surfaceHectares: new Prisma.Decimal(4.5),
            isDoEligible: true,
            createdAt: new Date('2026-01-01'),
          },
        },
      },
    },
  };

  const mockPrismaService = {
    bottlingBatch: {
      findUnique: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DagBuilderService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    service = module.get<DagBuilderService>(DagBuilderService);
    prisma = module.get<PrismaService>(PrismaService);
    jest.clearAllMocks();
  });

  describe('buildDagForBottlingBatch', () => {
    it('debe reconstruir el grafo DAG completo de 5 etapas para Singani D.O.', async () => {
      mockPrismaService.bottlingBatch.findUnique.mockResolvedValue(mockFullBatch);

      const result = await service.buildDagForBottlingBatch(mockBottlingId);

      expect(result.internationalLotCode).toBe('KUH-2026-SINGANI-001');
      expect(result.productType).toBe(BeverageTypeEnum.SINGANI);
      expect(result.nodes).toHaveLength(5);

      // 0: Plot
      expect(result.nodes[0].stageName).toBe('Plot');
      expect(result.nodes[0].parents).toHaveLength(0);
      expect(result.nodes[0].metrics).toEqual([185000]);

      // 1: Harvest
      expect(result.nodes[1].stageName).toBe('Harvest');
      expect(result.nodes[1].parents[0]).toBe(result.nodes[0].batchId);
      expect(result.nodes[1].metrics).toEqual([2240, 345, 680]);

      // 2: Vinification
      expect(result.nodes[2].stageName).toBe('Vinification');
      expect(result.nodes[2].parents[0]).toBe(result.nodes[1].batchId);

      // 3: Distillation (Stage 4)
      expect(result.nodes[3].stageName).toBe('Distillation');
      expect(result.nodes[3].parents[0]).toBe(result.nodes[2].batchId);
      expect(result.nodes[3].metrics).toEqual([7020]);

      // 4: Bottling (Stage 5)
      expect(result.nodes[4].stageName).toBe('Bottling');
      expect(result.nodes[4].parents[0]).toBe(result.nodes[3].batchId);
      expect(result.nodes[4].metrics).toEqual([4000, 750]);
      expect(result.nodes[4].isCertified).toBe(true);
    });

    it('debe lanzar NotFoundException si el lote no existe', async () => {
      mockPrismaService.bottlingBatch.findUnique.mockResolvedValue(null);

      await expect(service.buildDagForBottlingBatch('random-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
