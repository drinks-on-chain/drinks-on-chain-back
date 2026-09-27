import { Test, TestingModule } from '@nestjs/testing';
import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import * as request from 'supertest';
import * as bcrypt from 'bcrypt';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { ResponseTransformInterceptor } from '../src/shared/interceptors/response-transform.interceptor';
import { GlobalExceptionFilter } from '../src/shared/filters/global-exception.filter';
import {
  UserRoleEnum,
  WineryCategoryEnum,
  WineryMemberRoleEnum,
  BeverageTypeEnum,
  PhytoStatusEnum,
  DestinationTypeEnum,
  TreatmentTypeEnum,
} from '@prisma/client';

describe('Traceability ERP & Strategy Pattern (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const timestamp = Date.now();
  let platformAdminToken: string;
  let wineryAdminToken: string;
  let agronomistToken: string;
  let enologistToken: string;
  let winery2AdminToken: string;

  let wineryId: string;
  let winery2Id: string;
  let terroirId: string;
  let harvestBatchId: string;
  let fermentationTankId: string;
  let distillationBatchId: string;
  let bottlingBatchId: string;

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

    // 1. Crear Platform Admin directamente en DB (simulando Seeder oficial)
    const adminEmail = `platform_admin_${timestamp}@doc.bo`;
    const passwordHash = await bcrypt.hash('Password123!', 12);
    await prisma.user.create({
      data: {
        email: adminEmail,
        passwordHash,
        fullName: 'Platform Admin',
        userRole: UserRoleEnum.PLATFORM_ADMIN,
        isActive: true,
      },
    });

    const adminLogin = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({
        email: adminEmail,
        password: 'Password123!',
      });
    platformAdminToken = adminLogin.body.data.tokens.accessToken;

    // 2. Crear Winery Admin para Bodega 1
    const wAdminRes = await request(app.getHttpServer())
      .post('/v1/auth/signup')
      .send({
        email: `winery_admin_${timestamp}@singani.bo`,
        password: 'Password123!',
        fullName: 'Winery Admin Singani',
        userRole: UserRoleEnum.WINERY_ADMIN,
      });
    const initialWineryAdminToken = wAdminRes.body.data.tokens.accessToken;

    // 3. Crear Bodega 1
    const wineryRes = await request(app.getHttpServer())
      .post('/v1/wineries')
      .set('Authorization', `Bearer ${initialWineryAdminToken}`)
      .send({
        legalName: `Destilería San Lorenzo ${timestamp} S.A.`,
        commercialName: `Casa Real ${timestamp}`,
        beverageCategory: WineryCategoryEnum.DISTILLERY,
        taxIdNit: `NIT-${timestamp.toString().slice(-8)}`,
        geographicRegion: 'San Lorenzo, Tarija',
        contactEmail: `contacto_${timestamp}@singani.bo`,
      });
    wineryId = wineryRes.body.data.id;

    // Aprobar Bodega 1
    await request(app.getHttpServer())
      .post(`/v1/wineries/${wineryId}/approve`)
      .set('Authorization', `Bearer ${platformAdminToken}`)
      .send({
        onchainProducerId: `PROD-${timestamp.toString().slice(-6)}`,
      });

    // Login Winery Admin con tenant activo
    const wAdminLogin = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({
        email: `winery_admin_${timestamp}@singani.bo`,
        password: 'Password123!',
      });
    wineryAdminToken = wAdminLogin.body.data.tokens.accessToken;

    // 4. Crear Agrónomo (registro inicial como CONSUMER)
    const agroRes = await request(app.getHttpServer())
      .post('/v1/auth/signup')
      .send({
        email: `agronomist_${timestamp}@singani.bo`,
        password: 'Password123!',
        fullName: 'Ing. Carlos Mendoza',
        userRole: UserRoleEnum.CONSUMER,
      });
    const agroUserId = agroRes.body.data.user.id;

    // Asociar Agrónomo a Bodega 1 (sincroniza rol a AGRONOMIST)
    await request(app.getHttpServer())
      .post('/v1/wineries/my/members')
      .set('Authorization', `Bearer ${wineryAdminToken}`)
      .send({
        userId: agroUserId,
        memberRole: WineryMemberRoleEnum.AGRONOMIST,
        professionalLicenseNumber: 'AGRO-TAR-2024',
      });

    const agroLogin = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({
        email: `agronomist_${timestamp}@singani.bo`,
        password: 'Password123!',
      });
    agronomistToken = agroLogin.body.data.tokens.accessToken;

    // 5. Crear Enólogo (registro inicial como CONSUMER)
    const enolRes = await request(app.getHttpServer())
      .post('/v1/auth/signup')
      .send({
        email: `enologist_${timestamp}@singani.bo`,
        password: 'Password123!',
        fullName: 'Lic. Valeria Soliz',
        userRole: UserRoleEnum.CONSUMER,
      });
    const enolUserId = enolRes.body.data.user.id;

    await request(app.getHttpServer())
      .post('/v1/wineries/my/members')
      .set('Authorization', `Bearer ${wineryAdminToken}`)
      .send({
        userId: enolUserId,
        memberRole: WineryMemberRoleEnum.ENOLOGIST,
        professionalLicenseNumber: 'ENOL-TAR-901',
      });

    const enolLogin = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({
        email: `enologist_${timestamp}@singani.bo`,
        password: 'Password123!',
      });
    enologistToken = enolLogin.body.data.tokens.accessToken;

    // 6. Crear Bodega 2 (Para pruebas de aislamiento Multi-Tenant)
    const w2AdminRes = await request(app.getHttpServer())
      .post('/v1/auth/signup')
      .send({
        email: `winery2_admin_${timestamp}@other.bo`,
        password: 'Password123!',
        fullName: 'Winery 2 Admin',
        userRole: UserRoleEnum.WINERY_ADMIN,
      });

    const winery2Res = await request(app.getHttpServer())
      .post('/v1/wineries')
      .set('Authorization', `Bearer ${w2AdminRes.body.data.tokens.accessToken}`)
      .send({
        legalName: `Bodega Cinti ${timestamp} S.A.`,
        commercialName: `Vinos Cinti ${timestamp}`,
        beverageCategory: WineryCategoryEnum.WINERY,
        taxIdNit: `NIT2-${timestamp.toString().slice(-7)}`,
        geographicRegion: 'Camargo, Chuquisaca',
        contactEmail: `contacto_${timestamp}@other.bo`,
      });
    winery2Id = winery2Res.body.data.id;

    await request(app.getHttpServer())
      .post(`/v1/wineries/${winery2Id}/approve`)
      .set('Authorization', `Bearer ${platformAdminToken}`)
      .send({});

    const w2Login = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({
        email: `winery2_admin_${timestamp}@other.bo`,
        password: 'Password123!',
      });
    winery2AdminToken = w2Login.body.data.tokens.accessToken;
  });

  afterAll(async () => {
    if (prisma) {
      const activeWineryIds = [wineryId, winery2Id].filter(Boolean);
      if (activeWineryIds.length > 0) {
        await prisma.batchLabAnalysis.deleteMany({
          where: { bottlingBatch: { wineryId: { in: activeWineryIds } } },
        });
        await prisma.bottlingBatch.deleteMany({
          where: { wineryId: { in: activeWineryIds } },
        });
        await prisma.wineAgingBatch.deleteMany({
          where: { wineryId: { in: activeWineryIds } },
        });
        await prisma.productionBatch.deleteMany({
          where: { wineryId: { in: activeWineryIds } },
        });
        await prisma.enologicalTreatment.deleteMany({
          where: { fermentationTank: { wineryId: { in: activeWineryIds } } },
        });
        await prisma.fermentationLog.deleteMany({
          where: { fermentationTank: { wineryId: { in: activeWineryIds } } },
        });
        await prisma.fermentationTank.deleteMany({
          where: { wineryId: { in: activeWineryIds } },
        });
        await prisma.harvestBatch.deleteMany({
          where: { wineryId: { in: activeWineryIds } },
        });
        await prisma.terroir.deleteMany({
          where: { wineryId: { in: activeWineryIds } },
        });
        await prisma.wineryMember.deleteMany({
          where: { wineryId: { in: activeWineryIds } },
        });
        await prisma.winery.deleteMany({
          where: { id: { in: activeWineryIds } },
        });
      }
      await prisma.userWallet.deleteMany({
        where: { user: { email: { contains: `${timestamp}` } } },
      });
      await prisma.user.deleteMany({
        where: { email: { contains: `${timestamp}` } },
      });
      await prisma.$disconnect();
    }
    if (app) {
      await app.close();
    }
  });

  // ===========================================================================
  // FLUJO 1: TRAZABILIDAD COMPLETA SINGANI D.O. (BOLIVIA)
  // ===========================================================================
  describe('Flujo Completo Singani D.O. (San Lorenzo, Tarija - 1,850 msnm)', () => {
    it('Paso 1: [POST /v1/terroirs] Registra parcela a 1,850 msnm con 100% Moscatel de Alejandría', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/terroirs')
        .set('Authorization', `Bearer ${agronomistToken}`)
        .send({
          parcelName: 'Cuartel 4 - La Finca El Potrero',
          cadastreCode: 'CAT-TL-4022',
          surfaceHectares: 4.5,
          altitudeMasl: 1850.0,
          latitude: -21.48512,
          longitude: -64.78921,
          rawMaterialType: 'uva',
          varietyName: '100% Moscatel de Alejandría',
          isDoEligible: true,
          doType: 'D.O. Singani',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.parcelName).toBe('Cuartel 4 - La Finca El Potrero');
      expect(Number(res.body.data.altitudeMasl)).toBe(1850.0);
      terroirId = res.body.data.id;
    });

    it('Paso 2: [POST /v1/harvest-batches] Registra pesaje en báscula con cálculo de peso neto', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/harvest-batches')
        .set('Authorization', `Bearer ${agronomistToken}`)
        .send({
          terroirId,
          intakeDate: '2026-03-15',
          harvestYear: 2026,
          grossWeightKg: 15000.0,
          tareWeightKg: 150.0,
          brixDegrees: 22.4,
          initialPh: 3.45,
          initialAcidityGl: 6.8,
          temperatureAtIntakeC: 16.5,
          notes: 'Uva fresca en excelente estado sanitario',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.harvestBatchCode).toContain('HARV-2026');
      expect(Number(res.body.data.netWeightKg)).toBe(14850.0);
      harvestBatchId = res.body.data.id;
    });

    it('Paso 3: [PATCH /v1/harvest-batches/:id/phyto-status] Dictamina estado fitosanitario APPROVED', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/v1/harvest-batches/${harvestBatchId}/phyto-status`)
        .set('Authorization', `Bearer ${enologistToken}`)
        .send({
          phytosanitaryStatus: PhytoStatusEnum.APPROVED,
          phytoInspectionPdfUrl:
            'https://storage.drinksonchain.com/inspections/phyto-potrero.pdf',
          notes: 'Aprobado sin presencia de botritis',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.phytosanitaryStatus).toBe(PhytoStatusEnum.APPROVED);
    });

    it('Paso 4: [POST /v1/fermentation-tanks] Registra cuba de fermentación de vino base', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/fermentation-tanks')
        .set('Authorization', `Bearer ${enologistToken}`)
        .send({
          harvestBatchId,
          tankCode: 'TK-03',
          capacityLiters: 15000.0,
          material: 'Acero Inoxidable AISI 316',
          volumeFilledLiters: 10100.0,
          destinationType: DestinationTypeEnum.SINGANI_DIST,
          startDate: '2026-03-15T14:30:00Z',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.tankCode).toBe('TK-03');
      fermentationTankId = res.body.data.id;
    });

    it('Paso 5: [POST /v1/fermentation-tanks/:id/logs] y [POST /v1/fermentation-tanks/:id/treatments]', async () => {
      const logRes = await request(app.getHttpServer())
        .post(`/v1/fermentation-tanks/${fermentationTankId}/logs`)
        .set('Authorization', `Bearer ${enologistToken}`)
        .send({
          temperatureCelsius: 15.2,
          specificGravity: 1.045,
          phValue: 3.42,
          co2Observations: 'Fermentación activa controlada a 15°C',
          recordedAt: '2026-03-16T08:00:00Z',
        });
      expect(logRes.status).toBe(201);

      const treatRes = await request(app.getHttpServer())
        .post(`/v1/fermentation-tanks/${fermentationTankId}/treatments`)
        .set('Authorization', `Bearer ${enologistToken}`)
        .send({
          treatmentType: TreatmentTypeEnum.SO2_ADDITION,
          additiveName: 'Metabisulfito de potasio',
          dosageAppliedGPerHl: 30.0,
          regulatoryAuthCode: 'SENASAG-REG-2024-88',
          appliedAt: '2026-03-15T15:00:00Z',
        });
      expect(treatRes.status).toBe(201);
    });

    it('Paso 6: [POST /v1/production-batches/distillation] Registra destilación con cortes de alambique', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/production-batches/distillation')
        .set('Authorization', `Bearer ${enologistToken}`)
        .send({
          fermentationTankId,
          equipmentIdentifier: 'Alambique de Cobre Charentais AL-01',
          processStartDate: '2026-04-01',
          processEndDate: '2026-04-03',
          inputVolumeLiters: 10000.0,
          outputVolumeLiters: 1750.0,
          wasteVolumeLiters: 570.0,
          initialAlcoholPercentage: 70.2,
          isDoEligible: true,
          additionalParams: {
            headDiscardLiters: 120,
            heartYieldLiters: 1750,
            tailDiscardLiters: 450,
          },
        });

      expect(res.status).toBe(201);
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.restStatus).toBe('RESTING');
      expect(res.body.data.mandatoryRestUntil).toBeDefined();
      distillationBatchId = res.body.data.id;
    });

    it('Paso 7: [POST /v1/bottling] Bloquea embotellado prematuro (<180 días de reposo inerte)', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/bottling')
        .set('Authorization', `Bearer ${enologistToken}`)
        .send({
          productionBatchId: distillationBatchId,
          productType: BeverageTypeEnum.SINGANI,
          finalAlcoholAbv: 40.0,
          totalBottlesPackaged: 4080,
          packagingFormatCl: 75,
          bottlingDate: '2026-04-05',
        });

      expect(res.status).toBe(422);
      expect(res.body.error.message).toContain('180 días');
    });

    it('Paso 8 & 9: [POST /v1/bottling] Embotella exitosamente tras cumplir reposo inerte', async () => {
      // Simular cumplimiento de 180 días actualizando processEndDate en la BD
      const oldEndDate = new Date();
      oldEndDate.setDate(oldEndDate.getDate() - 190);
      await prisma.productionBatch.update({
        where: { id: distillationBatchId },
        data: { processEndDate: oldEndDate },
      });

      const res = await request(app.getHttpServer())
        .post('/v1/bottling')
        .set('Authorization', `Bearer ${enologistToken}`)
        .send({
          productionBatchId: distillationBatchId,
          productType: BeverageTypeEnum.SINGANI,
          finalAlcoholAbv: 40.0,
          waterDilutionLiters: 1321.0,
          totalBottlesPackaged: 4080,
          packagingFormatCl: 75,
          bottleType: 'Vidrio Extra-Flint 750ml',
          labelDesignUrl:
            'https://storage.drinksonchain.com/labels/singani-anniversary.png',
          bottlingDate: '2026-10-01',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.internationalLotCode).toContain('SINGANI');
      expect(res.body.data.qrBatchUrl).toBeDefined();
      expect(res.body.data.blockchainDataHash).toBeDefined();
      bottlingBatchId = res.body.data.id;
    });

    it('Paso 10: [POST /v1/lab-analyses] Certificación físico-química de laboratorio oficial', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/lab-analyses')
        .set('Authorization', `Bearer ${enologistToken}`)
        .send({
          bottlingBatchId,
          certifiedLaboratoryName:
            'Laboratorio de Servicios Analíticos ISO 17025',
          accreditedLabCertificationCode: 'LAB-SENASAG-2026-991',
          analysisRequestDate: '2026-10-02',
          testPerformedAt: '2026-10-04',
          actualAlcoholAbv: 40.05,
          totalAcidityTartaricGl: 4.8,
          volatileAcidityAceticGl: 0.22,
          methanolContentMgL: 48.0,
          copperContentMgL: 0.02,
          laboratoryReportPdfUrl:
            'https://storage.drinksonchain.com/certs/lab-report-991.pdf',
          conformsToSenasagStandards: true,
        });

      expect(res.status).toBe(201);
      expect(res.body.data.conformsToSenasagStandards).toBe(true);
      expect(Number(res.body.data.methanolContentMgL)).toBe(48.0);
    });

    it('Paso 11: [GET /v1/traceability/dag/:id] Reconstruye el grafo DAG completo de 5 etapas', async () => {
      const res = await request(app.getHttpServer())
        .get(`/v1/traceability/dag/${bottlingBatchId}`)
        .set('Authorization', `Bearer ${enologistToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.productType).toBe('SINGANI');
      expect(res.body.data.nodes).toHaveLength(5);

      // Verificar encadenamiento de nodos
      const [plotNode, harvestNode, vinifNode, distNode, bottleNode] =
        res.body.data.nodes;
      expect(plotNode.stageName).toBe('Plot');
      expect(harvestNode.stageName).toBe('Harvest');
      expect(harvestNode.parents).toContain(plotNode.batchId);
      expect(vinifNode.stageName).toBe('Vinification');
      expect(vinifNode.parents).toContain(harvestNode.batchId);
      expect(distNode.stageName).toBe('Distillation');
      expect(distNode.parents).toContain(vinifNode.batchId);
      expect(bottleNode.stageName).toBe('Bottling');
      expect(bottleNode.parents).toContain(distNode.batchId);
      expect(bottleNode.isCertified).toBe(true);
    });
  });

  // ===========================================================================
  // FLUJO 2: VINO GRAN RESERVA CON CRIANZA EN BARRICA (VALLE DE CINTI)
  // ===========================================================================
  describe('Flujo Completo Vino Gran Reserva (Valle de Cinti)', () => {
    let wineTerroirId: string;
    let wineHarvestId: string;
    let wineTankId: string;
    let agingBatchId: string;
    let wineBottlingId: string;

    it('Paso 1: Registra parcela de Cabernet Sauvignon a 2,000 msnm', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/terroirs')
        .set('Authorization', `Bearer ${agronomistToken}`)
        .send({
          parcelName: 'Parcela Los Crespones - Valle de Cinti',
          cadastreCode: 'CAT-CINTI-102',
          surfaceHectares: 3.2,
          altitudeMasl: 2000.0,
          latitude: -20.654,
          longitude: -65.231,
          rawMaterialType: 'uva',
          varietyName: 'Cabernet Sauvignon',
          isDoEligible: true,
          doType: 'Valles Altos de Bolivia',
        });

      expect(res.status).toBe(201);
      wineTerroirId = res.body.data.id;
    });

    it('Paso 2: Vendimia y aprobación fitosanitaria', async () => {
      const harvRes = await request(app.getHttpServer())
        .post('/v1/harvest-batches')
        .set('Authorization', `Bearer ${agronomistToken}`)
        .send({
          terroirId: wineTerroirId,
          intakeDate: '2026-03-20',
          harvestYear: 2026,
          grossWeightKg: 8500.0,
          tareWeightKg: 100.0,
          brixDegrees: 24.5,
          initialPh: 3.6,
          initialAcidityGl: 5.8,
        });

      expect(harvRes.status).toBe(201);
      wineHarvestId = harvRes.body.data.id;

      const phytoRes = await request(app.getHttpServer())
        .patch(`/v1/harvest-batches/${wineHarvestId}/phyto-status`)
        .set('Authorization', `Bearer ${enologistToken}`)
        .send({
          phytosanitaryStatus: PhytoStatusEnum.APPROVED,
          notes: 'Uva tinta sana para Gran Reserva',
        });
      expect(phytoRes.status).toBe(200);
    });

    it('Paso 3: Fermentación de vino tinto', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/fermentation-tanks')
        .set('Authorization', `Bearer ${enologistToken}`)
        .send({
          harvestBatchId: wineHarvestId,
          tankCode: 'TK-RED-01',
          capacityLiters: 10000.0,
          material: 'Acero Inoxidable',
          volumeFilledLiters: 5800.0,
          destinationType: DestinationTypeEnum.WINE_AGING,
          startDate: '2026-03-21T10:00:00Z',
        });

      expect(res.status).toBe(201);
      wineTankId = res.body.data.id;
    });

    it('Paso 4: [POST /v1/wine-aging] Traslado a barricas de roble francés (12 meses)', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/wine-aging')
        .set('Authorization', `Bearer ${enologistToken}`)
        .send({
          fermentationTankId: wineTankId,
          containerType: 'Barrica',
          containerMaterial: 'Roble Francés Grano Fino',
          containerCode: 'BAR-FR-012',
          barrelUseCycle: 1,
          volumeLiters: 225.0,
          plannedMonths: 12,
          notes: 'Cava Subterránea Bóveda 1',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.containerCode).toBe('BAR-FR-012');
      agingBatchId = res.body.data.id;
    });

    it('Paso 5: Bloquea embotellado prematuro de barrica con bloqueo activo', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/bottling')
        .set('Authorization', `Bearer ${enologistToken}`)
        .send({
          wineAgingBatchId: agingBatchId,
          productType: BeverageTypeEnum.WINE,
          finalAlcoholAbv: 14.2,
          totalBottlesPackaged: 300,
          packagingFormatCl: 75,
          bottlingDate: '2026-05-01',
        });

      expect(res.status).toBe(422);
      expect(res.body.error.message).toContain('bloqueado');
    });

    it('Paso 6: Embotella exitosamente tras liberar guarda de crianza', async () => {
      const pastLockDate = new Date();
      pastLockDate.setMonth(pastLockDate.getMonth() - 1);
      await prisma.wineAgingBatch.update({
        where: { id: agingBatchId },
        data: { lockUntilDate: pastLockDate },
      });

      const res = await request(app.getHttpServer())
        .post('/v1/bottling')
        .set('Authorization', `Bearer ${enologistToken}`)
        .send({
          wineAgingBatchId: agingBatchId,
          productType: BeverageTypeEnum.WINE,
          finalAlcoholAbv: 14.2,
          totalBottlesPackaged: 300,
          packagingFormatCl: 75,
          bottleType: 'Bordelesa Cónica Verde Antiguo',
          bottlingDate: '2027-04-15',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.internationalLotCode).toContain('WINE');
      wineBottlingId = res.body.data.id;
    });

    it('Paso 7: Reconstruye DAG de Vino Criado en Barrica', async () => {
      const res = await request(app.getHttpServer())
        .get(`/v1/traceability/dag/${wineBottlingId}`)
        .set('Authorization', `Bearer ${enologistToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.productType).toBe('WINE');
      expect(res.body.data.nodes).toHaveLength(5);
      const stageNames = res.body.data.nodes.map(
        (n: { stageName: string }) => n.stageName,
      );
      expect(stageNames).toEqual([
        'Plot',
        'Harvest',
        'Vinification',
        'Aging',
        'Bottling',
      ]);
    });
  });

  // ===========================================================================
  // FLUJO 3: SEGURIDAD, VALIDACIONES D.O. Y AISLAMIENTO MULTI-TENANT
  // ===========================================================================
  describe('Validaciones de Negocio D.O. y Aislamiento Multi-Tenant', () => {
    it('Rechaza producción de Singani si la uva proviene de <1,600 msnm', async () => {
      // Parcela a baja altitud
      const lowTerroir = await prisma.terroir.create({
        data: {
          wineryId,
          parcelName: 'Parcela Santa Cruz Llanuras',
          cadastreCode: 'CAT-SC-01',
          surfaceHectares: 2.0,
          altitudeMasl: 400.0,
          rawMaterialType: 'uva',
          varietyName: 'Moscatel de Alejandría',
          isDoEligible: false,
        },
      });

      const lowHarvest = await prisma.harvestBatch.create({
        data: {
          wineryId,
          terroirId: lowTerroir.id,
          harvestBatchCode: `HARV-LOW-${timestamp}`,
          intakeDate: new Date(),
          harvestYear: 2026,
          grossWeightKg: 1000,
          tareWeightKg: 10,
          netWeightKg: 990,
          brixDegrees: 22.0,
          initialPh: 3.4,
          initialAcidityGl: 6.5,
          phytosanitaryStatus: PhytoStatusEnum.APPROVED,
        },
      });

      const lowTank = await prisma.fermentationTank.create({
        data: {
          wineryId,
          harvestBatchId: lowHarvest.id,
          tankCode: 'TK-LOW-01',
          capacityLiters: 1000,
          material: 'Inox',
          volumeFilledLiters: 800,
          destinationType: DestinationTypeEnum.SINGANI_DIST,
          startDate: new Date(),
        },
      });

      const res = await request(app.getHttpServer())
        .post('/v1/production-batches/distillation')
        .set('Authorization', `Bearer ${enologistToken}`)
        .send({
          fermentationTankId: lowTank.id,
          equipmentIdentifier: 'Alambique 01',
          processStartDate: '2026-04-01',
          inputVolumeLiters: 800.0,
          outputVolumeLiters: 120.0,
          initialAlcoholPercentage: 70.0,
          isDoEligible: true,
        });

      expect(res.status).toBe(422);
      expect(res.body.error.message).toContain('1,600');
    });

    it('Bodega 2 no puede crear vendimia usando una parcela de Bodega 1', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/harvest-batches')
        .set('Authorization', `Bearer ${winery2AdminToken}`)
        .send({
          terroirId, // Parcela de Bodega 1
          intakeDate: '2026-03-15',
          harvestYear: 2026,
          grossWeightKg: 5000.0,
          tareWeightKg: 50.0,
          brixDegrees: 22.0,
          initialPh: 3.4,
          initialAcidityGl: 6.5,
        });

      expect(res.status).toBe(404);
    });

    it('Bodega 2 no puede acceder a cubas de fermentación de Bodega 1', async () => {
      const res = await request(app.getHttpServer())
        .get(`/v1/fermentation-tanks/${fermentationTankId}`)
        .set('Authorization', `Bearer ${winery2AdminToken}`);

      expect(res.status).toBe(404);
    });
  });
});
