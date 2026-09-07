import { Test, TestingModule } from '@nestjs/testing';
import { LabAnalysesService } from '../services/lab-analyses.service';
import { PrismaService } from '@shared/prisma/prisma.service';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

describe('LabAnalysesService', () => {
  let service: LabAnalysesService;
  let prisma: PrismaService;

  const mockWineryId = '11111111-1111-1111-1111-111111111111';
  const mockBottlingId = '22222222-2222-2222-2222-222222222222';
  const mockAnalysisId = '33333333-3333-3333-3333-333333333333';
  const mockUserId = '44444444-4444-4444-4444-444444444444';
  const mockMemberId = '55555555-5555-5555-5555-555555555555';

  const mockBottlingBatch = {
    id: mockBottlingId,
    wineryId: mockWineryId,
    internationalLotCode: 'KUH-2026-SINGANI-001',
    labAnalysis: null,
  };

  const mockAnalysis = {
    id: mockAnalysisId,
    bottlingBatchId: mockBottlingId,
    certifiedLaboratoryName: 'Laboratorio ISO 17025',
    accreditedLabCertificationCode: 'LAB-2026-01',
    testPerformedAt: new Date('2026-10-04'),
    actualAlcoholAbv: new Prisma.Decimal(40.05),
    totalAcidityTartaricGl: new Prisma.Decimal(4.8),
    volatileAcidityAceticGl: new Prisma.Decimal(0.22),
    methanolContentMgL: new Prisma.Decimal(48.0),
    copperContentMgL: new Prisma.Decimal(0.02),
    laboratoryReportPdfUrl: 'https://example.com/lab.pdf',
    conformsToSenasagStandards: true,
    reviewedByMemberId: mockMemberId,
    createdAt: new Date(),
  };

  const mockPrismaService = {
    bottlingBatch: {
      findFirst: jest.fn(),
    },
    batchLabAnalysis: {
      create: jest.fn(),
    },
    wineryMember: {
      findFirst: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LabAnalysesService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    service = module.get<LabAnalysesService>(LabAnalysesService);
    prisma = module.get<PrismaService>(PrismaService);
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('debe registrar un análisis de laboratorio válido', async () => {
      mockPrismaService.bottlingBatch.findFirst.mockResolvedValue(mockBottlingBatch);
      mockPrismaService.wineryMember.findFirst.mockResolvedValue({ id: mockMemberId });
      mockPrismaService.batchLabAnalysis.create.mockResolvedValue(mockAnalysis);

      const dto = {
        bottlingBatchId: mockBottlingId,
        certifiedLaboratoryName: 'Laboratorio ISO 17025',
        accreditedLabCertificationCode: 'LAB-2026-01',
        testPerformedAt: '2026-10-04',
        actualAlcoholAbv: 40.05,
        totalAcidityTartaricGl: 4.8,
        volatileAcidityAceticGl: 0.22,
        methanolContentMgL: 48.0,
        copperContentMgL: 0.02,
        laboratoryReportPdfUrl: 'https://example.com/lab.pdf',
      };

      const result = await service.create(mockWineryId, mockUserId, dto);

      expect(prisma.bottlingBatch.findFirst).toHaveBeenCalledWith({
        where: { id: mockBottlingId, wineryId: mockWineryId },
        include: { labAnalysis: true },
      });
      expect(prisma.batchLabAnalysis.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          bottlingBatchId: mockBottlingId,
          conformsToSenasagStandards: true,
        }),
      });
      expect(result).toEqual(mockAnalysis);
    });

    it('debe marcar conformsToSenasagStandards como false si el metanol supera 200 mg/100ml', async () => {
      mockPrismaService.bottlingBatch.findFirst.mockResolvedValue(mockBottlingBatch);
      mockPrismaService.wineryMember.findFirst.mockResolvedValue({ id: mockMemberId });
      mockPrismaService.batchLabAnalysis.create.mockResolvedValue({
        ...mockAnalysis,
        conformsToSenasagStandards: false,
      });

      const dto = {
        bottlingBatchId: mockBottlingId,
        certifiedLaboratoryName: 'Laboratorio ISO 17025',
        accreditedLabCertificationCode: 'LAB-2026-01',
        testPerformedAt: '2026-10-04',
        actualAlcoholAbv: 40.05,
        totalAcidityTartaricGl: 4.8,
        volatileAcidityAceticGl: 0.22,
        methanolContentMgL: 250.0, // Excede 200 mg/100ml
        laboratoryReportPdfUrl: 'https://example.com/lab.pdf',
      };

      await service.create(mockWineryId, mockUserId, dto);

      expect(prisma.batchLabAnalysis.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          conformsToSenasagStandards: false,
        }),
      });
    });

    it('debe lanzar ConflictException si el lote ya tiene un análisis registrado', async () => {
      mockPrismaService.bottlingBatch.findFirst.mockResolvedValue({
        ...mockBottlingBatch,
        labAnalysis: { id: 'existing-analysis' },
      });

      const dto = {
        bottlingBatchId: mockBottlingId,
        certifiedLaboratoryName: 'Laboratorio ISO 17025',
        accreditedLabCertificationCode: 'LAB-2026-01',
        testPerformedAt: '2026-10-04',
        actualAlcoholAbv: 40.05,
        totalAcidityTartaricGl: 4.8,
        volatileAcidityAceticGl: 0.22,
        laboratoryReportPdfUrl: 'https://example.com/lab.pdf',
      };

      await expect(service.create(mockWineryId, mockUserId, dto)).rejects.toThrow(
        ConflictException,
      );
    });
  });
});
