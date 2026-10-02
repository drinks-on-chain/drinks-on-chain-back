import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { configureApp } from '../src/app.setup';
import { STORAGE_SERVICE } from '../src/shared/storage/storage.interface';
import { createObjectStorage } from '../src/shared/storage/storage.module';
import { deleteIdentityData } from './helpers/identity';
import { wineryWithOwner } from './helpers/staff-session';

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const PDF = Buffer.from('%PDF-1.4 informe fitosanitario de prueba');

/**
 * Subidas privadas (OPS-06, SE-04) con el driver local: solo personal con
 * organización, tipo real por firma, prefijo por organización, sin carpeta
 * pública y lectura por URL firmada. Con S3_E2E=true se repite el flujo
 * contra MinIO (driver s3), como en la CI.
 */
describe.each(
  [
    // Explícito: el `.env` de desarrollo trae `STORAGE_DRIVER=s3`
    ['local', { STORAGE_DRIVER: 'local' }],
    ...(process.env.S3_E2E === 'true'
      ? [['s3', { STORAGE_DRIVER: 's3' }] as const]
      : []),
  ].map(([name, env]) => [name, env] as [string, Record<string, string>]),
)('Subidas y almacenamiento privado · driver %s (e2e)', (driver, env) => {
  let app: INestApplication;
  let prisma: PrismaService;
  let staffToken: string;
  let consumerToken: string;
  let wineryId: string;

  const run = `upl-${driver}-${Date.now()}`;
  const staffEmail = `staff_${run}@test.bo`;
  const consumerEmail = `consumer_${run}@test.bo`;
  const password = 'Password123!';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(STORAGE_SERVICE)
      .useFactory({
        inject: [ConfigService],
        factory: (config: ConfigService) =>
          createObjectStorage({
            get: (key: string, def?: unknown) =>
              env[key] ?? config.get(key) ?? def,
            getOrThrow: (key: string) => env[key] ?? config.getOrThrow(key),
          } as unknown as ConfigService),
      })
      .compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    // Dueña de una bodega (alta + invitación aceptada desde H1)
    wineryId = (
      await wineryWithOwner(app, {
        name: `Bodega ${run}`,
        taxId: `UP${Date.now().toString().slice(-10)}`,
        email: staffEmail,
        password,
        fullName: 'Personal Bodega',
      })
    ).wineryId;
    const login = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ email: staffEmail, password })
      .expect(200);
    staffToken = login.body.data.tokens.accessToken;

    const consumer = await request(app.getHttpServer())
      .post('/v1/auth/signup')
      .send({
        email: consumerEmail,
        password,
        fullName: 'Consumidor',
      })
      .expect(201);
    consumerToken = consumer.body.data.tokens.accessToken;
  });

  afterAll(async () => {
    // Sin bodega (falló el beforeAll) no se borra nada: un where vacío borraría todo
    if (prisma && wineryId) {
      const emails = [staffEmail, consumerEmail];
      await deleteIdentityData(prisma, {
        emailContains: run,
        wineryIds: [wineryId],
      });
      await prisma.userWallet.deleteMany({ where: { wineryId } });
      await prisma.userWallet.deleteMany({
        where: { user: { email: { in: emails } } },
      });
      await prisma.wineryMember.deleteMany({ where: { wineryId } });
      await prisma.winery.deleteMany({ where: { id: wineryId } });
      await prisma.user.deleteMany({ where: { email: { in: emails } } });
    }
    await app?.close();
  });

  it('sin token → 401; consumidor → 403', async () => {
    await request(app.getHttpServer())
      .post('/v1/uploads')
      .attach('file', PNG, 'a.png')
      .expect(401);
    const res = await request(app.getHttpServer())
      .post('/v1/uploads')
      .set('Authorization', `Bearer ${consumerToken}`)
      .attach('file', PNG, 'a.png');
    expect(res.status).toBe(403);
  });

  it('sin archivo → 422 VALIDATION_ERROR en file', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/uploads')
      .set('Authorization', `Bearer ${staffToken}`)
      .expect(422);
    expect(res.body.error.details).toEqual([
      { field: 'file', message: expect.stringContaining('archivo') },
    ]);
  });

  it('rechaza SVG, scripts y archivos disfrazados (422 FILE_TYPE_NOT_ALLOWED)', async () => {
    for (const [content, name, type] of [
      ['<svg xmlns="http://www.w3.org/2000/svg"/>', 'x.svg', 'image/svg+xml'],
      ['console.log(1)', 'exploit.js', 'application/javascript'],
      ['<html><script>alert(1)</script></html>', 'foto.png', 'image/png'],
    ]) {
      const res = await request(app.getHttpServer())
        .post('/v1/uploads')
        .set('Authorization', `Bearer ${staffToken}`)
        .attach('file', Buffer.from(content), {
          filename: name,
          contentType: type,
        });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('FILE_TYPE_NOT_ALLOWED');
      expect(res.body.error.details[0].field).toBe('file');
    }
  });

  it('sube un PDF privado bajo el prefijo de la bodega y se lee con la URL firmada', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/uploads?folder=../../inspections')
      .set('Authorization', `Bearer ${staffToken}`)
      .attach('file', PDF, 'inspeccion-vendimia.pdf')
      .expect(201);
    const { key, url, mimeType, expiresAt } = res.body.data;
    expect(key).toMatch(
      new RegExp(
        `^org/${wineryId}/inspections/\\d{4}/\\d{2}/[0-9a-f-]+\\.pdf$`,
      ),
    );
    expect(mimeType).toBe('application/pdf');
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());

    // Ya no hay carpeta pública
    await request(app.getHttpServer()).get(`/uploads/${key}`).expect(404);

    // La URL firmada da el archivo
    const signed = new URL(url);
    let body: Buffer;
    if (driver === 'local') {
      const got = await request(app.getHttpServer())
        .get(`${signed.pathname}${signed.search}`)
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(got.headers['content-type']).toContain('application/pdf');
      expect(got.headers['x-content-type-options']).toBe('nosniff');
      body = got.body as Buffer;

      // Firma alterada o de otra clave → 403
      signed.searchParams.set('key', `org/${wineryId}/otra.pdf`);
      await request(app.getHttpServer())
        .get(`${signed.pathname}${signed.search}`)
        .expect(403);
    } else {
      const got = await fetch(url);
      expect(got.status).toBe(200);
      body = Buffer.from(await got.arrayBuffer());
      // Sin firma, el objeto es privado
      const unsigned = await fetch(`${signed.origin}${signed.pathname}`);
      expect(unsigned.status).toBe(403);
    }
    expect(body.equals(PDF)).toBe(true);

    // URL nueva para el mismo archivo; otra organización → 404
    const again = await request(app.getHttpServer())
      .get('/v1/uploads/url')
      .query({ key })
      .set('Authorization', `Bearer ${staffToken}`)
      .expect(200);
    expect(again.body.data.key).toBe(key);
    await request(app.getHttpServer())
      .get('/v1/uploads/url')
      .query({
        key: key.replace(wineryId, '00000000-0000-0000-0000-000000000000'),
      })
      .set('Authorization', `Bearer ${staffToken}`)
      .expect(404);

    await expect(
      prisma.auditEvent.findFirst({
        where: { action: 'FILE_UPLOADED', organizationId: wineryId },
      }),
    ).resolves.toMatchObject({ resourceType: 'file' });
  });
});
