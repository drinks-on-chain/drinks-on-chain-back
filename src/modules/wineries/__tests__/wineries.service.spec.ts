import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { WineryCategoryEnum, WineryStatusEnum } from '@prisma/client';
import { WineriesService } from '../wineries.service';
import { WineryRepository } from '../repositories/winery.repository';
import { PrismaService } from '@shared/prisma/prisma.service';
import { OrganizationsService } from '@modules/organizations/organizations.service';

/**
 * Directorio y perfil de la bodega activa (lo que queda del módulo de 0.1
 * tras retirar la autoinscripción, la aprobación antigua y `my/members*`
 * en H1).
 */
describe('WineriesService', () => {
  let service: WineriesService;

  const winery = {
    id: 'winery-uuid-1',
    legalName: 'Kohlberg S.A.',
    commercialName: 'Bodega Kohlberg',
    beverageCategory: WineryCategoryEnum.WINERY,
    taxIdNit: '1028374029',
    senasagSanitaryReg: null,
    geographicRegion: 'Tarija',
    countryCode: 'BO',
    address: null,
    contactEmail: 'contacto@kohlberg.bo',
    contactPhone: null,
    logoUrl: null,
    stellarPublicKey: null,
    onchainProducerId: null,
    onchainRegisterTxHash: null,
    isExportCertified: false,
    certificationStatus: WineryStatusEnum.ACTIVE,
    approvedAt: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
  };

  const mockTx = { tx: true };
  const mockWineryRepository = {
    findById: jest.fn(),
    update: jest.fn(),
  };
  const mockOrganizations = { syncWinery: jest.fn().mockResolvedValue({}) };
  const mockPrisma = {
    winery: { findMany: jest.fn(), count: jest.fn() },
    $transaction: jest.fn((callback: (tx: typeof mockTx) => Promise<unknown>) =>
      callback(mockTx),
    ),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WineriesService,
        { provide: WineryRepository, useValue: mockWineryRepository },
        { provide: PrismaService, useValue: mockPrisma },
        { provide: OrganizationsService, useValue: mockOrganizations },
      ],
    }).compile();
    service = module.get(WineriesService);
    jest.clearAllMocks();
  });

  it('getMyWinery: 404 si la bodega no existe', async () => {
    mockWineryRepository.findById.mockResolvedValue(null);
    await expect(service.getMyWinery('nada')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('updateMyWinery: bodega y organización en la misma transacción', async () => {
    mockWineryRepository.update.mockResolvedValue({
      ...winery,
      commercialName: 'Kohlberg',
    });
    mockWineryRepository.findById.mockResolvedValue({
      ...winery,
      commercialName: 'Kohlberg',
      members: [],
    });

    const result = await service.updateMyWinery(winery.id, {
      commercialName: '  Kohlberg ',
    });

    expect(mockWineryRepository.update).toHaveBeenCalledWith(
      winery.id,
      expect.objectContaining({ commercialName: 'Kohlberg' }),
      mockTx,
    );
    expect(mockOrganizations.syncWinery).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({ id: winery.id }),
    );
    expect(result).toMatchObject({ id: winery.id, commercialName: 'Kohlberg' });
  });

  it('findAllWineries: página { items, total, limit, offset } con filtros', async () => {
    mockPrisma.winery.findMany.mockResolvedValue([winery]);
    mockPrisma.winery.count.mockResolvedValue(3);

    const page = await service.findAllWineries({
      limit: 1,
      offset: 2,
      status: WineryStatusEnum.ACTIVE,
    });

    expect(page).toMatchObject({ total: 3, limit: 1, offset: 2 });
    expect(page.items).toHaveLength(1);
    expect(mockPrisma.winery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { certificationStatus: WineryStatusEnum.ACTIVE },
        take: 1,
        skip: 2,
      }),
    );
  });
});
