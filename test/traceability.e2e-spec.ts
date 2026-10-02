import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { configureApp } from '../src/app.setup';
import { deleteIdentityData } from './helpers/identity';
import { addWineryMember, wineryWithOwner } from './helpers/staff-session';
import { deleteTraceabilityData } from './helpers/traceability-cleanup';
import {
  WineryCategoryEnum,
  WineryMemberRoleEnum,
  BeverageTypeEnum,
  PhytoStatusEnum,
  DestinationTypeEnum,
  TreatmentTypeEnum,
} from '@prisma/client';

/** Día de calendario de hace `n` días (fechas pasadas: ninguna puede ser futura). */
function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

describe('Traceability ERP & Strategy Pattern (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const timestamp = Date.now();
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

    // Misma configuración que main.ts (versionado, validación 422, envoltorio)
    configureApp(app);

    await app.init();
    prisma = app.get<PrismaService>(PrismaService);

    const login = async (email: string) =>
      (
        await request(app.getHttpServer())
          .post('/v1/auth/login')
          .send({ email, password: 'Password123!' })
          .expect(200)
      ).body.data.tokens.accessToken as string;

    // 1. Bodega 1 (destilería) activa con su dueño: desde H1, alta +
    // invitación aceptada (el ERP exige la bodega ACTIVE, SE-05)
    wineryId = (
      await wineryWithOwner(app, {
        name: `Casa Real ${timestamp}`,
        taxId: `NIT-${timestamp.toString().slice(-8)}`,
        email: `winery_admin_${timestamp}@singani.bo`,
        password: 'Password123!',
        fullName: 'Winery Admin Singani',
        category: WineryCategoryEnum.DISTILLERY,
        region: 'San Lorenzo, Tarija',
      })
    ).wineryId;

    // 2. Agrónomo y enólogo de la Bodega 1 (equipo por invitación desde H1)
    await addWineryMember(app, {
      wineryId,
      role: WineryMemberRoleEnum.AGRONOMIST,
      email: `agronomist_${timestamp}@singani.bo`,
      password: 'Password123!',
      fullName: 'Ing. Carlos Mendoza',
      professionalLicenseNumber: 'AGRO-TAR-2024',
    });
    agronomistToken = await login(`agronomist_${timestamp}@singani.bo`);
    await addWineryMember(app, {
      wineryId,
      role: WineryMemberRoleEnum.ENOLOGIST,
      email: `enologist_${timestamp}@singani.bo`,
      password: 'Password123!',
      fullName: 'Lic. Valeria Soliz',
      professionalLicenseNumber: 'ENOL-TAR-901',
    });
    enologistToken = await login(`enologist_${timestamp}@singani.bo`);

    // 3. Bodega 2 (para pruebas de aislamiento multi-tenant)
    winery2Id = (
      await wineryWithOwner(app, {
        name: `Vinos Cinti ${timestamp}`,
        taxId: `NIT2-${timestamp.toString().slice(-7)}`,
        email: `winery2_admin_${timestamp}@other.bo`,
        password: 'Password123!',
        fullName: 'Winery 2 Admin',
        region: 'Camargo, Chuquisaca',
      })
    ).wineryId;
    winery2AdminToken = await login(`winery2_admin_${timestamp}@other.bo`);
  });

  afterAll(async () => {
    if (prisma) {
      const activeWineryIds = [wineryId, winery2Id].filter(Boolean);
      await deleteIdentityData(prisma, {
        emailContains: `${timestamp}`,
        wineryIds: activeWineryIds,
      });
      if (activeWineryIds.length > 0) {
        await deleteTraceabilityData(prisma, activeWineryIds);
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
          varietyName: 'Moscatel de Alejandría',
          isDoEligible: true,
          doType: 'D.O. Singani',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.parcelName).toBe('Cuartel 4 - La Finca El Potrero');
      expect(res.body.data.altitudeMasl).toBe(1850);
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
      expect(res.body.data.netWeightKg).toBe(14850);
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
          // Fechas relativas a hoy: con fechas fijas el reposo de 180 días se
          // cumple solo con el paso del calendario y el Paso 7 deja de probar nada.
          processStartDate: daysAgo(12),
          processEndDate: daysAgo(10),
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
          bottlingDate: daysAgo(0),
        });

      expect(res.status).toBe(422);
      expect(res.body.error.message).toContain('180 días');
      const codes = res.body.error.details.map((d: { code: string }) => d.code);
      expect(codes).toContain('TRC_LOCK_NOT_RELEASED');
    });

    it('Paso 8 & 9: [POST /v1/bottling] Embotella exitosamente tras cumplir reposo inerte', async () => {
      // Simular cumplimiento de 180 días moviendo la destilación al pasado
      await prisma.productionBatch.update({
        where: { id: distillationBatchId },
        data: {
          processStartDate: new Date(`${daysAgo(192)}T00:00:00Z`),
          processEndDate: new Date(`${daysAgo(190)}T00:00:00Z`),
          mandatoryRestUntil: new Date(`${daysAgo(10)}T00:00:00Z`),
        },
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
          bottlingDate: daysAgo(2),
        });

      expect(res.status).toBe(201);
      expect(res.body.data.lotId).toBeDefined();
      expect(res.body.data.bottleCodes).toMatchObject({
        total: 4080,
        active: 4080,
      });
      expect(res.body.data.balance).toMatchObject({ bottledLiters: 3060 });
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
          analysisRequestDate: daysAgo(2),
          testPerformedAt: daysAgo(1),
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
      expect(res.body.data.methanolContentMgL).toBe(48);
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
      // EA-05: certificado = expediente cerrado (aún no); sin métricas inventadas
      expect(bottleNode.isCertified).toBe(false);
      expect(vinifNode.metrics).toEqual([]);
      expect(distNode.metrics).toEqual([7020]);
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
      const codes = res.body.error.details.map((d: { code: string }) => d.code);
      expect(codes).toContain('TRC_LOCK_NOT_RELEASED');
    });

    it('Paso 6: Embotella exitosamente tras liberar guarda de crianza', async () => {
      // Simular 13 meses de crianza: inicio y candado en el pasado
      await prisma.wineAgingBatch.update({
        where: { id: agingBatchId },
        data: {
          startDate: new Date(`${daysAgo(400)}T00:00:00Z`),
          lockUntilDate: new Date(`${daysAgo(30)}T00:00:00Z`),
        },
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
          bottlingDate: daysAgo(1),
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
      expect(res.body.error.code).toBe('TRC_DO_NOT_ELIGIBLE');
      expect(res.body.error.details[0]).toMatchObject({
        code: 'TRC_DO_NOT_ELIGIBLE',
        rule: 'trazabilidad.singani.altitudMinimaMsnm',
        expected: 1600,
        actual: 400,
      });
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
