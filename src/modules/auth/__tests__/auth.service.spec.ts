import { ConflictException, ForbiddenException } from '@nestjs/common';
import { AudienceEnum, UserRoleEnum } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '@shared/prisma/prisma.service';
import { WalletsService } from '@modules/wallets/wallets.service';
import {
  MembershipsService,
  MembershipView,
} from '@modules/organizations/memberships.service';
import type { AuthenticatedUser } from '@shared/decorators/current-user.decorator';
import { AuthService } from '../auth.service';
import { SessionsService } from '../sessions/sessions.service';
import { SessionRevocationStore } from '../sessions/session-revocation.store';
import { AccessTokenService } from '../sessions/access-token.service';
import { LoginAttemptsService } from '../rate-limit/login-attempts.service';

const SID = '6f1c2b7e-0d4e-4c1a-9f3b-8a7d6e5c4b3a';
const WINERY_A = '11111111-1111-4111-8111-00000000000a';
const WINERY_B = '11111111-1111-4111-8111-00000000000b';

const membership = (
  organizationId: string,
  overrides: Partial<MembershipView> = {},
): MembershipView => ({
  id: `m-${organizationId}`,
  organizationId,
  organizationType: 'WINERY',
  organizationName: `Bodega ${organizationId.slice(-1)}`,
  organizationStatus: 'ACTIVE',
  role: 'OWNER',
  status: 'ACTIVE',
  ...overrides,
});

const baseUser = {
  id: 'user-1',
  email: 'duena@bodega.bo',
  fullName: 'Dueña',
  phoneNumber: null,
  preferredLocale: 'es',
  userRole: UserRoleEnum.WINERY_ADMIN,
  isActive: true,
  lastOrganizationId: null as string | null,
  passwordHash: '',
};

describe('AuthService', () => {
  const prisma = {
    user: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
  };
  const sessions = {
    create: jest.fn(),
    validateRefresh: jest.fn(),
    rotate: jest.fn(),
    revoke: jest.fn(),
    revokeAllForUser: jest.fn(),
    identifyByRefresh: jest.fn(),
    setActiveOrganization: jest.fn(),
    ttlSecondsFor: jest.fn((audience: AudienceEnum) =>
      audience === AudienceEnum.CONSUMER ? 30 * 86400 : 7 * 86400,
    ),
  };
  const revocations = {
    readGraceAccess: jest.fn(),
    saveGraceAccess: jest.fn(),
  };
  const accessTokens = {
    sign: jest.fn().mockResolvedValue('signed.access.token'),
    verify: jest.fn(),
    ttlSeconds: 900,
  };
  const memberships = { listForUser: jest.fn(), findForUser: jest.fn() };
  const loginAttempts = {
    lockedFor: jest.fn().mockResolvedValue(0),
    recordFailure: jest.fn().mockResolvedValue(0),
    recordSuccess: jest.fn(),
  };
  const wallets = { provisionUserWallet: jest.fn() };
  const client = { ip: '203.0.113.7', userAgent: 'jest' };

  let service: AuthService;

  beforeAll(async () => {
    baseUser.passwordHash = await bcrypt.hash('Password123!', 4);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AuthService(
      prisma as unknown as PrismaService,
      sessions as unknown as SessionsService,
      revocations as unknown as SessionRevocationStore,
      accessTokens as unknown as AccessTokenService,
      memberships as unknown as MembershipsService,
      loginAttempts as unknown as LoginAttemptsService,
      wallets as unknown as WalletsService,
    );
    loginAttempts.lockedFor.mockResolvedValue(0);
    loginAttempts.recordFailure.mockResolvedValue(0);
    sessions.create.mockResolvedValue({
      session: { id: SID },
      refreshToken: `${SID}.0.secret`,
    });
  });

  describe('login', () => {
    it('abre la sesión con la forma del contrato y la organización por defecto', async () => {
      prisma.user.findUnique.mockResolvedValue(baseUser);
      memberships.listForUser.mockResolvedValue([
        membership(WINERY_A),
        membership(WINERY_B, { role: 'ENOLOGIST' }),
      ]);

      const issued = await service.login(
        { email: ' Duena@Bodega.bo ', password: 'Password123!' },
        client,
      );

      expect(issued.body).toEqual({
        user: {
          id: 'user-1',
          email: 'duena@bodega.bo',
          fullName: 'Dueña',
          phoneNumber: null,
          preferredLocale: 'es',
          audience: 'STAFF',
          userRole: UserRoleEnum.WINERY_ADMIN,
          wineryId: WINERY_A,
          memberRole: 'OWNER',
        },
        memberships: expect.any(Array),
        activeOrganizationId: WINERY_A,
        tokens: {
          accessToken: 'signed.access.token',
          tokenType: 'Bearer',
          expiresIn: 900,
          refreshToken: `${SID}.0.secret`,
        },
      });
      expect(issued.cookieMaxAgeSeconds).toBe(7 * 86400);
      expect(accessTokens.sign).toHaveBeenCalledWith({
        sub: 'user-1',
        aud: 'STAFF',
        org: WINERY_A,
        orgType: 'WINERY',
        role: 'OWNER',
        sid: SID,
        email: 'duena@bodega.bo',
        userRole: UserRoleEnum.WINERY_ADMIN,
        wineryId: WINERY_A,
        memberRole: 'OWNER',
      });
      expect(loginAttempts.recordSuccess).toHaveBeenCalledWith(
        'duena@bodega.bo',
      );
    });

    it('usa la última organización usada si sigue siendo válida', async () => {
      prisma.user.findUnique.mockResolvedValue({
        ...baseUser,
        lastOrganizationId: WINERY_B,
      });
      memberships.listForUser.mockResolvedValue([
        membership(WINERY_A),
        membership(WINERY_B, { role: 'ENOLOGIST' }),
      ]);

      const issued = await service.login(
        { email: baseUser.email, password: 'Password123!' },
        client,
      );

      expect(issued.body.activeOrganizationId).toBe(WINERY_B);
      expect(issued.body.user.memberRole).toBe('ENOLOGIST');
      expect(issued.body.user.userRole).toBe(UserRoleEnum.ENOLOGIST);
    });

    it('consumidor: audiencia CONSUMER, sin organización y 30 días', async () => {
      prisma.user.findUnique.mockResolvedValue({
        ...baseUser,
        userRole: UserRoleEnum.CONSUMER,
      });
      memberships.listForUser.mockResolvedValue([]);

      const issued = await service.login(
        { email: baseUser.email, password: 'Password123!' },
        client,
      );

      expect(issued.body.user.audience).toBe('CONSUMER');
      expect(issued.body.activeOrganizationId).toBeNull();
      expect(issued.cookieMaxAgeSeconds).toBe(30 * 86400);
    });

    it('credenciales inválidas: 401 AUTH_INVALID_CREDENTIALS y cuenta el fallo', async () => {
      prisma.user.findUnique.mockResolvedValue(baseUser);

      await expect(
        service.login({ email: baseUser.email, password: 'Mala-123' }, client),
      ).rejects.toMatchObject({
        statusCode: 401,
        errorCode: 'AUTH_INVALID_CREDENTIALS',
      });
      expect(loginAttempts.recordFailure).toHaveBeenCalledWith(
        baseUser.email,
        client.ip,
      );
      expect(sessions.create).not.toHaveBeenCalled();
    });

    it('correo inexistente: mismo 401 (no revela qué correos existen)', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(
        service.login({ email: 'nadie@x.bo', password: 'x' }, client),
      ).rejects.toMatchObject({ errorCode: 'AUTH_INVALID_CREDENTIALS' });
    });

    it('cuenta bloqueada: mismo 401 aunque la contraseña sea correcta', async () => {
      prisma.user.findUnique.mockResolvedValue({
        ...baseUser,
        isActive: false,
      });
      await expect(
        service.login(
          { email: baseUser.email, password: 'Password123!' },
          client,
        ),
      ).rejects.toMatchObject({ errorCode: 'AUTH_INVALID_CREDENTIALS' });
    });

    it('bloqueo progresivo: 429 AUTH_TOO_MANY_ATTEMPTS sin comprobar la contraseña', async () => {
      loginAttempts.lockedFor.mockResolvedValue(120);

      await expect(
        service.login(
          { email: baseUser.email, password: 'Password123!' },
          client,
        ),
      ).rejects.toMatchObject({
        statusCode: 429,
        errorCode: 'AUTH_TOO_MANY_ATTEMPTS',
        retryAfterSeconds: 120,
      });
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('el fallo que activa el bloqueo ya responde 429', async () => {
      prisma.user.findUnique.mockResolvedValue(baseUser);
      loginAttempts.recordFailure.mockResolvedValue(60);
      await expect(
        service.login({ email: baseUser.email, password: 'Mala-123' }, client),
      ).rejects.toMatchObject({
        statusCode: 429,
        retryAfterSeconds: 60,
      });
    });
  });

  describe('refresh', () => {
    const validated = (overrides: Record<string, unknown> = {}) => ({
      session: {
        id: SID,
        userId: 'user-1',
        activeOrganizationId: WINERY_A,
        generation: 3,
        ...overrides,
      },
      kind: 'current',
      nextSecret: 'next',
    });

    beforeEach(() => {
      prisma.user.findUnique.mockResolvedValue(baseUser);
      memberships.listForUser.mockResolvedValue([membership(WINERY_A)]);
      sessions.rotate.mockResolvedValue({
        session: { id: SID, generation: 4 },
        refreshToken: `${SID}.4.next`,
      });
    });

    it('rota, firma un acceso nuevo y lo guarda para el periodo de gracia', async () => {
      sessions.validateRefresh.mockResolvedValue(validated());

      const issued = await service.refresh('raw');

      expect(sessions.rotate).toHaveBeenCalledWith(validated(), {
        audience: AudienceEnum.STAFF,
        activeOrganizationId: WINERY_A,
      });
      expect(issued.body.tokens.refreshToken).toBe(`${SID}.4.next`);
      expect(revocations.saveGraceAccess).toHaveBeenCalledWith(
        SID,
        4,
        'signed.access.token',
      );
    });

    it('en la gracia devuelve el mismo acceso nuevo', async () => {
      sessions.validateRefresh.mockResolvedValue({
        ...validated(),
        kind: 'grace',
      });
      revocations.readGraceAccess.mockResolvedValue('cached.access.token');

      const issued = await service.refresh('raw');

      expect(issued.body.tokens.accessToken).toBe('cached.access.token');
      expect(accessTokens.sign).not.toHaveBeenCalled();
    });

    it('membresía activa bloqueada: revoca la sesión y 401 AUTH_SESSION_REVOKED', async () => {
      sessions.validateRefresh.mockResolvedValue(validated());
      memberships.listForUser.mockResolvedValue([
        membership(WINERY_A, { status: 'BLOCKED' }),
      ]);

      await expect(service.refresh('raw')).rejects.toMatchObject({
        statusCode: 401,
        errorCode: 'AUTH_SESSION_REVOKED',
      });
      expect(sessions.revoke).toHaveBeenCalledWith(SID, 'MEMBERSHIP_BLOCKED');
      expect(sessions.rotate).not.toHaveBeenCalled();
    });

    it('persona bloqueada: revoca y 401 AUTH_SESSION_REVOKED', async () => {
      sessions.validateRefresh.mockResolvedValue(validated());
      prisma.user.findUnique.mockResolvedValue({
        ...baseUser,
        isActive: false,
      });

      await expect(service.refresh('raw')).rejects.toMatchObject({
        errorCode: 'AUTH_SESSION_REVOKED',
      });
      expect(sessions.revoke).toHaveBeenCalledWith(SID, 'USER_BLOCKED');
    });

    it('sin organización activa (acaba de registrar su bodega) toma la de por defecto', async () => {
      sessions.validateRefresh.mockResolvedValue(
        validated({ activeOrganizationId: null }),
      );

      const issued = await service.refresh('raw');

      expect(issued.body.activeOrganizationId).toBe(WINERY_A);
    });
  });

  describe('switchOrganization', () => {
    const principal = {
      id: 'user-1',
      sessionId: SID,
    } as AuthenticatedUser;
    const refresh = `${SID}.3.${'s'.repeat(43)}`;

    it('sin membresía → 404 ORG_NOT_FOUND', async () => {
      memberships.findForUser.mockResolvedValue(null);
      await expect(
        service.switchOrganization(principal, WINERY_B, refresh),
      ).rejects.toMatchObject({ statusCode: 404, errorCode: 'ORG_NOT_FOUND' });
    });

    it('membresía bloqueada u organización revocada → 403', async () => {
      memberships.findForUser.mockResolvedValue(
        membership(WINERY_B, { status: 'BLOCKED' }),
      );
      await expect(
        service.switchOrganization(principal, WINERY_B, refresh),
      ).rejects.toMatchObject({
        statusCode: 403,
        errorCode: 'ORG_MEMBERSHIP_BLOCKED',
      });

      memberships.findForUser.mockResolvedValue(
        membership(WINERY_B, { organizationStatus: 'REVOKED' }),
      );
      await expect(
        service.switchOrganization(principal, WINERY_B, refresh),
      ).rejects.toMatchObject({ statusCode: 403, errorCode: 'ORG_REVOKED' });
    });

    it('exige el refresco de la misma sesión', async () => {
      memberships.findForUser.mockResolvedValue(membership(WINERY_B));
      await expect(
        service.switchOrganization(principal, WINERY_B, null),
      ).rejects.toMatchObject({
        statusCode: 401,
        errorCode: 'AUTH_REFRESH_INVALID',
      });
      await expect(
        service.switchOrganization(
          principal,
          WINERY_B,
          `00000000-0000-4000-8000-000000000009.3.${'s'.repeat(43)}`,
        ),
      ).rejects.toMatchObject({ errorCode: 'AUTH_REFRESH_INVALID' });
    });

    it('misma sid, nueva organización activa y la recuerda', async () => {
      memberships.findForUser.mockResolvedValue(membership(WINERY_B));
      sessions.validateRefresh.mockResolvedValue({
        session: {
          id: SID,
          userId: 'user-1',
          activeOrganizationId: WINERY_A,
          generation: 3,
        },
        kind: 'current',
        nextSecret: 'next',
      });
      prisma.user.findUnique.mockResolvedValue(baseUser);
      memberships.listForUser.mockResolvedValue([
        membership(WINERY_A),
        membership(WINERY_B, { role: 'ENOLOGIST' }),
      ]);
      sessions.rotate.mockResolvedValue({
        session: { id: SID, generation: 4 },
        refreshToken: `${SID}.4.next`,
      });

      const issued = await service.switchOrganization(
        principal,
        WINERY_B,
        refresh,
      );

      expect(issued.body.activeOrganizationId).toBe(WINERY_B);
      expect(accessTokens.sign).toHaveBeenCalledWith(
        expect.objectContaining({ sid: SID, org: WINERY_B, role: 'ENOLOGIST' }),
      );
      expect(sessions.setActiveOrganization).toHaveBeenCalledWith(
        SID,
        WINERY_B,
      );
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { lastOrganizationId: WINERY_B },
      });
    });
  });

  describe('logout', () => {
    it('identifica la sesión por el acceso aunque haya caducado', async () => {
      accessTokens.verify.mockResolvedValue({ sid: SID });
      await service.logout('access', null);
      expect(accessTokens.verify).toHaveBeenCalledWith('access', {
        ignoreExpiration: true,
      });
      expect(sessions.revoke).toHaveBeenCalledWith(SID, 'LOGOUT');
    });

    it('si no hay acceso válido, usa el refresco; sin nada no revoca', async () => {
      accessTokens.verify.mockRejectedValue(new Error('firma'));
      sessions.identifyByRefresh.mockResolvedValueOnce(SID);
      await service.logout('basura', 'raw');
      expect(sessions.revoke).toHaveBeenCalledWith(SID, 'LOGOUT');

      jest.clearAllMocks();
      sessions.identifyByRefresh.mockResolvedValueOnce(null);
      await service.logout(null, null);
      expect(sessions.revoke).not.toHaveBeenCalled();
    });
  });

  describe('signup', () => {
    it('registra y abre una sesión de consumidor', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({
        ...baseUser,
        userRole: UserRoleEnum.CONSUMER,
      });

      const issued = await service.signup(
        {
          email: 'Nuevo@X.bo',
          password: 'Password123!',
          fullName: 'Nuevo',
        },
        client,
      );

      expect(issued.body.user.audience).toBe('CONSUMER');
      expect(issued.body.memberships).toEqual([]);
      expect(wallets.provisionUserWallet).toHaveBeenCalled();
    });

    it('rechaza correos repetidos y roles no públicos', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'x' });
      await expect(
        service.signup(
          { email: 'a@x.bo', password: 'Password123!', fullName: 'A' },
          client,
        ),
      ).rejects.toThrow(ConflictException);

      prisma.user.findUnique.mockResolvedValue(null);
      await expect(
        service.signup(
          {
            email: 'a@x.bo',
            password: 'Password123!',
            fullName: 'A',
            userRole: UserRoleEnum.PLATFORM_ADMIN,
          },
          client,
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
