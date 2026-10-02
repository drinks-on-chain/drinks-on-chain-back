import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { configureApp } from '../src/app.setup';
import {
  createPlatformUser,
  deleteIdentityData,
  loginWithMfa,
} from './helpers/identity';
import { WineryStatusEnum } from '@prisma/client';
import { createActiveWinery, wineryWithOwner } from './helpers/staff-session';
import { resetLoopbackLoginLocks } from './helpers/login-locks';

/**
 * Estándares de API de la Ola 0 (contrato plan/contratos/o0-… §1–§3):
 * listas paginadas, 422 con details por campo, Idempotency-Key y 429.
 */
// Esta prueba mide el límite de peticiones, no el bloqueo por IP (IAM-07),
// cuyo contador en Redis se acumula entre ejecuciones locales desde 127.0.0.1
process.env.LOGIN_LOCK_IP_THRESHOLD = '100000';

describe('Estándares de API · O0-BE-2 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const timestamp = Date.now();
  const adminEmail = `std_admin_${timestamp}@doc.bo`;
  const ownerEmail = `std_owner_${timestamp}@bodega.bo`;
  const wineryIds: string[] = [];
  let adminToken: string;
  let ownerToken: string;

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    await resetLoopbackLoginLocks(app);
    prisma = app.get<PrismaService>(PrismaService);

    // Administrador de plataforma (como el seeder)
    await createPlatformUser(prisma, {
      email: adminEmail,
      password: 'Password123!',
      fullName: 'Admin Estándares',
    });
    adminToken = (
      await loginWithMfa(http, prisma, {
        email: adminEmail,
        password: 'Password123!',
      })
    ).body.data.tokens.accessToken;

    // Bodega activa con su dueña (desde H1: alta + invitación aceptada)
    const owned = await wineryWithOwner(app, {
      name: `Estándares ${timestamp}`,
      taxId: `STD-${timestamp.toString().slice(-9)}`,
      email: ownerEmail,
      password: 'Password123!',
    });
    wineryIds.push(owned.wineryId);
    ownerToken = (
      await http()
        .post('/v1/auth/login')
        .send({ email: ownerEmail, password: 'Password123!' })
        .expect(200)
    ).body.data.tokens.accessToken;

    // Una bodega invitada (sin activar) para el directorio con ?status=INVITED
    wineryIds.push(
      await createActiveWinery(prisma, {
        name: `Pendiente ${timestamp}`,
        taxId: `STP-${timestamp.toString().slice(-9)}`,
        status: WineryStatusEnum.INVITED,
      }),
    );
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.terroir.deleteMany({
        where: { wineryId: { in: wineryIds } },
      });
      await deleteIdentityData(prisma, {
        emailContains: `${timestamp}`,
        wineryIds,
      });
      await prisma.wineryMember.deleteMany({
        where: { wineryId: { in: wineryIds } },
      });
      await prisma.userWallet.deleteMany({
        where: {
          OR: [
            { wineryId: { in: wineryIds } },
            { user: { email: { contains: `${timestamp}` } } },
          ],
        },
      });
      await prisma.winery.deleteMany({ where: { id: { in: wineryIds } } });
      await prisma.user.deleteMany({
        where: { email: { contains: `${timestamp}` } },
      });
      await prisma.$disconnect();
    }
    if (app) {
      await app.close();
    }
  });

  // Todas las colecciones del API y quién puede leerlas
  const collections: Array<[string, () => string]> = [
    ['/v1/wineries', () => adminToken],
    ['/v1/platform/wineries', () => adminToken],
    ['/v1/organizations/current/members', () => ownerToken],
    ['/v1/terroirs', () => ownerToken],
    ['/v1/harvest-batches', () => ownerToken],
    ['/v1/fermentation-tanks', () => ownerToken],
    ['/v1/wine-aging', () => ownerToken],
    ['/v1/production-batches', () => ownerToken],
    ['/v1/bottling', () => ownerToken],
  ];

  describe('Listas { items, total, limit, offset } (§2)', () => {
    it.each(collections)(
      'GET %s devuelve la página con limit 20 y offset 0 por defecto',
      async (path, token) => {
        const res = await http()
          .get(path)
          .set('Authorization', `Bearer ${token()}`)
          .expect(200);

        expect(Object.keys(res.body.data).sort()).toEqual([
          'items',
          'limit',
          'offset',
          'total',
        ]);
        expect(Array.isArray(res.body.data.items)).toBe(true);
        expect(res.body.data).toMatchObject({ limit: 20, offset: 0 });
        expect(res.body.data.total).toBeGreaterThanOrEqual(
          res.body.data.items.length,
        );
      },
    );

    it.each(collections)(
      'GET %s?limit=101 → 422 VALIDATION_ERROR en limit',
      async (path, token) => {
        const res = await http()
          .get(`${path}?limit=101`)
          .set('Authorization', `Bearer ${token()}`)
          .expect(422);

        expect(res.body.error).toEqual({
          code: 'VALIDATION_ERROR',
          message: 'Validation failed',
          details: [
            { field: 'limit', message: 'limit must not be greater than 100' },
          ],
        });
      },
    );

    it.each(collections)(
      'GET %s?offset=-1 → 422 VALIDATION_ERROR en offset',
      async (path, token) => {
        const res = await http()
          .get(`${path}?offset=-1`)
          .set('Authorization', `Bearer ${token()}`)
          .expect(422);

        expect(res.body.error.details).toEqual([
          { field: 'offset', message: 'offset must not be less than 0' },
        ]);
      },
    );

    it('limit=100 es válido y limit/offset recortan la página', async () => {
      const all = await http()
        .get('/v1/wineries?status=INVITED&limit=100')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(all.body.data.limit).toBe(100);
      expect(all.body.data.total).toBeGreaterThanOrEqual(1);

      const page = await http()
        .get('/v1/wineries?status=INVITED&limit=1&offset=0')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(page.body.data).toMatchObject({
        total: all.body.data.total,
        limit: 1,
        offset: 0,
      });
      expect(page.body.data.items).toHaveLength(1);
      // Orden por fecha de alta descendente: la última invitada va primero
      expect(page.body.data.items[0].id).toBe(wineryIds[1]);
    });
  });

  describe('Errores (§1)', () => {
    it('cuerpo inválido → 422 con un detalle por campo', async () => {
      const res = await http()
        .post('/v1/terroirs')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ parcelName: 'Sin datos', surfaceHectares: 'mucho', extra: 1 })
        .expect(422);

      expect(res.body.success).toBe(false);
      expect(res.body.statusCode).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      const fields = (
        res.body.error.details as Array<{ field: string | null }>
      ).map((d) => d.field);
      expect(fields).toEqual(
        expect.arrayContaining([
          'extra',
          'surfaceHectares',
          'altitudeMasl',
          'rawMaterialType',
          'varietyName',
        ]),
      );
      expect(fields).not.toContain('parcelName');
      for (const detail of res.body.error.details) {
        expect(Object.keys(detail).sort()).toEqual(['field', 'message']);
        expect(typeof detail.message).toBe('string');
      }
    });

    it('regla de un campo en el servicio → 422 en ese campo (bruto ≤ tara)', async () => {
      const terroir = await http()
        .post('/v1/terroirs')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          parcelName: 'Cuartel Báscula',
          surfaceHectares: 1,
          altitudeMasl: 1900,
          rawMaterialType: 'uva',
          varietyName: 'Moscatel de Alejandría',
        })
        .expect(201);

      const res = await http()
        .post('/v1/harvest-batches')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          terroirId: terroir.body.data.id,
          intakeDate: '2026-03-15',
          harvestYear: 2026,
          grossWeightKg: 100,
          tareWeightKg: 150,
          maturity: { brixDegrees: 22, ph: 3.4, acidityGl: 6.5 },
        })
        .expect(422);

      expect(res.body.error).toEqual({
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: [
          {
            field: 'grossWeightKg',
            message: 'El peso bruto debe ser estrictamente mayor al peso tara',
          },
        ],
      });
    });

    it('JSON mal formado → 400 BAD_REQUEST sin details', async () => {
      const res = await http()
        .post('/v1/terroirs')
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('Content-Type', 'application/json')
        .send('{"parcelName": ')
        .expect(400);

      expect(res.body.error.code).toBe('BAD_REQUEST');
      expect(res.body.error.details).toBeNull();
    });

    it('recurso de otra organización → 404 (nunca 403)', async () => {
      const foreign = await prisma.terroir.findFirst({
        where: { wineryId: { notIn: wineryIds } },
        select: { id: true },
      });
      const id = foreign?.id ?? randomUUID();
      const res = await http()
        .get(`/v1/terroirs/${id}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(404);
      expect(res.body.error.details).toBeNull();
    });
  });

  describe('Idempotency-Key (§3)', () => {
    const terroirBody = (parcelName: string) => ({
      parcelName,
      surfaceHectares: 2.5,
      altitudeMasl: 1850,
      rawMaterialType: 'uva',
      varietyName: 'Moscatel de Alejandría',
    });
    const countParcels = (parcelName: string) =>
      prisma.terroir.count({
        where: { wineryId: wineryIds[0], parcelName },
      });

    it('misma clave y mismo cuerpo → la misma respuesta y un solo registro', async () => {
      const key = randomUUID();
      const body = terroirBody(`Idem ${timestamp}`);

      const first = await http()
        .post('/v1/terroirs')
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('Idempotency-Key', key)
        .send(body)
        .expect(201);
      expect(first.headers['idempotent-replayed']).toBeUndefined();

      const second = await http()
        .post('/v1/terroirs')
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('Idempotency-Key', key)
        .send(body)
        .expect(201);

      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.body.data).toEqual(first.body.data);
      expect(await countParcels(body.parcelName)).toBe(1);
    });

    it('misma clave con otro cuerpo → 409 IDEMPOTENCY_KEY_REUSED', async () => {
      const key = randomUUID();
      await http()
        .post('/v1/terroirs')
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('Idempotency-Key', key)
        .send(terroirBody(`Reuso A ${timestamp}`))
        .expect(201);

      const res = await http()
        .post('/v1/terroirs')
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('Idempotency-Key', key)
        .send(terroirBody(`Reuso B ${timestamp}`))
        .expect(409);

      expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await countParcels(`Reuso B ${timestamp}`)).toBe(0);
    });

    it('peticiones simultáneas con la misma clave → una sola alta', async () => {
      const key = randomUUID();
      const body = terroirBody(`Concurrente ${timestamp}`);

      const responses = await Promise.all(
        Array.from({ length: 6 }, () =>
          http()
            .post('/v1/terroirs')
            .set('Authorization', `Bearer ${ownerToken}`)
            .set('Idempotency-Key', key)
            .send(body),
        ),
      );

      const created = responses.filter((r) => r.status === 201);
      const inProgress = responses.filter((r) => r.status === 409);
      expect(created.length + inProgress.length).toBe(6);
      expect(created.length).toBeGreaterThanOrEqual(1);
      expect(new Set(created.map((r) => r.body.data.id)).size).toBe(1);
      for (const r of inProgress) {
        expect(r.body.error.code).toBe('IDEMPOTENCY_IN_PROGRESS');
      }
      expect(await countParcels(body.parcelName)).toBe(1);
    });

    it('si la operación falla, la clave se puede reutilizar', async () => {
      const key = randomUUID();
      await http()
        .post('/v1/terroirs')
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('Idempotency-Key', key)
        .send({ parcelName: 'Incompleta' })
        .expect(422);

      await http()
        .post('/v1/terroirs')
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('Idempotency-Key', key)
        .send(terroirBody(`Reintento ${timestamp}`))
        .expect(201);
    });

    it('clave que no es UUID → 422 IDEMPOTENCY_KEY_INVALID', async () => {
      const res = await http()
        .post('/v1/terroirs')
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('Idempotency-Key', 'pedido-1')
        .send(terroirBody(`No UUID ${timestamp}`))
        .expect(422);

      expect(res.body.error).toEqual({
        code: 'IDEMPOTENCY_KEY_INVALID',
        message: 'Invalid Idempotency-Key',
        details: [
          {
            field: 'Idempotency-Key',
            message: 'Idempotency-Key must be a UUID',
          },
        ],
      });
      expect(await countParcels(`No UUID ${timestamp}`)).toBe(0);
    });

    it('sin cabecera el alta funciona como siempre', async () => {
      const body = terroirBody(`Sin clave ${timestamp}`);
      await http()
        .post('/v1/terroirs')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send(body)
        .expect(201);
      await http()
        .post('/v1/terroirs')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send(body)
        .expect(201);
      expect(await countParcels(body.parcelName)).toBe(2);
    });
  });

  describe('Límite de peticiones (§1)', () => {
    it('429 TOO_MANY_REQUESTS con Retry-After', async () => {
      let res: request.Response | undefined;
      // login: 10 por minuto e IP (ya se usaron 2 en beforeAll). Correos
      // distintos para que no salte antes el bloqueo por correo (IAM-07).
      for (let attempt = 0; attempt < 15; attempt++) {
        res = await http()
          .post('/v1/auth/login')
          .send({
            email: `nadie_${attempt}_${timestamp}@x.bo`,
            password: 'Wrong-password-1',
          });
        if (res.status === 429) {
          break;
        }
        expect(res.status).toBe(401);
      }

      expect(res?.status).toBe(429);
      expect(res?.body.error.code).toBe('TOO_MANY_REQUESTS');
      expect(Number(res?.headers['retry-after'])).toBeGreaterThan(0);
    });
  });
});
