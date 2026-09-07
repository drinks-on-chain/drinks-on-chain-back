import { Test, TestingModule } from '@nestjs/testing';
import { WineriesService } from '../wineries.service';
import { WineryRepository } from '../repositories/winery.repository';
import { WineryMemberRepository } from '../repositories/winery-member.repository';
import { WalletsService } from '@modules/wallets/wallets.service';
import { OnchainProducerHook } from '../hooks/onchain-producer.hook';
import { PrismaService } from '@shared/prisma/prisma.service';
import { ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import {
  WineryCategoryEnum,
  WineryStatusEnum,
  WineryMemberRoleEnum,
  WalletPurposeEnum,
} from '@prisma/client';

describe('WineriesService', () => {
  let service: WineriesService;
  let wineryRepository: WineryRepository;
  let wineryMemberRepository: WineryMemberRepository;
  let walletsService: WalletsService;
  let onchainProducerHook: OnchainProducerHook;
  let prisma: PrismaService;

  const mockWineryRepository = {
    create: jest.fn(),
    findById: jest.fn(),
    findByTaxId: jest.fn(),
    findPendingWineries: jest.fn(),
    update: jest.fn(),
  };

  const mockWineryMemberRepository = {
    create: jest.fn(),
    findMembership: jest.fn(),
    findMembersByWineryId: jest.fn(),
  };

  const mockWalletsService = {
    provisionWineryWallet: jest.fn(),
  };

  const mockOnchainProducerHook = {
    executeProducerRegistration: jest.fn(),
  };

  const mockPrisma = {
    user: {
      findUnique: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WineriesService,
        { provide: WineryRepository, useValue: mockWineryRepository },
        { provide: WineryMemberRepository, useValue: mockWineryMemberRepository },
        { provide: WalletsService, useValue: mockWalletsService },
        { provide: OnchainProducerHook, useValue: mockOnchainProducerHook },
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<WineriesService>(WineriesService);
    wineryRepository = module.get<WineryRepository>(WineryRepository);
    wineryMemberRepository = module.get<WineryMemberRepository>(WineryMemberRepository);
    walletsService = module.get<WalletsService>(WalletsService);
    onchainProducerHook = module.get<OnchainProducerHook>(OnchainProducerHook);
    prisma = module.get<PrismaService>(PrismaService);

    jest.clearAllMocks();
  });

  describe('createWinery', () => {
    it('debe registrar una bodega en estado PENDING y aprovisionar su billetera', async () => {
      mockWineryRepository.findByTaxId.mockResolvedValue(null);
      mockWineryRepository.create.mockResolvedValue({
        id: 'winery-uuid-1',
        legalName: 'Kohlberg S.A.',
        commercialName: 'Bodega Kohlberg',
        beverageCategory: WineryCategoryEnum.WINERY,
        taxIdNit: '1028374029',
        senasagSanitaryReg: '08-01-03',
        geographicRegion: 'Tarija',
        countryCode: 'BO',
        address: 'Km 15',
        contactEmail: 'contacto@kohlberg.bo',
        contactPhone: null,
        logoUrl: null,
        certificationStatus: WineryStatusEnum.PENDING,
        createdAt: new Date(),
      });
      mockWineryMemberRepository.create.mockResolvedValue({});
      mockWalletsService.provisionWineryWallet.mockResolvedValue({
        id: 'wallet-uuid-1',
        stellarPublicAddress: 'GBZXN7PIRZGNMHGA728JHIITLTINIQUVFD2AZN5HQG5Y3SQ4Q',
        dynamicVaultId: 'vault-123',
      });
      mockWineryRepository.update.mockResolvedValue({
        id: 'winery-uuid-1',
        legalName: 'Kohlberg S.A.',
        commercialName: 'Bodega Kohlberg',
        beverageCategory: WineryCategoryEnum.WINERY,
        taxIdNit: '1028374029',
        senasagSanitaryReg: '08-01-03',
        geographicRegion: 'Tarija',
        countryCode: 'BO',
        address: 'Km 15',
        contactEmail: 'contacto@kohlberg.bo',
        contactPhone: null,
        logoUrl: null,
        stellarPublicKey: 'GBZXN7PIRZGNMHGA728JHIITLTINIQUVFD2AZN5HQG5Y3SQ4Q',
        dynamicVaultId: 'vault-123',
        certificationStatus: WineryStatusEnum.PENDING,
        isExportCertified: false,
        createdAt: new Date(),
        members: [],
      });

      const result = await service.createWinery('user-uuid-1', {
        legalName: 'Kohlberg S.A.',
        commercialName: 'Bodega Kohlberg',
        beverageCategory: WineryCategoryEnum.WINERY,
        taxIdNit: '1028374029',
        geographicRegion: 'Tarija',
        contactEmail: 'contacto@kohlberg.bo',
      });

      expect(result.id).toBe('winery-uuid-1');
      expect(result.certificationStatus).toBe(WineryStatusEnum.PENDING);
      expect(result.stellarPublicKey).toBe(
        'GBZXN7PIRZGNMHGA728JHIITLTINIQUVFD2AZN5HQG5Y3SQ4Q',
      );
      expect(mockWineryMemberRepository.create).toHaveBeenCalledWith({
        userId: 'user-uuid-1',
        wineryId: 'winery-uuid-1',
        memberRole: WineryMemberRoleEnum.OWNER,
      });
      expect(mockWalletsService.provisionWineryWallet).toHaveBeenCalledWith(
        'user-uuid-1',
        'winery-uuid-1',
        WalletPurposeEnum.PRODUCER_SIGNING,
      );
    });

    it('debe arrojar ConflictException si el NIT ya existe', async () => {
      mockWineryRepository.findByTaxId.mockResolvedValue({ id: 'existing' });

      await expect(
        service.createWinery('user-uuid-1', {
          legalName: 'Kohlberg S.A.',
          commercialName: 'Bodega Kohlberg',
          beverageCategory: WineryCategoryEnum.WINERY,
          taxIdNit: '1028374029',
          geographicRegion: 'Tarija',
          contactEmail: 'contacto@kohlberg.bo',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('addMember', () => {
    it('debe agregar exitosamente un miembro operativo a la bodega', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'enologist-user-id',
        fullName: 'Valeria Soliz',
        email: 'valeria@kohlberg.bo',
      });
      mockWineryMemberRepository.findMembership.mockResolvedValue(null);
      mockWineryMemberRepository.create.mockResolvedValue({
        id: 'member-uuid-1',
        userId: 'enologist-user-id',
        wineryId: 'winery-uuid-1',
        memberRole: WineryMemberRoleEnum.ENOLOGIST,
        professionalLicenseNumber: 'ENOL-1234',
        isActive: true,
        joinedAt: new Date(),
      });

      const member = await service.addMember('winery-uuid-1', {
        userId: 'enologist-user-id',
        memberRole: WineryMemberRoleEnum.ENOLOGIST,
        professionalLicenseNumber: 'ENOL-1234',
      });

      expect(member.fullName).toBe('Valeria Soliz');
      expect(member.memberRole).toBe(WineryMemberRoleEnum.ENOLOGIST);
    });

    it('debe arrojar ConflictException si el usuario ya es miembro', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'enologist-user-id' });
      mockWineryMemberRepository.findMembership.mockResolvedValue({ id: 'existing' });

      await expect(
        service.addMember('winery-uuid-1', {
          userId: 'enologist-user-id',
          memberRole: WineryMemberRoleEnum.ENOLOGIST,
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('approveWinery', () => {
    it('debe cambiar el estado a ACTIVE y ejecutar el hook de registro on-chain', async () => {
      const pendingWinery = {
        id: 'winery-uuid-1',
        commercialName: 'Bodega Kohlberg',
        taxIdNit: '1028374029',
        countryCode: 'BO',
        stellarPublicKey: 'GBZXN7PIRZGNMHGA728JHIITLTINIQUVFD2AZN5HQG5Y3SQ4Q',
        certificationStatus: WineryStatusEnum.PENDING,
      };
      mockWineryRepository.findById.mockResolvedValue(pendingWinery);
      mockOnchainProducerHook.executeProducerRegistration.mockResolvedValue({
        onchainProducerId: 'PROD_BO_1028374029',
        txHash: '0x_simulated_tx_12345',
        isSimulated: true,
      });
      mockWineryRepository.update.mockResolvedValue({
        ...pendingWinery,
        certificationStatus: WineryStatusEnum.ACTIVE,
        approvedAt: new Date(),
        approvedByUserId: 'admin-user-id',
        onchainProducerId: 'PROD_BO_1028374029',
        onchainRegisterTxHash: '0x_simulated_tx_12345',
        members: [],
      });

      const result = await service.approveWinery('winery-uuid-1', 'admin-user-id');

      expect(result.certificationStatus).toBe(WineryStatusEnum.ACTIVE);
      expect(result.onchainProducerId).toBe('PROD_BO_1028374029');
      expect(result.onchainRegisterTxHash).toBe('0x_simulated_tx_12345');
      expect(
        mockOnchainProducerHook.executeProducerRegistration,
      ).toHaveBeenCalledWith(
        pendingWinery,
        'GBZXN7PIRZGNMHGA728JHIITLTINIQUVFD2AZN5HQG5Y3SQ4Q',
      );
    });

    it('debe arrojar BadRequestException si la bodega ya no está en estado PENDING', async () => {
      mockWineryRepository.findById.mockResolvedValue({
        id: 'winery-uuid-1',
        certificationStatus: WineryStatusEnum.ACTIVE,
      });

      await expect(
        service.approveWinery('winery-uuid-1', 'admin-user-id'),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
