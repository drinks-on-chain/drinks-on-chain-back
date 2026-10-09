import { Test, TestingModule } from '@nestjs/testing';
import { UsersService } from '../users.service';
import { UserRepository } from '../repositories/user.repository';
import { WalletsService } from '@modules/wallets/wallets.service';
import { MembershipsService } from '@modules/organizations/memberships.service';
import { SessionsService } from '@modules/auth/sessions/sessions.service';
import type { AuthenticatedUser } from '@shared/decorators/current-user.decorator';
import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '@shared/prisma/prisma.service';
import { AuditService } from '@shared/audit/audit.service';
import { WineryMemberRoleEnum } from '@prisma/client';

describe('UsersService', () => {
  let service: UsersService;

  const mockUserRepository = {
    findById: jest.fn(),
    findByEmail: jest.fn(),
    update: jest.fn(),
  };

  const mockWalletsService = {
    getWallet: jest.fn(),
  };

  const mockMemberships = {
    listForUser: jest.fn(),
  };

  const mockSessions = {
    revokeAllForUser: jest.fn().mockResolvedValue(2),
  };

  const txClient = { user: { update: jest.fn() } };
  const mockPrisma = {
    user: { findUnique: jest.fn() },
    tx: txClient,
    $transaction: jest.fn((fn: (tx: typeof txClient) => unknown) =>
      fn(txClient),
    ),
  };

  const mockAudit = { record: jest.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: UserRepository, useValue: mockUserRepository },
        { provide: WalletsService, useValue: mockWalletsService },
        { provide: MembershipsService, useValue: mockMemberships },
        { provide: SessionsService, useValue: mockSessions },
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AuditService, useValue: mockAudit },
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
      });

      const profile = await service.getProfile('user-uuid-1');

      expect(profile.email).toBe('enologo@kohlberg.bo');
      expect(profile.wineryMemberships).toHaveLength(1);
      expect(profile.wineryMemberships[0].wineryName).toBe('Bodega Kohlberg');
      // SE-02: sin billeteras simuladas; el campo legado queda en null
      expect(profile.primaryWallet).toBeNull();
    });

    it('debe arrojar NotFoundException si el usuario no existe', async () => {
      mockUserRepository.findById.mockResolvedValue(null);

      await expect(service.getProfile('non-existent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getMe y updateMe (contrato O0 §5, O1 §1)', () => {
    const repoUser = {
      id: 'user-uuid-1',
      email: 'valeria@kohlberg.bo',
      fullName: 'Valeria',
      phoneNumber: null,
      preferredLocale: 'es',
      isActive: true,
      lastLoginAt: null,
      createdAt: new Date('2026-09-01T00:00:00Z'),
      notificationPrefs: { lotProgress: true },
      promotionsConsentAt: null as Date | null,
      wineryMemberships: [],
    };
    const membership = {
      id: 'm1',
      organizationId: 'winery-1',
      organizationType: 'WINERY' as const,
      organizationName: 'Bodega',
      organizationStatus: 'ACTIVE' as const,
      role: 'ENOLOGIST' as const,
      status: 'ACTIVE' as const,
    };
    const principal = {
      id: 'user-uuid-1',
      organizationId: 'winery-1',
    } as AuthenticatedUser;

    it('getMe: { user (audience y preferencias), memberships, activeOrganizationId }', async () => {
      mockUserRepository.findById.mockResolvedValue(repoUser);
      mockMemberships.listForUser.mockResolvedValue([membership]);

      const me = await service.getMe(principal);

      expect(me.user).toMatchObject({
        id: 'user-uuid-1',
        audience: 'STAFF',
        notificationPrefs: { lotProgress: true, redemptionReminders: true },
        promotionsConsent: false,
      });
      expect(me.memberships).toEqual([membership]);
      expect(me.activeOrganizationId).toBe('winery-1');
    });

    it('updateMe: preferencias parciales, consentimiento con fecha y bitácora', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(repoUser);
      mockPrisma.tx.user.update.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) => ({
          ...repoUser,
          ...data,
        }),
      );
      mockUserRepository.findById.mockResolvedValue(repoUser);
      mockMemberships.listForUser.mockResolvedValue([membership]);

      const me = await service.updateMe(principal, {
        fullName: '  Valeria Soliz ',
        notificationPrefs: { redemptionReminders: false },
        promotionsConsent: true,
      });

      const data = mockPrisma.tx.user.update.mock.calls[0][0].data;
      expect(data.fullName).toBe('Valeria Soliz');
      expect(data.notificationPrefs).toEqual({
        lotProgress: true,
        redemptionReminders: false,
      });
      expect(data.promotionsConsentAt).toBeInstanceOf(Date);
      expect(mockAudit.record).toHaveBeenCalledWith(
        mockPrisma.tx,
        expect.objectContaining({ action: 'USER_PROFILE_UPDATED' }),
      );
      expect(me).toHaveProperty('memberships');
    });

    it('updateMe sin cambios no escribe', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(repoUser);
      mockUserRepository.findById.mockResolvedValue(repoUser);
      mockMemberships.listForUser.mockResolvedValue([]);

      await service.updateMe(principal, { promotionsConsent: false });

      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
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
