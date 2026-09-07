import { Test, TestingModule } from '@nestjs/testing';
import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { ResponseTransformInterceptor } from '../src/shared/interceptors/response-transform.interceptor';
import { GlobalExceptionFilter } from '../src/shared/filters/global-exception.filter';
import { UserRoleEnum, WineryCategoryEnum, WineryMemberRoleEnum } from '@prisma/client';

describe('Auth & Multi-Tenancy Flow (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let consumerToken: string;
  let consumerRefreshToken: string;
  let wineryAdminToken: string;
  let platformAdminToken: string;
  let enologistUserId: string;
  let enologistToken: string;
  let createdWineryId: string;

  const timestamp = Date.now();
  const consumerEmail = `consumer_${timestamp}@test.bo`;
  const wineryAdminEmail = `winery_admin_${timestamp}@kohlberg.bo`;
  const platformAdminEmail = `platform_admin_${timestamp}@doc.bo`;
  const enologistEmail = `enologist_${timestamp}@kohlberg.bo`;
  const taxIdNit = `NIT-${timestamp.toString().slice(-8)}`;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();

    app.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: '1',
    });

    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );

    app.useGlobalInterceptors(new ResponseTransformInterceptor());
    app.useGlobalFilters(new GlobalExceptionFilter());

    await app.init();
    prisma = app.get<PrismaService>(PrismaService);
  });

  afterAll(async () => {
    if (prisma) {
      // Limpieza de datos creados en el test
      await prisma.userWallet.deleteMany({
        where: { user: { email: { contains: `${timestamp}` } } },
      });
      await prisma.wineryMember.deleteMany({
        where: { user: { email: { contains: `${timestamp}` } } },
      });
      if (createdWineryId) {
        await prisma.winery.deleteMany({
          where: { id: createdWineryId },
        });
      }
      await prisma.user.deleteMany({
        where: { email: { contains: `${timestamp}` } },
      });
      await prisma.$disconnect();
    }
    if (app) {
      await app.close();
    }
  });

  // 1. REGISTRO DE CONSUMIDOR
  it('1. POST /v1/auth/signup - Debe registrar un consumidor y asignar wallet custodial', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/auth/signup')
      .send({
        email: consumerEmail,
        password: 'Password123!',
        fullName: 'Consumidor Test',
        userRole: UserRoleEnum.CONSUMER,
      })
      .expect(201);

    expect(response.body.success).toBe(true);
    expect(response.body.data.user.email).toBe(consumerEmail);
    expect(response.body.data.user.userRole).toBe(UserRoleEnum.CONSUMER);
    expect(response.body.data.tokens).toHaveProperty('accessToken');
    expect(response.body.data.tokens).toHaveProperty('refreshToken');

    consumerToken = response.body.data.tokens.accessToken;
    consumerRefreshToken = response.body.data.tokens.refreshToken;
  });

  // 2. LOGIN DE CONSUMIDOR
  it('2. POST /v1/auth/login - Debe autenticar al consumidor', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({
        email: consumerEmail,
        password: 'Password123!',
      })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data.tokens).toHaveProperty('accessToken');
  });

  // 3. CONSULTA DE PERFIL Y WALLET
  it('3. GET /v1/users/me - Debe retornar el perfil del consumidor con su wallet', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/users/me')
      .set('Authorization', `Bearer ${consumerToken}`)
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data.email).toBe(consumerEmail);
    expect(response.body.data.primaryWallet).toBeDefined();
    expect(response.body.data.primaryWallet.stellarPublicAddress).toMatch(/^G[A-Z0-9]{55}$/);
  });

  // 4. ACTUALIZACIÓN DE PERFIL
  it('4. PATCH /v1/users/me - Debe actualizar el nombre del consumidor', async () => {
    const response = await request(app.getHttpServer())
      .patch('/v1/users/me')
      .set('Authorization', `Bearer ${consumerToken}`)
      .send({
        fullName: 'Consumidor Modificado',
        preferredLocale: 'en',
      })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data.fullName).toBe('Consumidor Modificado');
    expect(response.body.data.preferredLocale).toBe('en');
  });

  // 5. REGISTRO DE WINERY_ADMIN Y ONBOARDING DE BODEGA
  it('5. POST /v1/wineries - Debe permitir a un WINERY_ADMIN solicitar alta de bodega en estado PENDING', async () => {
    // 5.1 Registro de WINERY_ADMIN
    const signupRes = await request(app.getHttpServer())
      .post('/v1/auth/signup')
      .send({
        email: wineryAdminEmail,
        password: 'Password123!',
        fullName: 'Admin Bodega Kohlberg',
        userRole: UserRoleEnum.WINERY_ADMIN,
      })
      .expect(201);

    wineryAdminToken = signupRes.body.data.tokens.accessToken;

    // 5.2 Creación de Bodega
    const wineryRes = await request(app.getHttpServer())
      .post('/v1/wineries')
      .set('Authorization', `Bearer ${wineryAdminToken}`)
      .send({
        legalName: 'Sociedad Agroindustrial Kohlberg S.A.',
        commercialName: 'Bodega Kohlberg',
        beverageCategory: WineryCategoryEnum.WINERY,
        taxIdNit: taxIdNit,
        senasagSanitaryReg: `SENASAG-${timestamp}`,
        geographicRegion: 'Tarija',
        contactEmail: wineryAdminEmail,
      })
      .expect(201);

    expect(wineryRes.body.success).toBe(true);
    expect(wineryRes.body.data.commercialName).toBe('Bodega Kohlberg');
    expect(wineryRes.body.data.certificationStatus).toBe('PENDING');
    expect(wineryRes.body.data.stellarPublicKey).toMatch(/^G[A-Z0-9]{55}$/);

    createdWineryId = wineryRes.body.data.id;
  });

  // 6. INTENTO DE AUTO-APROBACIÓN DENEGADO
  it('6. POST /v1/wineries/:id/approve - Debe denegar aprobación a un WINERY_ADMIN (403 Forbidden)', async () => {
    await request(app.getHttpServer())
      .post(`/v1/wineries/${createdWineryId}/approve`)
      .set('Authorization', `Bearer ${wineryAdminToken}`)
      .expect(403);
  });

  // 7. REGISTRO Y APROBACIÓN POR PLATFORM_ADMIN
  it('7. POST /v1/wineries/:id/approve - Debe permitir a PLATFORM_ADMIN aprobar la bodega (cambia a ACTIVE)', async () => {
    // 7.1 Registro de PLATFORM_ADMIN
    const signupRes = await request(app.getHttpServer())
      .post('/v1/auth/signup')
      .send({
        email: platformAdminEmail,
        password: 'Password123!',
        fullName: 'Admin Plataforma DoC',
        userRole: UserRoleEnum.PLATFORM_ADMIN,
      })
      .expect(201);

    platformAdminToken = signupRes.body.data.tokens.accessToken;

    // 7.2 Listar pendientes
    const pendingRes = await request(app.getHttpServer())
      .get('/v1/wineries/pending')
      .set('Authorization', `Bearer ${platformAdminToken}`)
      .expect(200);

    expect(pendingRes.body.success).toBe(true);
    expect(pendingRes.body.data.some((w: any) => w.id === createdWineryId)).toBe(true);

    // 7.3 Aprobar bodega
    const approveRes = await request(app.getHttpServer())
      .post(`/v1/wineries/${createdWineryId}/approve`)
      .set('Authorization', `Bearer ${platformAdminToken}`)
      .send({ approvalNotes: 'Verificación SENASAG aprobada' })
      .expect(200);

    expect(approveRes.body.success).toBe(true);
    expect(approveRes.body.data.certificationStatus).toBe('ACTIVE');
    expect(approveRes.body.data.onchainProducerId).toContain('PROD_BO_');
    expect(approveRes.body.data.onchainRegisterTxHash).toBeDefined();
  });

  // 8. GESTIÓN DE MIEMBROS Y MULTI-TENANCY
  it('8. POST /v1/wineries/my/members - WINERY_ADMIN incorpora un Enólogo a su bodega', async () => {
    // 8.1 Registrar usuario Enólogo
    const enologistSignup = await request(app.getHttpServer())
      .post('/v1/auth/signup')
      .send({
        email: enologistEmail,
        password: 'Password123!',
        fullName: 'Valeria Soliz Enóloga',
        userRole: UserRoleEnum.ENOLOGIST,
      })
      .expect(201);

    enologistUserId = enologistSignup.body.data.user.id;

    // 8.2 Login como WINERY_ADMIN para refrescar token con wineryId
    const loginWineryAdmin = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({
        email: wineryAdminEmail,
        password: 'Password123!',
      })
      .expect(200);

    wineryAdminToken = loginWineryAdmin.body.data.tokens.accessToken;

    // 8.3 Incorporar Enólogo como miembro
    const addMemberRes = await request(app.getHttpServer())
      .post('/v1/wineries/my/members')
      .set('Authorization', `Bearer ${wineryAdminToken}`)
      .send({
        userId: enologistUserId,
        memberRole: WineryMemberRoleEnum.ENOLOGIST,
        professionalLicenseNumber: 'ENOL-BOL-2026-991',
      })
      .expect(201);

    expect(addMemberRes.body.success).toBe(true);
    expect(addMemberRes.body.data.memberRole).toBe(WineryMemberRoleEnum.ENOLOGIST);
  });

  // 9. ACCESO DE ENÓLOGO Y AISLAMIENTO DE TENANT
  it('9. GET /v1/wineries/my - Enólogo autenticado accede a los datos de su bodega', async () => {
    // 9.1 Login de Enólogo
    const loginRes = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({
        email: enologistEmail,
        password: 'Password123!',
      })
      .expect(200);

    enologistToken = loginRes.body.data.tokens.accessToken;
    expect(loginRes.body.data.user.wineryId).toBe(createdWineryId);

    // 9.2 Consulta de su bodega
    const wineryRes = await request(app.getHttpServer())
      .get('/v1/wineries/my')
      .set('Authorization', `Bearer ${enologistToken}`)
      .expect(200);

    expect(wineryRes.body.success).toBe(true);
    expect(wineryRes.body.data.commercialName).toBe('Bodega Kohlberg');
  });

  // 10. RENOVACIÓN DE TOKEN
  it('10. POST /v1/auth/refresh - Debe emitir nuevos tokens con refreshToken', async () => {
    const refreshRes = await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refreshToken: consumerRefreshToken })
      .expect(200);

    expect(refreshRes.body.success).toBe(true);
    expect(refreshRes.body.data).toHaveProperty('accessToken');
    expect(refreshRes.body.data).toHaveProperty('refreshToken');
  });
});
