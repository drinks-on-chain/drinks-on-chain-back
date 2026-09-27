import { Test, TestingModule } from '@nestjs/testing';
import { UsersService } from '../users.service';
import { UserRepository } from '../repositories/user.repository';
import { WalletsService } from '@modules/wallets/wallets.service';
import { MembershipsService } from '@modules/organizations/memberships.service';
import { SessionsService } from '@modules/auth/sessions/sessions.service';
import type { AuthenticatedUser } from '@shared/decorators/current-user.decorator';
import { NotFoundException } from '@nestjs/common';
import {
  UserRoleEnum,
  WineryMemberRoleEnum,
  WalletTypeEnum,
  WalletPurposeEnum,
} from '@prisma/client';

describe('UsersService', () => {
  let service: UsersService;

  const mockUserRepository = {
    findById: jest.fn(),
    findByEmail: jest.fn(),
    update: jest.fn(),
  };

  const mockWalletsService = {
    getUserPrimaryWallet: jest.fn(),
  };

  const mockMemberships = {
    listForUser: jest.fn(),
  };

  const mockSessions = {
    revokeAllForUser: jest.fn().mockResolvedValue(2),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: UserRepository, useValue: mockUserRepository },
        { provide: WalletsService, useValue: mockWalletsService },
        { provide: MembershipsService, useValue: mockMemberships },
        { provide: SessionsService, useValue: mockSessions },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);

    jest.clearAllMocks();
  });

  describe('getProfile', () => {
    it('debe retornar el perfil completo del usuario con membresías y billetera', async () => {
      mockUserRepository.findById.mockResolvedValue({
        id: 'user-uuid-1',
        email: 'enologo@kohlberg.bo',
        fullName: 'Valeria Soliz',
        userRole: UserRoleEnum.ENOLOGIST,
        phoneNumber: '+59170012345',
        preferredLocale: 'es',
        isActive: true,
        lastLoginAt: new Date(),
        createdAt: new Date(),
        wineryMemberships: [
          {
            wineryId: 'winery-uuid-1',
            memberRole: WineryMemberRoleEnum.ENOLOGIST,
            professionalLicenseNumber: 'ENOL-BOL-2024',
            isActive: true,
            joinedAt: new Date(),
            winery: {
              commercialName: 'Bodega Kohlberg',
            },
          },
        ],
        wallets: [
          {
            id: 'wallet-uuid-1',
            userId: 'user-uuid-1',
            wineryId: null,
            stellarPublicAddress:
              'GBZXN7PIRZGNMHGA728JHIITLTINIQUVFD2AZN5HQG5Y3SQ4Q',
            walletType: WalletTypeEnum.CUSTODIAL,
            walletPurpose: WalletPurposeEnum.CONSUMER_NFT,
            isPrimary: true,
            createdAt: new Date(),
          },
        ],
      });

      const profile = await service.getProfile('user-uuid-1');

      expect(profile.email).toBe('enologo@kohlberg.bo');
      expect(profile.wineryMemberships).toHaveLength(1);
      expect(profile.wineryMemberships[0].wineryName).toBe('Bodega Kohlberg');
      expect(profile.primaryWallet?.stellarPublicAddress).toBe(
        'GBZXN7PIRZGNMHGA728JHIITLTINIQUVFD2AZN5HQG5Y3SQ4Q',
      );
    });

    it('debe arrojar NotFoundException si el usuario no existe', async () => {
      mockUserRepository.findById.mockResolvedValue(null);

      await expect(service.getProfile('non-existent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('updateProfile', () => {
    it('debe actualizar los datos de perfil y retornar el perfil renovado', async () => {
      mockUserRepository.update.mockResolvedValue({});
      jest.spyOn(service, 'getProfile').mockResolvedValue({
        id: 'user-uuid-1',
        email: 'valeria@kohlberg.bo',
        fullName: 'Valeria Soliz Updated',
        userRole: UserRoleEnum.ENOLOGIST,
        phoneNumber: '+59170099999',
        preferredLocale: 'en',
        isActive: true,
        lastLoginAt: null,
        createdAt: new Date(),
        wineryMemberships: [],
        primaryWallet: null,
      });

      const result = await service.updateProfile('user-uuid-1', {
        fullName: 'Valeria Soliz Updated',
        phoneNumber: '+59170099999',
        preferredLocale: 'en',
      });

      expect(mockUserRepository.update).toHaveBeenCalledWith('user-uuid-1', {
        fullName: 'Valeria Soliz Updated',
        phoneNumber: '+59170099999',
        preferredLocale: 'en',
      });
      expect(result.fullName).toBe('Valeria Soliz Updated');
    });
  });

  describe('getMe (contrato O0 §5)', () => {
    it('devuelve { user (con audience), memberships, activeOrganizationId }', async () => {
      const profile = {
        id: 'user-uuid-1',
        email: 'valeria@kohlberg.bo',
        fullName: 'Valeria',
        userRole: UserRoleEnum.ENOLOGIST,
        phoneNumber: null,
        preferredLocale: 'es',
        isActive: true,
        lastLoginAt: null,
        createdAt: new Date(),
        wineryMemberships: [],
        primaryWallet: null,
      };
      jest.spyOn(service, 'getProfile').mockResolvedValue(profile);
      const membership = {
        id: 'm1',
        organizationId: 'winery-1',
        organizationType: 'WINERY' as const,
        organizationName: 'Bodega',
        organizationStatus: 'ACTIVE' as const,
        role: 'ENOLOGIST' as const,
        status: 'ACTIVE' as const,
      };
      mockMemberships.listForUser.mockResolvedValue([membership]);

      const me = await service.getMe({
        id: 'user-uuid-1',
        organizationId: 'winery-1',
      } as AuthenticatedUser);

      expect(me).toEqual({
        user: { ...profile, audience: 'STAFF' },
        memberships: [membership],
        activeOrganizationId: 'winery-1',
      });
    });
  });

  describe('blockAccount (IAM-13)', () => {
    it('desactiva la cuenta y revoca todas sus sesiones', async () => {
      mockUserRepository.update.mockResolvedValue({});

      await service.blockAccount('user-uuid-1');

      expect(mockUserRepository.update).toHaveBeenCalledWith('user-uuid-1', {
        isActive: false,
      });
      expect(mockSessions.revokeAllForUser).toHaveBeenCalledWith(
        'user-uuid-1',
        'USER_BLOCKED',
      );
    });
  });
});
