import { Test, TestingModule } from '@nestjs/testing';
import { WineriesService } from '../wineries.service';
import { WineryRepository } from '../repositories/winery.repository';
import { WineryMemberRepository } from '../repositories/winery-member.repository';
import { WalletsService } from '@modules/wallets/wallets.service';
import { OnchainProducerHook } from '../hooks/onchain-producer.hook';
import { PrismaService } from '@shared/prisma/prisma.service';
import { OutboxService } from '@shared/outbox/outbox.service';
import { ConflictException } from '@nestjs/common';
import {
  WineryCategoryEnum,
  WineryStatusEnum,
  WineryMemberRoleEnum,
  WalletPurposeEnum,
} from '@prisma/client';

describe('WineriesService', () => {
  let service: WineriesService;

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
    provisionUserWallet: jest.fn(),
  };

  const mockOutbox = {
    add: jest.fn().mockResolvedValue({ id: 'evt-1' }),
  };

  // Cliente de la transacción: lo que reciben repositorios y outbox
  const mockTx = {
    user: {
      create: jest.fn(),
    },
  };

  const mockOnchainProducerHook = {
    executeProducerRegistration: jest.fn(),
  };

  const mockPrisma = {
    user: {
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
    },
    winery: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
    $transaction: jest.fn((callback: (tx: typeof mockTx) => Promise<unknown>) =>
      callback(mockTx),
    ),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WineriesService,
        { provide: WineryRepository, useValue: mockWineryRepository },
        {
          provide: WineryMemberRepository,
          useValue: mockWineryMemberRepository,
        },
        { provide: WalletsService, useValue: mockWalletsService },
        { provide: OnchainProducerHook, useValue: mockOnchainProducerHook },
        { provide: PrismaService, useValue: mockPrisma },
        { provide: OutboxService, useValue: mockOutbox },
      ],
    }).compile();

    service = module.get<WineriesService>(WineriesService);

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
        stellarPublicAddress:
          'GBZXN7PIRZGNMHGA728JHIITLTINIQUVFD2AZN5HQG5Y3SQ4Q',
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
      expect(mockWineryMemberRepository.create).toHaveBeenCalledWith(
        {
          userId: 'user-uuid-1',
          wineryId: 'winery-uuid-1',
          memberRole: WineryMemberRoleEnum.OWNER,
        },
        mockTx,
      );
      expect(mockWalletsService.provisionWineryWallet).toHaveBeenCalledWith(
        'user-uuid-1',
        'winery-uuid-1',
        WalletPurposeEnum.PRODUCER_SIGNING,
        mockTx,
      );
    });

    it('escribe todo en una transacción junto con el evento winery.created', async () => {
      mockWineryRepository.findByTaxId.mockResolvedValue(null);
      mockWineryRepository.create.mockResolvedValue({ id: 'winery-uuid-1' });
      mockWineryMemberRepository.create.mockResolvedValue({});
      mockWalletsService.provisionWineryWallet.mockResolvedValue({
        id: 'wallet-uuid-1',
        stellarPublicAddress: 'GABC',
        dynamicVaultId: 'vault-123',
      });
      mockWineryRepository.update.mockResolvedValue({
        id: 'winery-uuid-1',
        stellarPublicKey: 'GABC',
        certificationStatus: WineryStatusEnum.PENDING,
      });

      await service.createWinery('user-uuid-1', {
        legalName: 'Kohlberg S.A.',
        commercialName: 'Bodega Kohlberg',
        beverageCategory: WineryCategoryEnum.WINERY,
        taxIdNit: '1028374029',
        geographicRegion: 'Tarija',
        contactEmail: 'contacto@kohlberg.bo',
      });

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockWineryRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ taxIdNit: '1028374029' }),
        mockTx,
      );
      expect(mockWineryRepository.update).toHaveBeenCalledWith(
        'winery-uuid-1',
        { stellarPublicKey: 'GABC', dynamicVaultId: 'vault-123' },
        mockTx,
      );
      expect(mockOutbox.add).toHaveBeenCalledWith(mockTx, {
        type: 'winery.created',
        aggregateType: 'winery',
        aggregateId: 'winery-uuid-1',
        queue: 'chain',
        payload: {
          wineryId: 'winery-uuid-1',
          ownerUserId: 'user-uuid-1',
          walletId: 'wallet-uuid-1',
          vaultId: 'vault-123',
          stellarPublicKey: 'GABC',
        },
      });
    });

    it('si un paso falla, el error sale de la transacción y no se escribe el evento', async () => {
      mockWineryRepository.findByTaxId.mockResolvedValue(null);
      mockWineryRepository.create.mockResolvedValue({ id: 'winery-uuid-1' });
      mockWineryMemberRepository.create.mockResolvedValue({});
      mockWalletsService.provisionWineryWallet.mockRejectedValue(
        new Error('proveedor caído'),
      );

      await expect(
        service.createWinery('user-uuid-1', {
          legalName: 'Kohlberg S.A.',
          commercialName: 'Bodega Kohlberg',
          beverageCategory: WineryCategoryEnum.WINERY,
          taxIdNit: '1028374029',
          geographicRegion: 'Tarija',
          contactEmail: 'contacto@kohlberg.bo',
        }),
      ).rejects.toThrow('proveedor caído');
      expect(mockOutbox.add).not.toHaveBeenCalled();
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
      mockWineryMemberRepository.findMembership.mockResolvedValue({
        id: 'existing',
      });

      await expect(
        service.addMember('winery-uuid-1', {
          userId: 'enologist-user-id',
          memberRole: WineryMemberRoleEnum.ENOLOGIST,
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('createAndAddMember', () => {
    it('crea usuario, billetera y membresía en una transacción con member.added', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockTx.user.create.mockResolvedValue({
        id: 'user-new',
        fullName: 'Valeria Soliz',
        email: 'valeria@kohlberg.bo',
      });
      mockWalletsService.provisionUserWallet.mockResolvedValue({
        id: 'wallet-new',
        dynamicVaultId: 'vault-new',
      });
      mockWineryMemberRepository.create.mockResolvedValue({
        id: 'member-new',
        memberRole: WineryMemberRoleEnum.ENOLOGIST,
        professionalLicenseNumber: null,
        isActive: true,
        joinedAt: new Date('2026-09-27T10:00:00.000Z'),
      });

      const member = await service.createAndAddMember('winery-uuid-1', {
        email: 'Valeria@Kohlberg.bo ',
        password: 'Secreta123!',
        fullName: 'Valeria Soliz',
        memberRole: WineryMemberRoleEnum.ENOLOGIST,
      });

      expect(member).toEqual({
        id: 'member-new',
        userId: 'user-new',
        fullName: 'Valeria Soliz',
        email: 'valeria@kohlberg.bo',
        memberRole: WineryMemberRoleEnum.ENOLOGIST,
        professionalLicenseNumber: null,
        isActive: true,
        joinedAt: new Date('2026-09-27T10:00:00.000Z'),
      });
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockPrisma.user.create).not.toHaveBeenCalled();
      expect(mockTx.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ email: 'valeria@kohlberg.bo' }),
      });
      expect(mockWalletsService.provisionUserWallet).toHaveBeenCalledWith(
        'user-new',
        WalletPurposeEnum.CONSUMER_NFT,
        mockTx,
      );
      expect(mockWineryMemberRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-new',
          wineryId: 'winery-uuid-1',
        }),
        mockTx,
      );
      expect(mockOutbox.add).toHaveBeenCalledWith(mockTx, {
        type: 'member.added',
        aggregateType: 'winery',
        aggregateId: 'winery-uuid-1',
        queue: 'chain',
        payload: {
          wineryId: 'winery-uuid-1',
          userId: 'user-new',
          memberId: 'member-new',
          memberRole: WineryMemberRoleEnum.ENOLOGIST,
          walletId: 'wallet-new',
          vaultId: 'vault-new',
        },
      });
    });

    it('rechaza un correo ya registrado sin abrir la transacción', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'existing' });

      await expect(
        service.createAndAddMember('winery-uuid-1', {
          email: 'valeria@kohlberg.bo',
          password: 'Secreta123!',
          fullName: 'Valeria Soliz',
          memberRole: WineryMemberRoleEnum.ENOLOGIST,
        }),
      ).rejects.toThrow(ConflictException);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
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

      const result = await service.approveWinery(
        'winery-uuid-1',
        'admin-user-id',
      );

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

    it('debe arrojar 409 WINERY_NOT_PENDING si la bodega ya no está en estado PENDING', async () => {
      mockWineryRepository.findById.mockResolvedValue({
        id: 'winery-uuid-1',
        certificationStatus: WineryStatusEnum.ACTIVE,
      });

      await expect(
        service.approveWinery('winery-uuid-1', 'admin-user-id'),
      ).rejects.toMatchObject({
        statusCode: 409,
        errorCode: 'WINERY_NOT_PENDING',
      });
    });
  });

  describe('listas paginadas (contrato O0 §2)', () => {
    it('getPendingWineries devuelve { items, total, limit, offset } y pagina en el repositorio', async () => {
      mockWineryRepository.findPendingWineries.mockResolvedValue([
        [
          {
            id: 'winery-uuid-2',
            legalName: 'Pendiente S.A.',
            commercialName: 'Bodega Pendiente',
            certificationStatus: WineryStatusEnum.PENDING,
          },
        ],
        41,
      ]);

      const page = await service.getPendingWineries({ limit: 20, offset: 20 });

      expect(mockWineryRepository.findPendingWineries).toHaveBeenCalledWith({
        take: 20,
        skip: 20,
      });
      expect(page).toMatchObject({ total: 41, limit: 20, offset: 20 });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({ id: 'winery-uuid-2' });
    });

    it('getMyMembers devuelve { items, total, limit, offset } de la bodega', async () => {
      mockWineryMemberRepository.findMembersByWineryId.mockResolvedValue([
        [
          {
            id: 'member-1',
            memberRole: WineryMemberRoleEnum.ENOLOGIST,
            professionalLicenseNumber: null,
            isActive: true,
            joinedAt: new Date('2026-09-01T00:00:00Z'),
            user: {
              id: 'user-1',
              fullName: 'Valeria Soliz',
              email: 'valeria@example.com',
            },
          },
        ],
        1,
      ]);

      const page = await service.getMyMembers('winery-uuid-1', {
        limit: 5,
        offset: 0,
      });

      expect(
        mockWineryMemberRepository.findMembersByWineryId,
      ).toHaveBeenCalledWith('winery-uuid-1', { take: 5, skip: 0 });
      expect(page).toEqual({
        items: [
          {
            id: 'member-1',
            userId: 'user-1',
            fullName: 'Valeria Soliz',
            email: 'valeria@example.com',
            memberRole: WineryMemberRoleEnum.ENOLOGIST,
            professionalLicenseNumber: null,
            isActive: true,
            joinedAt: new Date('2026-09-01T00:00:00Z'),
          },
        ],
        total: 1,
        limit: 5,
        offset: 0,
      });
    });
  });
});
