import { ConfigService } from '@nestjs/config';
import { AudienceEnum, Session } from '@prisma/client';
import { PrismaService } from '@shared/prisma/prisma.service';
import {
  RevocationReason,
  SessionsService,
} from '../sessions/sessions.service';
import { SessionRevocationStore } from '../sessions/session-revocation.store';
import { SessionSettings } from '../sessions/session.config';
import {
  deriveNextSecret,
  formatRefreshToken,
  generateRefreshSecret,
  hashRefreshSecret,
} from '../sessions/refresh-token';

const KEY = 'unit-test-refresh-key-at-least-32-chars';
const SID = '6f1c2b7e-0d4e-4c1a-9f3b-8a7d6e5c4b3a';

const settings: SessionSettings = {
  accessTokenTtlSeconds: 900,
  staffSessionTtlSeconds: 7 * 86400,
  consumerSessionTtlSeconds: 30 * 86400,
  refreshGraceSeconds: 20,
  nodeEnv: 'test',
  enforceActiveOrganization: false,
};

function sessionRow(overrides: Partial<Session> = {}): Session {
  return {
    id: SID,
    userId: 'user-1',
    activeOrganizationId: null,
    audience: AudienceEnum.STAFF,
    refreshTokenHash: '',
    generation: 0,
    rotatedAt: null,
    createdAt: new Date(),
    lastUsedAt: new Date(),
    expiresAt: new Date(Date.now() + 86400_000),
    mfaVerifiedAt: null,
    revokedAt: null,
    revokedReason: null,
    ip: null,
    userAgent: null,
    ...overrides,
  };
}

describe('SessionsService', () => {
  const prisma = {
    session: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
    },
  };
  const revocations = {
    markRevoked: jest.fn().mockResolvedValue(undefined),
  };
  const config = {
    getOrThrow: jest.fn(() => KEY),
  } as unknown as ConfigService;

  let service: SessionsService;

  // Cadena de la sesión: gen0 → gen1 → gen2 (vigente la 2)
  const secrets: string[] = [];

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SessionsService(
      prisma as unknown as PrismaService,
      revocations as unknown as SessionRevocationStore,
      settings,
      config,
    );
    secrets.length = 0;
    secrets.push(generateRefreshSecret());
    secrets.push(deriveNextSecret(KEY, SID, 1, secrets[0]));
    secrets.push(deriveNextSecret(KEY, SID, 2, secrets[1]));
    prisma.session.findMany.mockResolvedValue([{ id: SID }]);
    prisma.session.updateMany.mockResolvedValue({ count: 1 });
  });

  const tokenFor = (generation: number) =>
    formatRefreshToken({
      sessionId: SID,
      generation,
      secret: secrets[generation],
    });

  const rotatedSession = (rotatedAgoMs: number) =>
    sessionRow({
      generation: 2,
      refreshTokenHash: hashRefreshSecret(secrets[2]),
      rotatedAt: new Date(Date.now() - rotatedAgoMs),
    });

  describe('create', () => {
    it('guarda solo el hash del refresco, generación 0 y 7 días para el personal', async () => {
      prisma.session.create.mockImplementation(({ data }) =>
        Promise.resolve(sessionRow({ ...data, id: SID })),
      );

      const { refreshToken } = await service.create({
        userId: 'user-1',
        audience: AudienceEnum.STAFF,
        activeOrganizationId: 'org-1',
        client: { ip: '203.0.113.7', userAgent: 'jest' },
      });

      const data = prisma.session.create.mock.calls[0][0].data;
      const secret = refreshToken.split('.')[2];
      expect(refreshToken.startsWith(`${SID}.0.`)).toBe(true);
      expect(data.refreshTokenHash).toBe(hashRefreshSecret(secret));
      expect(data.refreshTokenHash).not.toContain(secret);
      expect(data.generation).toBe(0);
      const ttl = data.expiresAt.getTime() - data.lastUsedAt.getTime();
      expect(ttl).toBe(7 * 86400_000);
    });

    it('30 días para los consumidores', async () => {
      prisma.session.create.mockImplementation(({ data }) =>
        Promise.resolve(sessionRow({ ...data, id: SID })),
      );
      await service.create({
        userId: 'user-1',
        audience: AudienceEnum.CONSUMER,
        activeOrganizationId: null,
        client: { ip: null, userAgent: null },
      });
      const data = prisma.session.create.mock.calls[0][0].data;
      expect(data.expiresAt.getTime() - data.lastUsedAt.getTime()).toBe(
        30 * 86400_000,
      );
    });
  });

  describe('validateRefresh', () => {
    it('el vigente se rota a la generación siguiente (derivada)', async () => {
      prisma.session.findUnique.mockResolvedValue(rotatedSession(60_000));

      const result = await service.validateRefresh(tokenFor(2));

      expect(result.kind).toBe('current');
      expect(result.nextSecret).toBe(deriveNextSecret(KEY, SID, 3, secrets[2]));
    });

    it('periodo de gracia: el anterior, recién rotado, da el mismo refresco nuevo', async () => {
      prisma.session.findUnique.mockResolvedValue(rotatedSession(5_000));

      const result = await service.validateRefresh(tokenFor(1));

      expect(result.kind).toBe('grace');
      expect(result.nextSecret).toBe(secrets[2]);
      expect(revocations.markRevoked).not.toHaveBeenCalled();
    });

    it('reutilización tras la gracia: revoca la sesión y 401 AUTH_REFRESH_REUSED', async () => {
      prisma.session.findUnique.mockResolvedValue(rotatedSession(21_000));

      await expect(service.validateRefresh(tokenFor(1))).rejects.toMatchObject({
        statusCode: 401,
        errorCode: 'AUTH_REFRESH_REUSED',
      });
      expect(prisma.session.updateMany).toHaveBeenCalledWith({
        where: { id: { in: [SID] }, revokedAt: null },
        data: expect.objectContaining({
          revokedReason: RevocationReason.REFRESH_REUSED,
        }),
      });
      expect(revocations.markRevoked).toHaveBeenCalledWith(
        [SID],
        RevocationReason.REFRESH_REUSED,
      );
    });

    it('un refresco más antiguo es reutilización aunque esté dentro de la gracia', async () => {
      prisma.session.findUnique.mockResolvedValue(rotatedSession(1_000));

      await expect(service.validateRefresh(tokenFor(0))).rejects.toMatchObject({
        errorCode: 'AUTH_REFRESH_REUSED',
      });
    });

    it('un refresco inventado es inválido y no revoca la sesión', async () => {
      prisma.session.findUnique.mockResolvedValue(rotatedSession(60_000));
      const forged = formatRefreshToken({
        sessionId: SID,
        generation: 1,
        secret: generateRefreshSecret(),
      });

      await expect(service.validateRefresh(forged)).rejects.toMatchObject({
        statusCode: 401,
        errorCode: 'AUTH_REFRESH_INVALID',
      });
      expect(prisma.session.updateMany).not.toHaveBeenCalled();
    });

    it('sin refresco o de una sesión inexistente: AUTH_REFRESH_INVALID', async () => {
      await expect(service.validateRefresh(null)).rejects.toMatchObject({
        errorCode: 'AUTH_REFRESH_INVALID',
      });
      prisma.session.findUnique.mockResolvedValue(null);
      await expect(service.validateRefresh(tokenFor(2))).rejects.toMatchObject({
        errorCode: 'AUTH_REFRESH_INVALID',
      });
    });

    it('sesión revocada: AUTH_SESSION_REVOKED; caducada: AUTH_SESSION_EXPIRED', async () => {
      prisma.session.findUnique.mockResolvedValue({
        ...rotatedSession(60_000),
        revokedAt: new Date(),
      });
      await expect(service.validateRefresh(tokenFor(2))).rejects.toMatchObject({
        errorCode: 'AUTH_SESSION_REVOKED',
      });

      prisma.session.findUnique.mockResolvedValue({
        ...rotatedSession(60_000),
        expiresAt: new Date(Date.now() - 1000),
      });
      await expect(service.validateRefresh(tokenFor(2))).rejects.toMatchObject({
        errorCode: 'AUTH_SESSION_EXPIRED',
      });
    });
  });

  describe('rotate', () => {
    it('sube la generación solo si nadie la rotó antes (condición sobre la generación)', async () => {
      const session = rotatedSession(60_000);
      const nextSecret = deriveNextSecret(KEY, SID, 3, secrets[2]);
      prisma.session.findUniqueOrThrow.mockResolvedValue({
        ...session,
        generation: 3,
        refreshTokenHash: hashRefreshSecret(nextSecret),
      });

      const issued = await service.rotate(
        { session, kind: 'current', nextSecret },
        { audience: AudienceEnum.STAFF, activeOrganizationId: 'org-1' },
      );

      expect(prisma.session.updateMany).toHaveBeenCalledWith({
        where: { id: SID, generation: 2, revokedAt: null },
        data: expect.objectContaining({
          generation: 3,
          refreshTokenHash: hashRefreshSecret(nextSecret),
          activeOrganizationId: 'org-1',
        }),
      });
      expect(issued.refreshToken).toBe(`${SID}.3.${nextSecret}`);
    });

    it('dos rotaciones a la vez: la segunda no escribe y entrega el mismo refresco', async () => {
      const session = rotatedSession(60_000);
      const nextSecret = deriveNextSecret(KEY, SID, 3, secrets[2]);
      prisma.session.updateMany.mockResolvedValue({ count: 0 });
      prisma.session.findUniqueOrThrow.mockResolvedValue({
        ...session,
        generation: 3,
        refreshTokenHash: hashRefreshSecret(nextSecret),
      });

      const issued = await service.rotate(
        { session, kind: 'current', nextSecret },
        { audience: AudienceEnum.STAFF, activeOrganizationId: null },
      );

      expect(issued.refreshToken).toBe(`${SID}.3.${nextSecret}`);
    });

    it('en la gracia no escribe nada', async () => {
      const session = rotatedSession(1_000);
      const issued = await service.rotate(
        { session, kind: 'grace', nextSecret: secrets[2] },
        { audience: AudienceEnum.STAFF, activeOrganizationId: null },
      );
      expect(prisma.session.updateMany).not.toHaveBeenCalled();
      expect(issued.refreshToken).toBe(tokenFor(2));
    });
  });

  describe('revocación (IAM-13)', () => {
    it('revokeForOrganization revoca las sesiones de esa organización activa y las anota en Redis', async () => {
      prisma.session.findMany.mockResolvedValue([{ id: 's1' }, { id: 's2' }]);

      const count = await service.revokeForOrganization(
        'org-1',
        RevocationReason.MEMBERSHIP_BLOCKED,
        'user-1',
      );

      expect(count).toBe(2);
      expect(prisma.session.findMany).toHaveBeenCalledWith({
        where: {
          activeOrganizationId: 'org-1',
          userId: 'user-1',
          revokedAt: null,
        },
        select: { id: true },
      });
      expect(revocations.markRevoked).toHaveBeenCalledWith(
        ['s1', 's2'],
        RevocationReason.MEMBERSHIP_BLOCKED,
      );
    });

    it('sin sesiones vivas no escribe nada', async () => {
      prisma.session.findMany.mockResolvedValue([]);
      await expect(
        service.revokeAllForUser('user-1', RevocationReason.USER_BLOCKED),
      ).resolves.toBe(0);
      expect(prisma.session.updateMany).not.toHaveBeenCalled();
      expect(revocations.markRevoked).not.toHaveBeenCalled();
    });

    it('identifyByRefresh reconoce cualquier refresco auténtico sin revocar', async () => {
      prisma.session.findUnique.mockResolvedValue(rotatedSession(60_000));
      await expect(service.identifyByRefresh(tokenFor(0))).resolves.toBe(SID);
      await expect(
        service.identifyByRefresh(
          formatRefreshToken({
            sessionId: SID,
            generation: 2,
            secret: generateRefreshSecret(),
          }),
        ),
      ).resolves.toBeNull();
      expect(prisma.session.updateMany).not.toHaveBeenCalled();
    });
  });
});
