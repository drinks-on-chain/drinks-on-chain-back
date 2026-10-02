import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { configureApp } from '../src/app.setup';
import {
  createPlatformUser,
  deleteIdentityData,
  loginWithMfa,
} from './helpers/identity';
import { wineryWithOwner } from './helpers/staff-session';
import { resetLoopbackLoginLocks } from './helpers/login-locks';

type Res = request.Response;

function cookieOf(res: Res): string {
  const header = res.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = (header ?? []).find((c) => c.startsWith('doc_rt='));
  if (!cookie) throw new Error(`Sin Set-Cookie doc_rt (status ${res.status})`);
  return cookie.split(';')[0];
}

/**
 * Cuenta, sesión y equipo tras la retirada de H1 (contrato O1 §11, O0 §5):
 * consumidor por `signup`, dueña y equipo por invitación, refresco solo en la
 * cookie, sin `userRole`/`wineryId`/`memberRole` y sin las rutas de 0.1.
 */
describe('Cuenta, sesión y equipo tras H1 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let consumerToken: string;
  let consumerCookie: string;
  let ownerToken: string;
  let platformAdminToken: string;
  let enologistUserId: string;
  let enologistToken: string;
  let wineryId: string;

  const timestamp = Date.now();
  const consumerEmail = `consumer_${timestamp}@test.bo`;
  const ownerEmail = `winery_admin_${timestamp}@kohlberg.bo`;
  const platformAdminEmail = `platform_admin_${timestamp}@doc.bo`;
  const enologistEmail = `enologist_${timestamp}@kohlberg.bo`;
  const PASSWORD = 'Password123!';
  const STRONG_PASSWORD = 'Vendimia-Tarija-2026';

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    await resetLoopbackLoginLocks(app);
    prisma = app.get<PrismaService>(PrismaService);

    const owned = await wineryWithOwner(app, {
      name: `Bodega Kohlberg ${timestamp}`,
      taxId: `NIT-${timestamp.toString().slice(-8)}`,
      email: ownerEmail,
      password: PASSWORD,
    });
    wineryId = owned.wineryId;

    await createPlatformUser(prisma, {
      email: platformAdminEmail,
      password: PASSWORD,
      fullName: 'Admin Plataforma DoC',
    });
    platformAdminToken = (
      await loginWithMfa(http, prisma, {
        email: platformAdminEmail,
        password: PASSWORD,
      })
    ).body.data.tokens.accessToken;
  });

  afterAll(async () => {
    if (prisma) {
      const mails = await prisma.emailMessage.findMany({
        where: { toAddress: { contains: `${timestamp}` } },
        select: { id: true },
      });
      await prisma.outboxEvent.deleteMany({
        where: { aggregateId: { in: mails.map((m) => m.id) } },
      });
      await prisma.emailMessage.deleteMany({
        where: { id: { in: mails.map((m) => m.id) } },
      });
      await deleteIdentityData(prisma, {
        emailContains: `${timestamp}`,
        wineryIds: [wineryId],
      });
      await prisma.userWallet.deleteMany({
        where: { user: { email: { contains: `${timestamp}` } } },
      });
      await prisma.wineryMember.deleteMany({ where: { wineryId } });
      await prisma.winery.deleteMany({ where: { id: wineryId } });
      await prisma.user.deleteMany({
        where: { email: { contains: `${timestamp}` } },
      });
      await prisma.$disconnect();
    }
    await app?.close();
  });

  it('1. signup crea un consumidor con billetera; el refresco solo va en la cookie', async () => {
    const response = await http()
      .post('/v1/auth/signup')
      .send({
        email: consumerEmail,
        password: PASSWORD,
        fullName: 'Consumidor',
      })
      .expect(201);

    const { user, memberships, activeOrganizationId, tokens } =
      response.body.data;
    expect(user.email).toBe(consumerEmail);
    expect(user.audience).toBe('CONSUMER');
    expect(memberships).toEqual([]);
    expect(activeOrganizationId).toBeNull();
    // Retirados en H1
    expect(Object.keys(user)).toEqual(
      expect.not.arrayContaining(['userRole', 'wineryId', 'memberRole']),
    );
    expect(Object.keys(tokens).sort()).toEqual([
      'accessToken',
      'expiresIn',
      'tokenType',
    ]);
    expect(tokens.expiresIn).toBe(900);
    consumerToken = tokens.accessToken;
    consumerCookie = cookieOf(response);

    // Claims del acceso: sin los de compatibilidad
    const claims = JSON.parse(
      Buffer.from(consumerToken.split('.')[1], 'base64url').toString(),
    ) as Record<string, unknown>;
    expect(Object.keys(claims)).toEqual(
      expect.not.arrayContaining([
        'email',
        'userRole',
        'wineryId',
        'memberRole',
      ]),
    );
    expect(claims).toMatchObject({ sub: user.id, aud: 'CONSUMER', org: null });
  });

  it('2. signup ya no registra personal: userRole → 422', async () => {
    for (const userRole of ['WINERY_ADMIN', 'PLATFORM_ADMIN', 'CONSUMER']) {
      const res = await http()
        .post('/v1/auth/signup')
        .send({
          email: `rol_${userRole}_${timestamp}@test.bo`,
          password: PASSWORD,
          fullName: 'Con rol',
          userRole,
        })
        .expect(422);
      expect(res.body.error.details).toEqual([
        expect.objectContaining({ field: 'userRole' }),
      ]);
    }
  });

  it('3. GET y PATCH /v1/users/me sin userRole', async () => {
    const me = await http()
      .get('/v1/users/me')
      .set(auth(consumerToken))
      .expect(200);
    expect(me.body.data.user.email).toBe(consumerEmail);
    expect(me.body.data.user.audience).toBe('CONSUMER');
    expect(me.body.data.user).not.toHaveProperty('userRole');
    expect(me.body.data.user.primaryWallet.stellarPublicAddress).toMatch(
      /^G[A-Z0-9]{55}$/,
    );

    const patched = await http()
      .patch('/v1/users/me')
      .set(auth(consumerToken))
      .send({ fullName: 'Consumidor Modificado', preferredLocale: 'en' })
      .expect(200);
    expect(patched.body.data.user.fullName).toBe('Consumidor Modificado');
    expect(patched.body.data.user.preferredLocale).toBe('en');
    expect(patched.body.data.memberships).toEqual([]);
  });

  it('4. refresh: con la cookie rota; el refresco en el cuerpo ya no se lee', async () => {
    const refreshed = await http()
      .post('/v1/auth/refresh')
      .set('Cookie', consumerCookie)
      .expect(200);
    expect(refreshed.body.data.user.email).toBe(consumerEmail);
    expect(refreshed.body.data.tokens).not.toHaveProperty('refreshToken');
    const rotated = cookieOf(refreshed);
    expect(rotated).not.toBe(consumerCookie);

    const bodyOnly = await http()
      .post('/v1/auth/refresh')
      .send({ refreshToken: rotated.slice('doc_rt='.length) })
      .expect(401);
    expect(bodyOnly.body.error.code).toBe('AUTH_REFRESH_INVALID');
    consumerCookie = rotated;
  });

  it('5. la dueña invita a una enóloga, que acepta con cuenta nueva', async () => {
    const login = await http()
      .post('/v1/auth/login')
      .send({ email: ownerEmail, password: PASSWORD })
      .expect(200);
    ownerToken = login.body.data.tokens.accessToken;
    expect(login.body.data.activeOrganizationId).toBe(wineryId);
    expect(login.body.data.memberships).toEqual([
      expect.objectContaining({ organizationId: wineryId, role: 'OWNER' }),
    ]);

    await http()
      .post('/v1/organizations/current/invitations')
      .set(auth(ownerToken))
      .send({ email: enologistEmail, role: 'ENOLOGIST' })
      .expect(201);
    const mail = await prisma.emailMessage.findFirstOrThrow({
      where: { toAddress: enologistEmail, template: 'invitacion' },
      orderBy: { createdAt: 'desc' },
    });
    const link = (mail.variables as { enlace: string }).enlace;
    const token = decodeURIComponent(
      /invitacion\/([A-Za-z0-9_-]+)/.exec(link)![1],
    );

    const accepted = await http()
      .post(`/v1/invitations/${token}/accept`)
      .send({ fullName: 'Valeria Soliz', password: STRONG_PASSWORD })
      .expect(200);
    expect(accepted.body.data.activeOrganizationId).toBe(wineryId);
    expect(accepted.body.data.tokens).not.toHaveProperty('refreshToken');
    enologistUserId = accepted.body.data.user.id;
    enologistToken = accepted.body.data.tokens.accessToken;
  });

  it('6. la enóloga lee su bodega y el equipo paginado', async () => {
    const winery = await http()
      .get('/v1/wineries/my')
      .set(auth(enologistToken))
      .expect(200);
    expect(winery.body.data.id).toBe(wineryId);

    const first = await http()
      .get('/v1/organizations/current/members?limit=1')
      .set(auth(ownerToken))
      .expect(200);
    expect(first.body.data).toMatchObject({ total: 2, limit: 1, offset: 0 });
    expect(first.body.data.items).toHaveLength(1);

    const all = await http()
      .get('/v1/organizations/current/members')
      .set(auth(ownerToken))
      .expect(200);
    expect(all.body.data.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: enologistUserId, role: 'ENOLOGIST' }),
        expect.objectContaining({ role: 'OWNER' }),
      ]),
    );
  });

  it('7. las rutas de 0.1 retiradas en H1 ya no existen (404)', async () => {
    const retired: Array<[string, string, string]> = [
      ['post', '/v1/wineries', ownerToken],
      ['get', '/v1/wineries/pending', platformAdminToken],
      ['post', `/v1/wineries/${wineryId}/approve`, platformAdminToken],
      ['post', `/v1/wineries/${wineryId}/reject`, platformAdminToken],
      ['get', '/v1/wineries/my/members', ownerToken],
      ['post', '/v1/wineries/my/members', ownerToken],
      ['post', '/v1/wineries/my/members/create', ownerToken],
    ];
    for (const [method, path, token] of retired) {
      const res = await (
        http() as unknown as Record<string, (url: string) => request.Test>
      )
        [method](path)
        .set(auth(token))
        .send({});
      expect({ method, path, status: res.status }).toEqual({
        method,
        path,
        status: 404,
      });
    }
  });

  it('8. el directorio de plataforma sigue disponible', async () => {
    const res = await http()
      .get('/v1/wineries?status=ACTIVE&limit=100')
      .set(auth(platformAdminToken))
      .expect(200);
    expect(res.body.data.items.map((w: { id: string }) => w.id)).toContain(
      wineryId,
    );
  });
});
