import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as request from 'supertest';
import * as path from 'path';
import * as fs from 'fs';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { configureApp } from '../src/app.setup';
import { UserRoleEnum } from '@prisma/client';

describe('Uploads & File Storage System (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authToken: string;

  const timestamp = Date.now();
  const testEmail = `uploader_${timestamp}@test.bo`;
  const uploadDir = path.resolve(process.cwd(), './uploads');

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestExpressApplication>();

    // Misma configuración que main.ts (versionado, validación 422, envoltorio)
    configureApp(app);

    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    (app as NestExpressApplication).useStaticAssets(uploadDir, {
      prefix: '/uploads/',
    });

    await app.init();
    prisma = app.get<PrismaService>(PrismaService);

    // Registrar un usuario de prueba para autenticación
    const signupRes = await request(app.getHttpServer())
      .post('/v1/auth/signup')
      .send({
        email: testEmail,
        password: 'Password123!',
        fullName: 'Test Uploader User',
        userRole: UserRoleEnum.CONSUMER,
      });

    authToken = signupRes.body.data.tokens.accessToken;
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.userWallet.deleteMany({
        where: { user: { email: testEmail } },
      });
      await prisma.user.deleteMany({
        where: { email: testEmail },
      });
      await prisma.$disconnect();
    }
    if (app) {
      await app.close();
    }
  });

  describe('Seguridad y Validaciones de Subida', () => {
    it('debe rechazar la subida si no se proporciona token de autenticación (401 Unauthorized)', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/uploads')
        .attach('file', Buffer.from('test data'), 'test.png');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('debe rechazar la petición si no se envía ningún archivo en multipart (422 VALIDATION_ERROR en file)', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/uploads')
        .set('Authorization', `Bearer ${authToken}`);

      expect(res.status).toBe(422);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details).toEqual([
        { field: 'file', message: expect.stringContaining('archivo') },
      ]);
    });

    it('debe rechazar archivos con tipos MIME no autorizados como scripts o ejecutables (422 VALIDATION_ERROR en file)', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/uploads')
        .set('Authorization', `Bearer ${authToken}`)
        .attach('file', Buffer.from('console.log("malicious");'), {
          filename: 'exploit.js',
          contentType: 'application/javascript',
        });

      expect(res.status).toBe(422);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details).toEqual([
        {
          field: 'file',
          message: expect.stringContaining('Tipo de archivo no permitido'),
        },
      ]);
    });
  });

  describe('Flujos de Almacenamiento y Acceso Estático', () => {
    let uploadedPdfUrl: string;

    it('debe subir exitosamente un informe técnico en PDF y retornar URL pública', async () => {
      const pdfBuffer = Buffer.from('%PDF-1.4 informe fitosanitario de prueba');
      const res = await request(app.getHttpServer())
        .post('/v1/uploads?folder=inspections')
        .set('Authorization', `Bearer ${authToken}`)
        .attach('file', pdfBuffer, 'inspeccion-vendimia.pdf');

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.url).toBeDefined();
      expect(res.body.data.url).toContain('/uploads/inspections/');
      expect(res.body.data.url).toMatch(/\.pdf$/);
      expect(res.body.data.mimeType).toBe('application/pdf');
      expect(res.body.data.originalName).toBe('inspeccion-vendimia.pdf');

      uploadedPdfUrl = res.body.data.url;
    });

    it('debe subir exitosamente una imagen de etiqueta (PNG) y sanitizar directorios maliciosos', async () => {
      const pngBuffer = Buffer.from('fake-png-content');
      const res = await request(app.getHttpServer())
        .post('/v1/uploads?folder=../../labels/safe')
        .set('Authorization', `Bearer ${authToken}`)
        .attach('file', pngBuffer, 'etiqueta-botella.png');

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.url).toBeDefined();
      // No debe contener ..
      expect(res.body.data.url).not.toContain('..');
      expect(res.body.data.url).toContain('/uploads/labelssafe/');
      expect(res.body.data.mimeType).toBe('image/png');
    });

    it('debe permitir la descarga o visualización estática vía GET del archivo subido', async () => {
      expect(uploadedPdfUrl).toBeDefined();

      // Extraer ruta relativa a partir de la URL (ej. /uploads/inspections/...)
      const relativePath = new URL(uploadedPdfUrl).pathname;

      const res = await request(app.getHttpServer()).get(relativePath);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/pdf');
    });
  });
});
