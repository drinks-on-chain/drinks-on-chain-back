import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TokenExpiredError } from '@nestjs/jwt';
import { PrismaService } from '@shared/prisma/prisma.service';
import type { AuthenticatedUser } from '@shared/decorators/current-user.decorator';
import { AuthorizationGuard } from '../guards/authorization.guard';
import { TenantGuard } from '../guards/tenant.guard';
import { AccessTokenGuard } from '../guards/access-token.guard';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import {
  AUDIENCE_KEY,
  ORG_TYPES_KEY,
  REQUIRE_ACTIVE_ORG_KEY,
  ROLES_KEY,
} from '../decorators/authorization.decorators';
import { SessionSettings } from '../sessions/session.config';
import { AccessTokenService } from '../sessions/access-token.service';
import { SessionRevocationStore } from '../sessions/session-revocation.store';
import { SessionsService } from '../sessions/sessions.service';

const SID = '6f1c2b7e-0d4e-4c1a-9f3b-8a7d6e5c4b3a';
const WINERY_A = '11111111-1111-4111-8111-00000000000a';
const WINERY_B = '11111111-1111-4111-8111-00000000000b';
const PLATFORM = '00000000-0000-4000-8000-000000000001';

const settings = (enforce = false): SessionSettings => ({
  accessTokenTtlSeconds: 900,
  staffSessionTtlSeconds: 7 * 86400,
  consumerSessionTtlSeconds: 30 * 86400,
  refreshGraceSeconds: 20,
  nodeEnv: 'test',
  enforceActiveOrganization: enforce,
});

function principal(overrides: Partial<AuthenticatedUser>): AuthenticatedUser {
  return {
    id: 'user-1',
    userId: 'user-1',
    email: 'x@y.bo',
    sessionId: SID,
    audience: 'STAFF',
    organizationId: WINERY_A,
    organizationType: 'WINERY',
    organizationStatus: 'ACTIVE',
    role: 'OWNER',
    userRole: 'WINERY_ADMIN',
    wineryId: WINERY_A,
    memberRole: 'OWNER',
    ...overrides,
  };
}

/** Reflector con los metadatos de la ruta. */
function reflectorWith(meta: Record<string, unknown>): Reflector {
  const reflector = new Reflector();
  jest
    .spyOn(reflector, 'getAllAndOverride')
    .mockImplementation((key: unknown) => meta[key as string]);
  return reflector;
}

function httpContext(request: Record<string, unknown>): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('AuthorizationGuard (contrato O0 §6)', () => {
  const run = (
    meta: Record<string, unknown>,
    user: AuthenticatedUser,
    method = 'GET',
    enforce = false,
  ) =>
    new AuthorizationGuard(reflectorWith(meta), settings(enforce)).canActivate(
      httpContext({ user, method, url: '/v1/x' }),
    );

  it('las rutas públicas pasan sin persona', () => {
    expect(
      new AuthorizationGuard(
        reflectorWith({ [IS_PUBLIC_KEY]: true }),
        settings(),
      ).canActivate(httpContext({})),
    ).toBe(true);
  });

  it('@Audience', () => {
    expect(run({ [AUDIENCE_KEY]: ['STAFF'] }, principal({}))).toBe(true);
    expect(() =>
      run({ [AUDIENCE_KEY]: ['STAFF'] }, principal({ audience: 'CONSUMER' })),
    ).toThrow(expect.objectContaining({ statusCode: 403 }));
  });

  it('@OrgType + @Roles contra la organización activa', () => {
    const meta = { [ORG_TYPES_KEY]: ['WINERY'], [ROLES_KEY]: ['OWNER'] };
    expect(run(meta, principal({}))).toBe(true);
    expect(() => run(meta, principal({ role: 'ENOLOGIST' }))).toThrow(
      expect.objectContaining({
        statusCode: 403,
        errorCode: 'AUTH_INSUFFICIENT_PERMISSIONS',
      }),
    );
    // Sin organización activa (consumidor)
    expect(() =>
      run(
        meta,
        principal({
          organizationId: null,
          organizationType: null,
          role: null,
          audience: 'CONSUMER',
        }),
      ),
    ).toThrow(expect.objectContaining({ statusCode: 403 }));
  });

  it('plataforma en rutas de bodega: SUPERADMIN/ADMIN/OPERATIONS escriben, SUPPORT solo lee', () => {
    const meta = { [ORG_TYPES_KEY]: ['WINERY'], [ROLES_KEY]: ['OWNER'] };
    const platform = (role: string) =>
      principal({
        organizationId: PLATFORM,
        organizationType: 'PLATFORM',
        role,
      });
    expect(run(meta, platform('SUPERADMIN'), 'POST')).toBe(true);
    expect(run(meta, platform('OPERATIONS'), 'PATCH')).toBe(true);
    expect(run(meta, platform('SUPPORT'), 'GET')).toBe(true);
    expect(() => run(meta, platform('SUPPORT'), 'POST')).toThrow(
      expect.objectContaining({ statusCode: 403 }),
    );
  });

  it('las rutas de plataforma no admiten roles de bodega', () => {
    const meta = {
      [ORG_TYPES_KEY]: ['PLATFORM'],
      [ROLES_KEY]: ['SUPERADMIN', 'ADMIN'],
    };
    expect(() => run(meta, principal({}))).toThrow(
      expect.objectContaining({ statusCode: 403 }),
    );
    expect(
      run(
        meta,
        principal({
          organizationId: PLATFORM,
          organizationType: 'PLATFORM',
          role: 'ADMIN',
        }),
      ),
    ).toBe(true);
  });

  it('SE-05: bodega no ACTIVE → aviso en la Ola 0; 403 ORG_NOT_ACTIVE con la bandera', () => {
    const meta = {
      [ORG_TYPES_KEY]: ['WINERY'],
      [REQUIRE_ACTIVE_ORG_KEY]: true,
    };
    const invited = principal({ organizationStatus: 'INVITED' });
    expect(run(meta, invited)).toBe(true);
    expect(() => run(meta, invited, 'GET', true)).toThrow(
      expect.objectContaining({
        statusCode: 403,
        errorCode: 'ORG_NOT_ACTIVE',
        details: [{ field: null, message: 'INVITED' }],
      }),
    );
  });

  it('SE-05: @RequireActiveOrg({ allow }) admite los estados indicados (bitácora propia en SUSPENDED)', () => {
    const meta = {
      [ORG_TYPES_KEY]: ['WINERY'],
      [REQUIRE_ACTIVE_ORG_KEY]: { allow: ['SUSPENDED'] },
    };
    expect(
      run(meta, principal({ organizationStatus: 'SUSPENDED' }), 'GET', true),
    ).toBe(true);
    expect(() =>
      run(meta, principal({ organizationStatus: 'INVITED' }), 'GET', true),
    ).toThrow(expect.objectContaining({ errorCode: 'ORG_NOT_ACTIVE' }));
  });
});

describe('TenantGuard (bodega de la petición)', () => {
  const prisma = { organization: { findFirst: jest.fn() } };
  const guard = () =>
    new TenantGuard(
      reflectorWith({ [ORG_TYPES_KEY]: ['WINERY'] }),
      prisma as unknown as PrismaService,
    );

  beforeEach(() => jest.clearAllMocks());

  it('bodega activa: su id; otra bodega en la petición → 404', async () => {
    const request: Record<string, unknown> = {
      user: principal({}),
      params: {},
      query: {},
      body: {},
      method: 'GET',
    };
    await expect(guard().canActivate(httpContext(request))).resolves.toBe(true);
    expect(request.tenantId).toBe(WINERY_A);

    await expect(
      guard().canActivate(
        httpContext({ ...request, query: { wineryId: WINERY_B } }),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  const platformRequest = (method: string, query = {}) => ({
    user: principal({
      organizationId: PLATFORM,
      organizationType: 'PLATFORM',
      role: 'ADMIN',
    }),
    params: {},
    query,
    body: {},
    method,
  });

  it('plataforma: las escrituras exigen ?wineryId= (OP-07)', async () => {
    await expect(
      guard().canActivate(httpContext(platformRequest('POST'))),
    ).rejects.toMatchObject({
      statusCode: 422,
      details: [expect.objectContaining({ field: 'wineryId' })],
    });
  });

  it('plataforma: lectura sin bodega = todas; bodega inexistente → 404 ORG_NOT_FOUND', async () => {
    const read: Record<string, unknown> = platformRequest('GET');
    await expect(guard().canActivate(httpContext(read))).resolves.toBe(true);
    expect(read.tenantId).toBeNull();

    prisma.organization.findFirst.mockResolvedValue(null);
    await expect(
      guard().canActivate(
        httpContext(platformRequest('POST', { wineryId: WINERY_B })),
      ),
    ).rejects.toMatchObject({ statusCode: 404, errorCode: 'ORG_NOT_FOUND' });

    prisma.organization.findFirst.mockResolvedValue({ id: WINERY_B });
    const write: Record<string, unknown> = platformRequest('POST', {
      wineryId: WINERY_B,
    });
    await expect(guard().canActivate(httpContext(write))).resolves.toBe(true);
    expect(write.tenantId).toBe(WINERY_B);
  });

  it('las rutas sin @OrgType("WINERY") no se tocan', async () => {
    const other = new TenantGuard(
      reflectorWith({}),
      prisma as unknown as PrismaService,
    );
    const request: Record<string, unknown> = { user: principal({}) };
    await expect(other.canActivate(httpContext(request))).resolves.toBe(true);
    expect(request.tenantId).toBeUndefined();
  });
});

describe('AccessTokenGuard (acceso válido + sesión viva)', () => {
  const accessTokens = { verify: jest.fn() };
  const revocations = {
    isRevoked: jest.fn(),
    markRevoked: jest.fn(),
  };
  const sessions = { revoke: jest.fn() };
  const prisma = { session: { findUnique: jest.fn() } };

  const guard = () =>
    new AccessTokenGuard(
      reflectorWith({}),
      accessTokens as unknown as AccessTokenService,
      revocations as unknown as SessionRevocationStore,
      sessions as unknown as SessionsService,
      prisma as unknown as PrismaService,
    );

  const claims = {
    sub: 'user-1',
    aud: 'STAFF',
    org: WINERY_A,
    orgType: 'WINERY',
    role: 'OWNER',
    sid: SID,
    jti: 'j',
    email: 'x@y.bo',
    userRole: 'WINERY_ADMIN',
    wineryId: WINERY_A,
    memberRole: 'OWNER',
  };

  const liveSession = (
    membership = { status: 'ACTIVE', organization: { status: 'ACTIVE' } },
  ) => ({
    userId: 'user-1',
    revokedAt: null,
    user: { isActive: true, memberships: [membership] },
  });

  const request = (authorization?: string): Record<string, unknown> => ({
    headers: authorization ? { authorization } : {},
  });

  beforeEach(() => {
    jest.clearAllMocks();
    revocations.isRevoked.mockResolvedValue(false);
    accessTokens.verify.mockResolvedValue(claims);
    prisma.session.findUnique.mockResolvedValue(liveSession());
  });

  it('sin token → 401 AUTH_TOKEN_INVALID', async () => {
    await expect(
      guard().canActivate(httpContext(request())),
    ).rejects.toMatchObject({
      statusCode: 401,
      errorCode: 'AUTH_TOKEN_INVALID',
    });
  });

  it('caducado → 401 AUTH_TOKEN_EXPIRED', async () => {
    accessTokens.verify.mockRejectedValue(
      new TokenExpiredError('jwt expired', new Date()),
    );
    await expect(
      guard().canActivate(httpContext(request('Bearer t'))),
    ).rejects.toMatchObject({ errorCode: 'AUTH_TOKEN_EXPIRED' });
  });

  it('acceso de 0.1 sin sid → 401', async () => {
    accessTokens.verify.mockResolvedValue({ sub: 'user-1', email: 'x' });
    await expect(
      guard().canActivate(httpContext(request('Bearer t'))),
    ).rejects.toMatchObject({ errorCode: 'AUTH_TOKEN_INVALID' });
  });

  it('sid en la lista de revocación de Redis → 401 sin tocar la base', async () => {
    revocations.isRevoked.mockResolvedValue(true);
    await expect(
      guard().canActivate(httpContext(request('Bearer t'))),
    ).rejects.toMatchObject({ errorCode: 'AUTH_SESSION_REVOKED' });
    expect(prisma.session.findUnique).not.toHaveBeenCalled();
  });

  it('sin Redis decide la base: sesión revocada → 401 y repone la marca', async () => {
    revocations.isRevoked.mockResolvedValue(null);
    prisma.session.findUnique.mockResolvedValue({
      ...liveSession(),
      revokedAt: new Date(),
    });
    await expect(
      guard().canActivate(httpContext(request('Bearer t'))),
    ).rejects.toMatchObject({ errorCode: 'AUTH_SESSION_REVOKED' });
    expect(revocations.markRevoked).toHaveBeenCalledWith([SID], 'DB');
  });

  it('membresía bloqueada → revoca la sesión en el acto y 401', async () => {
    prisma.session.findUnique.mockResolvedValue(
      liveSession({ status: 'BLOCKED', organization: { status: 'ACTIVE' } }),
    );
    await expect(
      guard().canActivate(httpContext(request('Bearer t'))),
    ).rejects.toMatchObject({ errorCode: 'AUTH_SESSION_REVOKED' });
    expect(sessions.revoke).toHaveBeenCalledWith(SID, 'MEMBERSHIP_BLOCKED');
  });

  it('persona bloqueada → revoca y 401', async () => {
    prisma.session.findUnique.mockResolvedValue({
      ...liveSession(),
      user: { isActive: false, memberships: [] },
    });
    await expect(
      guard().canActivate(httpContext(request('Bearer t'))),
    ).rejects.toMatchObject({ errorCode: 'AUTH_SESSION_REVOKED' });
    expect(sessions.revoke).toHaveBeenCalledWith(SID, 'USER_BLOCKED');
  });

  it('válido: deja la persona con la organización activa en request.user', async () => {
    const req = request('Bearer t');
    await expect(guard().canActivate(httpContext(req))).resolves.toBe(true);
    expect(req.user).toEqual(
      expect.objectContaining({
        id: 'user-1',
        sessionId: SID,
        audience: 'STAFF',
        organizationId: WINERY_A,
        organizationType: 'WINERY',
        organizationStatus: 'ACTIVE',
        role: 'OWNER',
      }),
    );
  });
});
