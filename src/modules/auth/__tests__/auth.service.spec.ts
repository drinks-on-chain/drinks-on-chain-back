import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from '../auth.service';
import { PrismaService } from '@shared/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { UserRoleEnum } from '@prisma/client';
import * as bcrypt from 'bcrypt';

import { WalletsService } from '@modules/wallets/wallets.service';

describe('AuthService', () => {
  let service: AuthService;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let walletsService: WalletsService;

  const mockPrisma = {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  };

  const mockWalletsService = {
    provisionUserWallet: jest.fn().mockResolvedValue({
      id: 'wallet-uuid-1',
      stellarPublicAddress: 'GBZXN7PIRZGNMHGA728JHIITLTINIQUVFD2AZN5HQG5Y3SQ4Q',
    }),
  };

  const mockJwtService = {
    signAsync: jest.fn().mockResolvedValue('mocked.jwt.token'),
    verify: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn((key: string) => {
      switch (key) {
        case 'JWT_SECRET':
          return 'mock-secret-key-min-32-chars-long';
        case 'JWT_EXPIRES_IN':
          return '7d';
        case 'JWT_REFRESH_SECRET':
          return 'mock-refresh-secret-key-32-chars';
        case 'JWT_REFRESH_EXPIRES_IN':
          return '30d';
        default:
          return null;
      }
    }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: JwtService, useValue: mockJwtService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: WalletsService, useValue: mockWalletsService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    prisma = module.get<PrismaService>(PrismaService);
    jwtService = module.get<JwtService>(JwtService);
    walletsService = module.get<WalletsService>(WalletsService);

    jest.clearAllMocks();
  });

  describe('signup', () => {
    it('debe registrar un nuevo usuario y retornar perfil + tokens', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.user.create.mockResolvedValue({
        id: 'user-uuid-1',
        email: 'test@winery.bo',
        fullName: 'Test User',
        userRole: UserRoleEnum.CONSUMER,
        phoneNumber: null,
        preferredLocale: 'es',
        isActive: true,
      });

      const result = await service.signup({
        email: 'test@winery.bo',
        password: 'Password123!',
        fullName: 'Test User',
      });

      expect(result.user.email).toBe('test@winery.bo');
      expect(result.tokens.accessToken).toBe('mocked.jwt.token');
      expect(result.tokens.refreshToken).toBe('mocked.jwt.token');
      expect(mockPrisma.user.create).toHaveBeenCalledTimes(1);
    });

    it('debe arrojar ConflictException si el email ya existe', async () => {
      mockPrisma.user.findUnique.mockResolvedValueOnce({ id: 'existing-id' });

      await expect(
        service.signup({
          email: 'existing@winery.bo',
          password: 'Password123!',
          fullName: 'Test User',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('login', () => {
    it('debe autenticar exitosamente con credenciales válidas', async () => {
      const passwordHash = await bcrypt.hash('Password123!', 10);
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-uuid-1',
        email: 'test@winery.bo',
        passwordHash,
        fullName: 'Test User',
        userRole: UserRoleEnum.ENOLOGIST,
        phoneNumber: null,
        preferredLocale: 'es',
        isActive: true,
        wineryMemberships: [
          {
            wineryId: 'winery-uuid-1',
            memberRole: 'ENOLOGIST',
            isActive: true,
          },
        ],
      });
      mockPrisma.user.update.mockResolvedValue({});

      const result = await service.login({
        email: 'test@winery.bo',
        password: 'Password123!',
      });

      expect(result.user.email).toBe('test@winery.bo');
      expect(result.user.wineryId).toBe('winery-uuid-1');
      expect(result.tokens.accessToken).toBe('mocked.jwt.token');
      expect(mockPrisma.user.update).toHaveBeenCalledTimes(1);
    });

    it('debe arrojar UnauthorizedException si el usuario no existe', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.login({
          email: 'unknown@winery.bo',
          password: 'Password123!',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('debe arrojar UnauthorizedException si la contraseña es incorrecta', async () => {
      const passwordHash = await bcrypt.hash('CorrectPassword123!', 10);
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-uuid-1',
        email: 'test@winery.bo',
        passwordHash,
        isActive: true,
        wineryMemberships: [],
      });

      await expect(
        service.login({
          email: 'test@winery.bo',
          password: 'WrongPassword!',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('refreshTokens', () => {
    it('debe renovar tokens con un refreshToken válido', async () => {
      mockJwtService.verify.mockReturnValue({ sub: 'user-uuid-1' });
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-uuid-1',
        email: 'test@winery.bo',
        userRole: UserRoleEnum.CONSUMER,
        isActive: true,
        wineryMemberships: [],
      });

      const result = await service.refreshTokens('valid-refresh-token');

      expect(result.accessToken).toBe('mocked.jwt.token');
      expect(result.refreshToken).toBe('mocked.jwt.token');
    });

    it('debe arrojar UnauthorizedException si el refreshToken es inválido', async () => {
      mockJwtService.verify.mockImplementation(() => {
        throw new Error('jwt expired');
      });

      await expect(service.refreshTokens('expired-token')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });
});
