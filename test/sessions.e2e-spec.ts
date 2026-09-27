import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { randomInt } from 'crypto';
import { MembershipBlockedByEnum, UserRoleEnum } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { configureApp } from '../src/app.setup';
import { MembershipsService } from '../src/modules/organizations/memberships.service';
import { PLATFORM_ORGANIZATION_ID } from '../src/modules/organizations/organization.constants';
import {
  createPlatformUser,
  deleteIdentityData,
  loginWithMfa,
} from './helpers/identity';

/**
 * Sesiones seguras y organizaciones con membresías (O0-BE-4; contrato O0
 * §4–§6): cookie doc_rt, rotación con periodo de gracia y detección de
 * reutilización, cambio de organización activa, revocación inmediata, SE-01 y
 * límite de peticiones por IP real (X-Forwarded-For detrás de un proxy).
 */

// Antes de crear la app: una capa de proxy (nginx) y gracia corta para la prueba
process.env.TRUST_PROXY = '1';
process.env.REFRESH_GRACE_SECONDS = '5';

const PASSWORD = 'Password123!';

type Res = request.Response;

/** IP de prueba única por ejecución (los contadores de Redis duran 1 h). */
const ipBase = `10.${randomInt(1, 250)}.${randomInt(1, 250)}`;
let ipSeq = 1;
const nextIp = () => `${ipBase}.${ipSeq++}`;

function refreshCookie(res: Res): string {
  const header = res.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = (header ?? []).find((c) => c.startsWith('doc_rt='));
  if (!cookie) {
    throw new Error(`Sin Set-Cookie doc_rt (status ${res.status})`);
  }
  return cookie;
}

function refreshValue(res: Res): string {
  return refreshCookie(res).split(';')[0].slice('doc_rt='.length);
}

function claimsOf(accessToken: string): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8'),
  );
}

describe('Sesiones y membresías · O0-BE-4 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let memberships: MembershipsService;

  const run = `${Date.now()}`;
  const email = (name: string) => `ses_${name}_${run}@test.bo`;
  const wineryIds: string[] = [];

  // Personas
  let adminIp: string;
  let adminToken: string;
  let aliceIp: string; // dueña de la bodega A
  let aliceToken: string;
  let bobIp: string; // dueño de la bodega B
  let bobToken: string;
  let bobId: string;
  let paulaId: string; // en las dos bodegas
  let superadminId: string;
  let wineryA: string;
  let wineryB: string;
  let terroirA: string;
  let terroirB: string;

  const http = () => request(app.getHttpServer());

  function login(who: string, ip: string, password = PASSWORD) {
    return http()
      .post('/v1/auth/login')
      .set('X-Forwarded-For', ip)
      .send({ email: who, password });
  }

  /** Personal de plataforma: login + segundo factor (PLT-05). */
  async function staffLogin(who: string, ip: string) {
    const res = await loginWithMfa(
      http,
      prisma,
      { email: who, password: PASSWORD },
      { ip },
    );
    expect(res.status).toBe(200);
    return res;
  }

  async function signupOwnerWithWinery(name: string, ip: string) {
    const signup = await http()
      .post('/v1/auth/signup')
      .set('X-Forwarded-For', ip)
      .send({
        email: email(name),
        password: PASSWORD,
        fullName: `Dueño ${name}`,
        userRole: UserRoleEnum.WINERY_ADMIN,
      })
      .expect(201);
    const winery = await http()
      .post('/v1/wineries')
      .set('X-Forwarded-For', ip)
      .set('Authorization', `Bearer ${signup.body.data.tokens.accessToken}`)
      .send({
        legalName: `Bodega ${name} ${run} S.A.`,
        commercialName: `Bodega ${name} ${run}`,
        beverageCategory: 'WINERY',
        taxIdNit: `SES${name.toUpperCase()}${run.slice(-8)}`.slice(0, 20),
        geographicRegion: 'Tarija',
        contactEmail: email(name),
      })
      .expect(201);
    wineryIds.push(winery.body.data.id);
    await http()
      .post(`/v1/wineries/${winery.body.data.id}/approve`)
      .set('X-Forwarded-For', adminIp)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(200);
    const logged = await login(email(name), ip).expect(200);
    return {
      userId: signup.body.data.user.id as string,
      wineryId: winery.body.data.id as string,
      token: logged.body.data.tokens.accessToken as string,
    };
  }

  async function createTerroir(token: string, ip: string, name: string) {
    const res = await http()
      .post('/v1/terroirs')
      .set('X-Forwarded-For', ip)
      .set('Authorization', `Bearer ${token}`)
      .send({
        parcelName: `${name} ${run}`,
        surfaceHectares: 1.5,
        altitudeMasl: 1850,
        rawMaterialType: 'Uva',
        varietyName: 'Tannat',
      })
      .expect(201);
    return res.body.data.id as string;
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    memberships = app.get(MembershipsService);

    adminIp = nextIp();
    const superadmin = await createPlatformUser(prisma, {
      email: email('admin'),
      password: PASSWORD,
    });
    superadminId = superadmin.id;
    adminToken = (await staffLogin(email('admin'), adminIp)).body.data.tokens
      .accessToken;

    aliceIp = nextIp();
    const alice = await signupOwnerWithWinery('alice', aliceIp);
    aliceToken = alice.token;
    wineryA = alice.wineryId;

    bobIp = nextIp();
    const bob = await signupOwnerWithWinery('bob', bobIp);
    bobToken = bob.token;
    bobId = bob.userId;
    wineryB = bob.wineryId;

    terroirA = await createTerroir(aliceToken, aliceIp, 'Parcela A');
    terroirB = await createTerroir(bobToken, bobIp, 'Parcela B');

    // Paula: agrónoma en A y en B (primero A)
    const paula = await http()
      .post('/v1/auth/signup')
      .set('X-Forwarded-For', nextIp())
      .send({ email: email('paula'), password: PASSWORD, fullName: 'Paula' })
      .expect(201);
    paulaId = paula.body.data.user.id;
    await http()
      .post('/v1/wineries/my/members')
      .set('X-Forwarded-For', aliceIp)
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ userId: paulaId, memberRole: 'AGRONOMIST' })
      .expect(201);
    await http()
      .post('/v1/wineries/my/members')
      .set('X-Forwarded-For', bobIp)
      .set('Authorization', `Bearer ${bobToken}`)
      .send({ userId: paulaId, memberRole: 'AGRONOMIST' })
      .expect(201);
  });

  afterAll(async () => {
    if (prisma) {
      await deleteIdentityData(prisma, { emailContains: run, wineryIds });
      await prisma.terroir.deleteMany({
        where: { wineryId: { in: wineryIds } },
      });
      await prisma.wineryMember.deleteMany({
        where: { wineryId: { in: wineryIds } },
      });
      await prisma.userWallet.deleteMany({
        where: {
          OR: [
            { wineryId: { in: wineryIds } },
            { user: { email: { contains: run } } },
          ],
        },
      });
      await prisma.winery.deleteMany({ where: { id: { in: wineryIds } } });
      await prisma.user.deleteMany({ where: { email: { contains: run } } });
    }
    await app?.close();
  });

  describe('login y cookie doc_rt (contrato O0 §5)', () => {
    it('responde la forma nueva, acceso de 15 min con sus claims y Set-Cookie doc_rt', async () => {
      const res = await login(email('paula'), nextIp()).expect(200);
      const { data } = res.body;

      expect(data.user).toMatchObject({
        id: paulaId,
        email: email('paula'),
        audience: 'STAFF',
        // compatibilidad hasta H1: reflejan la organización activa
        wineryId: wineryA,
        memberRole: 'AGRONOMIST',
        userRole: 'AGRONOMIST',
      });
      expect(data.memberships).toHaveLength(2);
      expect(data.memberships).toEqual(
        expect.arrayContaining([
          {
            id: expect.any(String),
            organizationId: wineryA,
            organizationType: 'WINERY',
            organizationName: `Bodega alice ${run}`,
            organizationStatus: 'ACTIVE',
            role: 'AGRONOMIST',
            status: 'ACTIVE',
          },
        ]),
      );
      expect(data.activeOrganizationId).toBe(wineryA);
      expect(data.tokens).toMatchObject({
        tokenType: 'Bearer',
        expiresIn: 900,
      });

      const claims = claimsOf(data.tokens.accessToken);
      expect(claims).toMatchObject({
        sub: paulaId,
        aud: 'STAFF',
        org: wineryA,
        orgType: 'WINERY',
        role: 'AGRONOMIST',
        sid: expect.any(String),
        jti: expect.any(String),
        email: email('paula'),
        wineryId: wineryA,
        memberRole: 'AGRONOMIST',
      });
      expect(Number(claims.exp) - Number(claims.iat)).toBe(900);

      const cookie = refreshCookie(res);
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/Secure/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
      expect(cookie).toMatch(/Path=\//);
      expect(cookie).toMatch(/Max-Age=604800/); // 7 días (personal)
      // El refresco del cuerpo (compatibilidad) es el mismo que el de la cookie
      expect(data.tokens.refreshToken).toBe(refreshValue(res));
    });

    it('los accesos de 0.1 (sin sesión) ya no valen', async () => {
      const res = await http()
        .get('/v1/users/me')
        .set('Authorization', 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.x')
        .expect(401);
      expect(res.body.error.code).toBe('AUTH_TOKEN_INVALID');
    });
  });

  describe('renovación rotativa', () => {
    it('refresh por cookie rota el refresco dentro de la misma sesión', async () => {
      const ip = nextIp();
      const logged = await login(email('paula'), ip).expect(200);
      const first = refreshValue(logged);

      const res = await http()
        .post('/v1/auth/refresh')
        .set('X-Forwarded-For', ip)
        .set('Cookie', `doc_rt=${first}`)
        .expect(200);

      const second = refreshValue(res);
      expect(second).not.toBe(first);
      expect(res.body.data.tokens.refreshToken).toBe(second);
      expect(res.body.data.activeOrganizationId).toBe(wineryA);
      expect(claimsOf(res.body.data.tokens.accessToken).sid).toBe(
        claimsOf(logged.body.data.tokens.accessToken).sid,
      );
    });

    it('dos renovaciones a la vez dentro de la gracia → ambas 200 con el mismo refresco nuevo', async () => {
      const ip = nextIp();
      const logged = await login(email('paula'), ip).expect(200);
      const cookie = `doc_rt=${refreshValue(logged)}`;

      const [a, b] = await Promise.all([
        http()
          .post('/v1/auth/refresh')
          .set('X-Forwarded-For', ip)
          .set('Cookie', cookie),
        http()
          .post('/v1/auth/refresh')
          .set('X-Forwarded-For', ip)
          .set('Cookie', cookie),
      ]);

      expect([a.status, b.status]).toEqual([200, 200]);
      expect(refreshValue(a)).toBe(refreshValue(b));

      // La sesión sigue viva con el refresco nuevo
      await http()
        .post('/v1/auth/refresh')
        .set('X-Forwarded-For', ip)
        .set('Cookie', `doc_rt=${refreshValue(a)}`)
        .expect(200);
    });

    it('reutilización pasada la gracia → 401 AUTH_REFRESH_REUSED y la familia queda revocada', async () => {
      const ip = nextIp();
      const logged = await login(email('paula'), ip).expect(200);
      const old = refreshValue(logged);
      const accessToken = logged.body.data.tokens.accessToken;

      const rotated = await http()
        .post('/v1/auth/refresh')
        .set('X-Forwarded-For', ip)
        .set('Cookie', `doc_rt=${old}`)
        .expect(200);

      await new Promise((resolve) => setTimeout(resolve, 5500)); // gracia: 5 s

      const reused = await http()
        .post('/v1/auth/refresh')
        .set('X-Forwarded-For', ip)
        .set('Cookie', `doc_rt=${old}`)
        .expect(401);
      expect(reused.body.error.code).toBe('AUTH_REFRESH_REUSED');

      // El refresco vigente tampoco vale ya: se revocó toda la sesión
      const current = await http()
        .post('/v1/auth/refresh')
        .set('X-Forwarded-For', ip)
        .set('Cookie', `doc_rt=${refreshValue(rotated)}`)
        .expect(401);
      expect(current.body.error.code).toBe('AUTH_SESSION_REVOKED');

      // …y el acceso de esa sesión deja de valer al instante
      const me = await http()
        .get('/v1/users/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(401);
      expect(me.body.error.code).toBe('AUTH_SESSION_REVOKED');
    });

    it('un refresco inventado no revoca nada (401 AUTH_REFRESH_INVALID)', async () => {
      const ip = nextIp();
      const logged = await login(email('paula'), ip).expect(200);
      const [sid, gen] = refreshValue(logged).split('.');

      const forged = await http()
        .post('/v1/auth/refresh')
        .set('X-Forwarded-For', ip)
        .set('Cookie', `doc_rt=${sid}.${gen}.${'A'.repeat(43)}`)
        .expect(401);
      expect(forged.body.error.code).toBe('AUTH_REFRESH_INVALID');

      await http()
        .get('/v1/users/me')
        .set('Authorization', `Bearer ${logged.body.data.tokens.accessToken}`)
        .expect(200);
    });
  });

  describe('organización activa (IAM-08, EQP-09)', () => {
    it('una persona en dos bodegas ve los datos de la activa y 404 en la otra; al cambiar, al revés', async () => {
      const ip = nextIp();
      const logged = await login(email('paula'), ip).expect(200);
      const tokenA = logged.body.data.tokens.accessToken;
      const sid = claimsOf(tokenA).sid;

      // En A
      await http()
        .get(`/v1/terroirs/${terroirA}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);
      await http()
        .get(`/v1/terroirs/${terroirB}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(404);
      await http()
        .get(`/v1/terroirs?wineryId=${wineryB}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(404);

      // Cambia a B: misma sesión, organización nueva, refresco rotado
      const switched = await http()
        .post('/v1/auth/switch-organization')
        .set('X-Forwarded-For', ip)
        .set('Authorization', `Bearer ${tokenA}`)
        .set('Cookie', `doc_rt=${refreshValue(logged)}`)
        .send({ organizationId: wineryB })
        .expect(200);
      const tokenB = switched.body.data.tokens.accessToken;
      expect(switched.body.data.activeOrganizationId).toBe(wineryB);
      expect(switched.body.data.user.wineryId).toBe(wineryB);
      expect(claimsOf(tokenB)).toMatchObject({ sid, org: wineryB });
      expect(refreshValue(switched)).not.toBe(refreshValue(logged));

      await http()
        .get(`/v1/terroirs/${terroirB}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(200);
      await http()
        .get(`/v1/terroirs/${terroirA}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(404);
      const list = await http()
        .get('/v1/terroirs')
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(200);
      expect(list.body.data.items.map((t: { id: string }) => t.id)).toEqual([
        terroirB,
      ]);

      const me = await http()
        .get('/v1/users/me')
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(200);
      expect(me.body.data.activeOrganizationId).toBe(wineryB);
      expect(me.body.data.user.audience).toBe('STAFF');
      expect(me.body.data.memberships).toHaveLength(2);

      // La renovación conserva la organización activa de la sesión
      const renewed = await http()
        .post('/v1/auth/refresh')
        .set('X-Forwarded-For', ip)
        .set('Cookie', `doc_rt=${refreshValue(switched)}`)
        .expect(200);
      expect(renewed.body.data.activeOrganizationId).toBe(wineryB);

      // Y el siguiente login empieza en la última usada
      const again = await login(email('paula'), nextIp()).expect(200);
      expect(again.body.data.activeOrganizationId).toBe(wineryB);
    });

    it('sin membresía → 404 ORG_NOT_FOUND; sin refresco → 401', async () => {
      const ip = nextIp();
      const logged = await login(email('paula'), ip).expect(200);
      const token = logged.body.data.tokens.accessToken;

      const noMembership = await http()
        .post('/v1/auth/switch-organization')
        .set('X-Forwarded-For', ip)
        .set('Authorization', `Bearer ${token}`)
        .set('Cookie', `doc_rt=${refreshValue(logged)}`)
        .send({ organizationId: PLATFORM_ORGANIZATION_ID })
        .expect(404);
      expect(noMembership.body.error.code).toBe('ORG_NOT_FOUND');

      const noRefresh = await http()
        .post('/v1/auth/switch-organization')
        .set('X-Forwarded-For', ip)
        .set('Authorization', `Bearer ${token}`)
        .send({ organizationId: wineryA })
        .expect(401);
      expect(noRefresh.body.error.code).toBe('AUTH_REFRESH_INVALID');
    });
  });

  describe('revocación inmediata (IAM-13)', () => {
    it('bloquear la membresía activa → la siguiente petición da 401 AUTH_SESSION_REVOKED', async () => {
      // Carla, operaria solo en B
      const ip = nextIp();
      const signup = await http()
        .post('/v1/auth/signup')
        .set('X-Forwarded-For', ip)
        .send({ email: email('carla'), password: PASSWORD, fullName: 'Carla' })
        .expect(201);
      const added = await http()
        .post('/v1/wineries/my/members')
        .set('X-Forwarded-For', bobIp)
        .set('Authorization', `Bearer ${bobToken}`)
        .send({ userId: signup.body.data.user.id, memberRole: 'OPERATOR' })
        .expect(201);
      const logged = await login(email('carla'), ip).expect(200);
      const token = logged.body.data.tokens.accessToken;
      await http()
        .get('/v1/harvest-batches')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      await memberships.block(added.body.data.id, {
        by: MembershipBlockedByEnum.OWNER,
        reason: 'Fin de temporada',
      });

      const res = await http()
        .get('/v1/harvest-batches')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
      expect(res.body.error.code).toBe('AUTH_SESSION_REVOKED');

      const refresh = await http()
        .post('/v1/auth/refresh')
        .set('X-Forwarded-For', ip)
        .set('Cookie', `doc_rt=${refreshValue(logged)}`)
        .expect(401);
      expect(refresh.body.error.code).toBe('AUTH_SESSION_REVOKED');

      // Nuevo login: sin organización utilizable
      const again = await login(email('carla'), ip).expect(200);
      expect(again.body.data.activeOrganizationId).toBeNull();
      expect(again.body.data.memberships).toEqual([
        expect.objectContaining({ organizationId: wineryB, status: 'BLOCKED' }),
      ]);
      const blocked = await http()
        .post('/v1/auth/switch-organization')
        .set('X-Forwarded-For', ip)
        .set('Authorization', `Bearer ${again.body.data.tokens.accessToken}`)
        .set('Cookie', `doc_rt=${refreshValue(again)}`)
        .send({ organizationId: wineryB })
        .expect(403);
      expect(blocked.body.error.code).toBe('ORG_MEMBERSHIP_BLOCKED');
    });

    it('logout revoca la sesión y borra la cookie; logout-all cierra todas', async () => {
      const ip = nextIp();
      const one = await login(email('paula'), ip).expect(200);
      const two = await login(email('paula'), ip).expect(200);

      const out = await http()
        .post('/v1/auth/logout')
        .set('X-Forwarded-For', ip)
        .set('Authorization', `Bearer ${one.body.data.tokens.accessToken}`)
        .expect(204);
      expect(refreshCookie(out)).toMatch(/doc_rt=;/);
      expect(refreshCookie(out)).toMatch(/Max-Age=0/);
      await http()
        .get('/v1/users/me')
        .set('Authorization', `Bearer ${one.body.data.tokens.accessToken}`)
        .expect(401);
      await http()
        .get('/v1/users/me')
        .set('Authorization', `Bearer ${two.body.data.tokens.accessToken}`)
        .expect(200);

      const three = await login(email('paula'), ip).expect(200);
      await http()
        .post('/v1/auth/logout-all')
        .set('X-Forwarded-For', ip)
        .set('Authorization', `Bearer ${three.body.data.tokens.accessToken}`)
        .expect(204);
      for (const session of [two, three]) {
        const res = await http()
          .get('/v1/users/me')
          .set(
            'Authorization',
            `Bearer ${session.body.data.tokens.accessToken}`,
          )
          .expect(401);
        expect(res.body.error.code).toBe('AUTH_SESSION_REVOKED');
      }
    });
  });

  describe('SE-01 · una bodega solo toca su propia membresía', () => {
    it('añadir a un SUPERADMIN no cambia su rol global ni su membresía de plataforma', async () => {
      await http()
        .post('/v1/wineries/my/members')
        .set('X-Forwarded-For', aliceIp)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ userId: superadminId, memberRole: 'ENOLOGIST' })
        .expect(201);

      const user = await prisma.user.findUniqueOrThrow({
        where: { id: superadminId },
      });
      expect(user.userRole).toBe(UserRoleEnum.PLATFORM_ADMIN);
      const platform = await prisma.membership.findUniqueOrThrow({
        where: {
          userId_organizationId: {
            userId: superadminId,
            organizationId: PLATFORM_ORGANIZATION_ID,
          },
        },
      });
      expect(platform).toMatchObject({ role: 'SUPERADMIN', status: 'ACTIVE' });

      // Sigue entrando como plataforma (plataforma antes que bodega)
      const again = await staffLogin(email('admin'), adminIp);
      expect(again.body.data.activeOrganizationId).toBe(
        PLATFORM_ORGANIZATION_ID,
      );
    });

    it('añadir al dueño de otra bodega no toca su rol en esa bodega', async () => {
      await http()
        .post('/v1/wineries/my/members')
        .set('X-Forwarded-For', aliceIp)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ userId: bobId, memberRole: 'OPERATOR' })
        .expect(201);

      const inB = await prisma.membership.findUniqueOrThrow({
        where: {
          userId_organizationId: { userId: bobId, organizationId: wineryB },
        },
      });
      expect(inB).toMatchObject({ role: 'OWNER', status: 'ACTIVE' });
      const bob = await prisma.user.findUniqueOrThrow({ where: { id: bobId } });
      expect(bob.userRole).toBe(UserRoleEnum.WINERY_ADMIN);
    });

    it('no puede apuntar a otra bodega (404) ni usar rutas de plataforma (403)', async () => {
      await http()
        .post(`/v1/wineries/my/members?wineryId=${wineryB}`)
        .set('X-Forwarded-For', aliceIp)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ userId: paulaId, memberRole: 'ENOLOGIST' })
        .expect(404);
      await http()
        .post(`/v1/wineries/${wineryB}/approve`)
        .set('X-Forwarded-For', aliceIp)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({})
        .expect(403);
    });

    it('volver a añadir a quien ya es miembro activo → 409 ORG_ALREADY_MEMBER', async () => {
      const res = await http()
        .post('/v1/wineries/my/members')
        .set('X-Forwarded-For', aliceIp)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ userId: paulaId, memberRole: 'ENOLOGIST' })
        .expect(409);
      expect(res.body.error.code).toBe('ORG_ALREADY_MEMBER');
    });
  });

  describe('plataforma sobre una bodega (OP-07)', () => {
    it('las escrituras exigen ?wineryId=; con él, operan sobre esa bodega', async () => {
      const body = {
        parcelName: `Plataforma ${run}`,
        surfaceHectares: 1,
        altitudeMasl: 1700,
        rawMaterialType: 'Uva',
        varietyName: 'Malbec',
      };
      const missing = await http()
        .post('/v1/terroirs')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(body)
        .expect(422);
      expect(missing.body.error.details).toEqual([
        expect.objectContaining({ field: 'wineryId' }),
      ]);

      const created = await http()
        .post(`/v1/terroirs?wineryId=${wineryA}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send(body)
        .expect(201);
      expect(created.body.data.wineryId).toBe(wineryA);

      const listed = await http()
        .get(`/v1/terroirs?wineryId=${wineryA}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(
        listed.body.data.items.every(
          (t: { wineryId: string }) => t.wineryId === wineryA,
        ),
      ).toBe(true);
    });

    it('SUPPORT solo lee', async () => {
      const ip = nextIp();
      await createPlatformUser(prisma, {
        email: email('support'),
        password: PASSWORD,
        role: 'SUPPORT',
      });
      const token = (await staffLogin(email('support'), ip)).body.data.tokens
        .accessToken;
      await http()
        .get(`/v1/terroirs?wineryId=${wineryA}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      await http()
        .post(`/v1/terroirs?wineryId=${wineryA}`)
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(403);
    });
  });

  describe('límites por IP real (SE-06, IAM-07)', () => {
    it('X-Forwarded-For: el límite de login es por IP del cliente y responde 429 con Retry-After', async () => {
      const attackerIp = nextIp();
      let res: Res | undefined;
      for (let attempt = 0; attempt < 15; attempt++) {
        res = await login(email(`nadie${attempt}`), attackerIp, 'Mala-123');
        if (res.status === 429) {
          break;
        }
        expect(res.status).toBe(401);
      }
      expect(res?.status).toBe(429);
      expect(res?.body.error.code).toBe('TOO_MANY_REQUESTS');
      expect(Number(res?.headers['retry-after'])).toBeGreaterThan(0);

      // Otra IP detrás del mismo proxy no está limitada
      const other = await login(email('nadie'), nextIp(), 'Mala-123');
      expect(other.status).toBe(401);
      expect(other.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
    });

    it('bloqueo progresivo por correo: 5 fallos → 429 AUTH_TOO_MANY_ATTEMPTS aunque cambie la IP', async () => {
      const victim = email('victima');
      await http()
        .post('/v1/auth/signup')
        .set('X-Forwarded-For', nextIp())
        .send({ email: victim, password: PASSWORD, fullName: 'Víctima' })
        .expect(201);

      const statuses: number[] = [];
      let last: Res | undefined;
      for (let attempt = 0; attempt < 5; attempt++) {
        last = await login(victim, nextIp(), 'Mala-123');
        statuses.push(last.status);
      }
      expect(statuses).toEqual([401, 401, 401, 401, 429]);
      expect(last?.body.error.code).toBe('AUTH_TOO_MANY_ATTEMPTS');
      expect(Number(last?.headers['retry-after'])).toBeGreaterThanOrEqual(59);

      // Con la contraseña buena también espera: no se comprueba mientras dure
      const locked = await login(victim, nextIp());
      expect(locked.status).toBe(429);
    });
  });
});
