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
  TreatmentTypeEnum,
} from '@prisma/client';
import { resetLoopbackLoginLocks } from './helpers/login-locks';
import { sha256Of, TEST_PDF, uploadTraceFile } from './helpers/trace-files';

/** Día de calendario de hace `n` días (fechas pasadas: ninguna puede ser futura). */
function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

interface Detail {
  code?: string;
  field?: string | null;
  rule?: string;
  expected?: unknown;
  actual?: unknown;
  meta?: Record<string, unknown>;
}
const codes = (res: request.Response): (string | undefined)[] =>
  (res.body.error.details as Detail[]).map((d) => d.code);
/** Campos rechazados (sin repetir: un campo puede fallar varias validaciones). */
const fields = (res: request.Response): (string | null | undefined)[] =>
  [...new Set((res.body.error.details as Detail[]).map((d) => d.field))].sort();

/**
 * Recorrido del ERP por las rutas vigentes tras el cierre H2 (contrato O2
 * §16.2): pesaje con `maturity`, dictamen aparte, tanque con `inputs`,
 * fermentación completada con su destino, crianza o destilación (abierta y
 * cerrada con cortes tipados), embotellado y laboratorio del **lote**, y el
 * grafo del lote. Las rutas y los campos legados ya no existen.
 */
describe('Trazabilidad del ERP: vino y singani de la parcela a la botella (e2e)', () => {
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
  let singaniLotId: string;

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    post: (path: string, body?: object) =>
      http()
        .post(path)
        .set('Authorization', `Bearer ${token}`)
        .send(body ?? {}),
    get: (path: string) =>
      http().get(path).set('Authorization', `Bearer ${token}`),
    patch: (path: string, body?: object) =>
      http()
        .patch(path)
        .set('Authorization', `Bearer ${token}`)
        .send(body ?? {}),
  });

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();

    // Misma configuración que main.ts (versionado, validación 422, envoltorio)
    configureApp(app);

    await app.init();

    await resetLoopbackLoginLocks(app);
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
  describe('Flujo completo singani D.O. (San Lorenzo, Tarija · 1.850 msnm)', () => {
    it('Paso 1: [POST /v1/terroirs] parcela a 1.850 msnm con Moscatel de Alejandría: D.O. calculada', async () => {
      const res = await as(agronomistToken).post('/v1/terroirs', {
        parcelName: 'Cuartel 4 - La Finca El Potrero',
        cadastreCode: 'CAT-TL-4022',
        surfaceHectares: 4.5,
        altitudeMasl: 1850.0,
        latitude: -21.48512,
        longitude: -64.78921,
        rawMaterialType: 'uva',
        varietyName: 'Moscatel de Alejandría',
        doType: 'D.O. Singani',
      });

      expect(res.status).toBe(201);
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.parcelName).toBe('Cuartel 4 - La Finca El Potrero');
      expect(res.body.data.altitudeMasl).toBe(1850);
      // La aptitud D.O. la calcula el servidor: ya no es un campo de la entrada
      expect(res.body.data.isDoEligible).toBe(true);
      terroirId = res.body.data.id;

      const declared = await as(agronomistToken).post('/v1/terroirs', {
        parcelName: 'Parcela con D.O. declarada',
        surfaceHectares: 1,
        altitudeMasl: 400,
        rawMaterialType: 'uva',
        varietyName: 'Moscatel de Alejandría',
        isDoEligible: true,
      });
      expect(declared.status).toBe(422);
      expect(declared.body.error.code).toBe('VALIDATION_ERROR');
      expect(declared.body.error.details[0].field).toBe('isDoEligible');
    });

    it('Paso 2: [POST /v1/harvest-batches] pesaje con peso neto y análisis de madurez (`maturity`)', async () => {
      const body = {
        terroirId,
        intakeDate: daysAgo(260),
        grossWeightKg: 15000.0,
        tareWeightKg: 150.0,
        temperatureAtIntakeC: 16.5,
        notes: 'Uva fresca en excelente estado sanitario',
      };
      // Sin dictamen en el alta (EA-04): el campo no existe y enviarlo, con
      // cualquier valor, es el intento que el contrato rechaza con su código
      for (const phytosanitaryStatus of ['APPROVED', 'PENDING_INSPECTION']) {
        const selfApproved = await as(agronomistToken).post(
          '/v1/harvest-batches',
          { ...body, phytosanitaryStatus },
        );
        expect(selfApproved.status).toBe(422);
        expect(selfApproved.body.error.code).toBe('TRC_PHYTO_IN_CREATE');
      }
      // Brix, pH y acidez planos (compatibilidad retirada en H2)
      const flat = await as(agronomistToken).post('/v1/harvest-batches', {
        ...body,
        brixDegrees: 22.4,
        initialPh: 3.45,
        initialAcidityGl: 6.8,
      });
      expect(flat.status).toBe(422);
      expect(flat.body.error.code).toBe('VALIDATION_ERROR');
      expect(fields(flat)).toEqual([
        'brixDegrees',
        'initialAcidityGl',
        'initialPh',
      ]);

      const res = await as(agronomistToken).post('/v1/harvest-batches', {
        ...body,
        maturity: { brixDegrees: 22.4, ph: 3.45, acidityGl: 6.8 },
      });

      expect(res.status).toBe(201);
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.harvestBatchCode).toContain('HARV-');
      expect(res.body.data.netWeightKg).toBe(14850);
      expect(res.body.data).toMatchObject({
        phytosanitaryStatus: 'PENDING_INSPECTION',
        brixDegrees: 22.4,
        initialPh: 3.45,
        initialAcidityGl: 6.8,
        lotId: null,
      });
      harvestBatchId = res.body.data.id;
    });

    it('Paso 3: [POST /v1/harvest-batches/:id/phyto-decisions] dictamen APPROVED con su informe (key y huella)', async () => {
      const key = await uploadTraceFile(app, enologistToken, {
        folder: 'inspections',
      });
      const res = await as(enologistToken).post(
        `/v1/harvest-batches/${harvestBatchId}/phyto-decisions`,
        {
          decision: 'APPROVED',
          inspectionReportKey: key,
          notes: 'Aprobado sin presencia de botritis',
        },
      );

      expect(res.status).toBe(201);
      expect(res.body.data.phytosanitaryStatus).toBe('APPROVED');
      expect(res.body.data.phytoDecisions).toHaveLength(1);
      expect(res.body.data.phytoDecisions[0].inspectionReport).toMatchObject({
        key,
        sha256: sha256Of(TEST_PDF),
      });

      // La ruta legada del dictamen ya no existe
      const legacy = await as(enologistToken).patch(
        `/v1/harvest-batches/${harvestBatchId}/phyto-status`,
        { phytosanitaryStatus: 'APPROVED' },
      );
      expect(legacy.status).toBe(404);
    });

    it('Paso 4: [POST /v1/fermentation-tanks] tanque de vino base con sus entradas (`inputs`)', async () => {
      const tank = {
        tankCode: 'TK-03',
        capacityLiters: 15000.0,
        material: 'Acero Inoxidable AISI 316',
        volumeFilledLiters: 10100.0,
        destinationType: 'SINGANI_DIST',
        startDate: `${daysAgo(259)}T14:30:00Z`,
      };
      // `harvestBatchId` único (legado) y un tanque sin volumen de mosto
      const legacy = await as(enologistToken).post('/v1/fermentation-tanks', {
        ...tank,
        harvestBatchId,
      });
      expect(legacy.status).toBe(422);
      expect(fields(legacy)).toEqual(['harvestBatchId', 'inputs']);
      const noVolume = await as(enologistToken).post('/v1/fermentation-tanks', {
        ...tank,
        volumeFilledLiters: undefined,
        inputs: [{ harvestBatchId }],
      });
      expect(noVolume.status).toBe(422);
      expect(noVolume.body.error.details[0].field).toBe('volumeFilledLiters');

      const res = await as(enologistToken).post('/v1/fermentation-tanks', {
        ...tank,
        inputs: [{ harvestBatchId }],
      });

      expect(res.status).toBe(201);
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.tankCode).toBe('TK-03');
      expect(res.body.data.status).toBe('FILLING');
      // Uva sin lote: el servidor crea el lote del tanque
      expect(res.body.data.lotId).toBeDefined();
      fermentationTankId = res.body.data.id;
      singaniLotId = res.body.data.lotId;
    });

    it('Paso 5: lecturas, tratamiento y fermentación completada con destino singani', async () => {
      const path = `/v1/fermentation-tanks/${fermentationTankId}`;
      const started = await as(enologistToken).post(`${path}/start`, {
        startedAt: `${daysAgo(258)}T08:00:00Z`,
      });
      expect(started.status).toBe(200);
      expect(started.body.data.status).toBe('FERMENTING');

      const logRes = await as(enologistToken).post(`${path}/logs`, {
        temperatureCelsius: 15.2,
        specificGravity: 1.045,
        phValue: 3.42,
        co2Observations: 'Fermentación activa controlada a 15°C',
        recordedAt: `${daysAgo(257)}T08:00:00Z`,
      });
      expect(logRes.status).toBe(201);

      const treatRes = await as(enologistToken).post(`${path}/treatments`, {
        treatmentType: TreatmentTypeEnum.SO2_ADDITION,
        additiveName: 'Metabisulfito de potasio',
        dosageAppliedGPerHl: 30.0,
        regulatoryAuthCode: 'SENASAG-REG-2024-88',
        appliedAt: `${daysAgo(258)}T15:00:00Z`,
      });
      expect(treatRes.status).toBe(201);

      // Un tanque sin completar no es origen de una destilación (H2: sin la
      // tolerancia del flujo anterior a las transiciones)
      const early = await as(enologistToken).post(
        '/v1/production-batches/distillation',
        {
          fermentationTankId,
          equipmentIdentifier: 'Alambique de Cobre Charentais AL-01',
          processStartDate: daysAgo(200),
          inputVolumeLiters: 10000.0,
        },
      );
      expect(early.status).toBe(409);
      expect(early.body.error.code).toBe('TRC_TANK_NOT_COMPLETED');
      expect(early.body.error.details[0].meta).toMatchObject({
        status: 'FERMENTING',
      });

      const completed = await as(enologistToken).post(`${path}/complete`, {
        endDate: daysAgo(240),
        finalVolumeLiters: 10000.0,
        destination: 'SINGANI_DIST',
      });
      expect(completed.status).toBe(200);
      expect(completed.body.data).toMatchObject({
        status: 'COMPLETED',
        destinationType: 'SINGANI_DIST',
        availableLiters: 10000,
      });
    });

    it('Paso 6: [POST /v1/production-batches/distillation] abre la destilación y `…/close` la cierra con cortes tipados', async () => {
      const open = {
        fermentationTankId,
        equipmentIdentifier: 'Alambique de Cobre Charentais AL-01',
        // Fechas relativas a hoy: con fechas fijas el reposo de 180 días se
        // cumple solo con el paso del calendario y el Paso 7 deja de probar nada.
        processStartDate: daysAgo(12),
        inputVolumeLiters: 10000.0,
      };
      // El cuerpo legado (fin, salida, cortes en `additionalParams`, D.O.) ya no existe
      const legacy = await as(enologistToken).post(
        '/v1/production-batches/distillation',
        {
          ...open,
          processEndDate: daysAgo(10),
          outputVolumeLiters: 1750.0,
          wasteVolumeLiters: 570.0,
          isDoEligible: true,
          additionalParams: { headDiscardLiters: 120, heartYieldLiters: 1750 },
        },
      );
      expect(legacy.status).toBe(422);
      expect(fields(legacy)).toEqual([
        'additionalParams',
        'isDoEligible',
        'outputVolumeLiters',
        'processEndDate',
        'wasteVolumeLiters',
      ]);
      const noInput = await as(enologistToken).post(
        '/v1/production-batches/distillation',
        { ...open, inputVolumeLiters: undefined },
      );
      expect(noInput.status).toBe(422);
      expect(noInput.body.error.details[0].field).toBe('inputVolumeLiters');

      const res = await as(enologistToken).post(
        '/v1/production-batches/distillation',
        open,
      );
      expect(res.status).toBe(201);
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data).toMatchObject({
        lotId: singaniLotId,
        processEndDate: null,
        restStatus: 'NOT_REQUIRED',
        mandatoryRestUntil: null,
      });
      distillationBatchId = res.body.data.id;
      // Toda la entrada salió del tanque: pasa a TRANSFERRED
      const tank = await as(enologistToken).get(
        `/v1/fermentation-tanks/${fermentationTankId}`,
      );
      expect(tank.body.data.status).toBe('TRANSFERRED');

      const closed = await as(enologistToken).post(
        `/v1/production-batches/${distillationBatchId}/close`,
        {
          processEndDate: daysAgo(10),
          cuts: { headsLiters: 120, heartLiters: 1750, tailsLiters: 450 },
          heartAbvPercent: 70.2,
        },
      );
      expect(closed.status).toBe(200);
      expect(closed.body.data.restStatus).toBe('RESTING');
      expect(closed.body.data.mandatoryRestUntil).toBeDefined();
      expect(closed.body.data).toMatchObject({
        headsLiters: 120,
        heartLiters: 1750,
        tailsLiters: 450,
        heartAbvPercent: 70.2,
      });
    });

    it('Paso 7: [POST /v1/lots/:id/bottling] bloquea el embotellado prematuro (<180 días de reposo)', async () => {
      const res = await as(enologistToken).post(
        `/v1/lots/${singaniLotId}/bottling`,
        {
          finalAlcoholAbv: 40.0,
          totalBottlesPackaged: 4080,
          packagingFormatCl: 75,
          bottlingDate: daysAgo(1),
        },
      );

      expect(res.status).toBe(422);
      expect(res.body.error.message).toContain('180 días');
      expect(codes(res)).toContain('TRC_LOCK_NOT_RELEASED');

      // La ruta legada del embotellado ya no existe
      const legacy = await as(enologistToken).post('/v1/bottling', {
        productionBatchId: distillationBatchId,
        productType: 'SINGANI',
        finalAlcoholAbv: 40.0,
        totalBottlesPackaged: 4080,
        packagingFormatCl: 75,
        bottlingDate: daysAgo(1),
      });
      expect(legacy.status).toBe(404);
    });

    it('Paso 8 y 9: embotella tras cumplir el reposo y registra el laboratorio del lote', async () => {
      // Simular el cumplimiento de los 180 días moviendo la destilación al pasado
      await prisma.productionBatch.update({
        where: { id: distillationBatchId },
        data: {
          processStartDate: new Date(`${daysAgo(192)}T00:00:00Z`),
          processEndDate: new Date(`${daysAgo(190)}T00:00:00Z`),
          mandatoryRestUntil: new Date(`${daysAgo(10)}T00:00:00Z`),
        },
      });

      const bottling = {
        finalAlcoholAbv: 40.0,
        waterDilutionLiters: 1321.0,
        totalBottlesPackaged: 4080,
        packagingFormatCl: 75,
        bottleType: 'Vidrio Extra-Flint 750ml',
        bottlingDate: daysAgo(2),
      };
      // La etiqueta va por su `key`: la URL (alias hasta H2) ya no es un campo
      const withUrl = await as(enologistToken).post(
        `/v1/lots/${singaniLotId}/bottling`,
        {
          ...bottling,
          labelDesignUrl:
            'https://storage.drinksonchain.com/labels/singani-anniversary.png',
        },
      );
      expect(withUrl.status).toBe(422);
      expect(withUrl.body.error.details[0].field).toBe('labelDesignUrl');

      const res = await as(enologistToken).post(
        `/v1/lots/${singaniLotId}/bottling`,
        bottling,
      );

      expect(res.status).toBe(201);
      expect(res.body.data.lotId).toBe(singaniLotId);
      expect(res.body.data.bottleCodes).toMatchObject({
        total: 4080,
        active: 4080,
      });
      expect(res.body.data.balance).toMatchObject({ bottledLiters: 3060 });
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.internationalLotCode).toContain('SINGANI');
      expect(res.body.data.productType).toBe('SINGANI');
      expect(res.body.data.qrBatchUrl).toBeDefined();
      // El hash que vale es el del expediente (§10)
      expect(res.body.data.blockchainDataHash).toBeNull();
      const bottlingBatchId = res.body.data.id as string;

      const lab = {
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
      };
      const path = `/v1/lots/${singaniLotId}/lab-analyses`;
      // El informe va por su `key`: sin ella, o con la URL legada, 422
      const noReport = await as(enologistToken).post(path, lab);
      expect(noReport.status).toBe(422);
      expect(noReport.body.error.details[0].field).toBe('laboratoryReportKey');
      const withReportUrl = await as(enologistToken).post(path, {
        ...lab,
        laboratoryReportKey: 'org/otra/lab/informe.pdf',
        laboratoryReportPdfUrl:
          'https://storage.drinksonchain.com/certs/lab-report-991.pdf',
        conformsToSenasagStandards: true,
      });
      expect(withReportUrl.status).toBe(422);
      expect(fields(withReportUrl)).toEqual([
        'conformsToSenasagStandards',
        'laboratoryReportPdfUrl',
      ]);

      const key = await uploadTraceFile(app, enologistToken);
      const labRes = await as(enologistToken).post(path, {
        ...lab,
        laboratoryReportKey: key,
      });
      expect(labRes.status).toBe(201);
      expect(labRes.body.data.conformsToSenasagStandards).toBe(true);
      expect(labRes.body.data.methanolContentMgL).toBe(48);
      expect(labRes.body.data).toMatchObject({
        lotId: singaniLotId,
        bottlingBatchId,
        conformityStatus: 'CONFORMING',
        // La huella del informe subido queda con el registro
        report: { key, sha256: sha256Of(TEST_PDF) },
      });

      // La ruta legada del laboratorio ya no existe; la lectura por embotellado sí
      const legacy = await as(enologistToken).post('/v1/lab-analyses', {
        ...lab,
        bottlingBatchId,
        laboratoryReportPdfUrl:
          'https://storage.drinksonchain.com/certs/lab-report-991.pdf',
      });
      expect(legacy.status).toBe(404);
      const current = await as(enologistToken).get(
        `/v1/lab-analyses/batch/${bottlingBatchId}`,
      );
      expect(current.status).toBe(200);
      expect(current.body.data.id).toBe(labRes.body.data.id);
    });

    it('Paso 10: [GET /v1/lots/:id/graph] reconstruye el grafo del lote con datos reales', async () => {
      const res = await as(enologistToken).get(
        `/v1/lots/${singaniLotId}/graph`,
      );

      expect(res.status).toBe(200);
      expect(res.body.data.productType).toBe('SINGANI');
      const types = (res.body.data.nodes as { type: string }[]).map(
        (n) => n.type,
      );
      expect(types).toEqual([
        'TERROIR',
        'HARVEST_BATCH',
        'TANK',
        'DISTILLATION',
        'BOTTLING',
        'LAB_ANALYSIS',
      ]);
      expect(res.body.data.edges).toHaveLength(5);

      // El grafo y el pasaporte legados ya no existen
      const bottling = await prisma.bottlingBatch.findFirstOrThrow({
        where: { lotId: singaniLotId },
      });
      const dag = await as(enologistToken).get(
        `/v1/traceability/dag/${bottling.id}`,
      );
      expect(dag.status).toBe(404);
      const legacyPassport = await http().get(
        `/v1/traceability/public/${bottling.internationalLotCode}`,
      );
      expect(legacyPassport.status).toBe(404);
      const passport = await http().get(
        `/v1/public/passports/${bottling.internationalLotCode}`,
      );
      expect(passport.status).toBe(200);
      expect(passport.body.data.lotCode).toBe(bottling.internationalLotCode);
    });
  });

  // ===========================================================================
  // FLUJO 2: VINO GRAN RESERVA CON CRIANZA EN BARRICA (VALLE DE CINTI)
  // ===========================================================================
  describe('Flujo completo vino gran reserva (Valle de Cinti)', () => {
    let wineTerroirId: string;
    let wineHarvestId: string;
    let wineTankId: string;
    let agingBatchId: string;
    let wineLotId: string;

    it('Paso 1: parcela de Cabernet Sauvignon a 2.000 msnm', async () => {
      const res = await as(agronomistToken).post('/v1/terroirs', {
        parcelName: 'Parcela Los Crespones - Valle de Cinti',
        cadastreCode: 'CAT-CINTI-102',
        surfaceHectares: 3.2,
        altitudeMasl: 2000.0,
        latitude: -20.654,
        longitude: -65.231,
        rawMaterialType: 'uva',
        varietyName: 'Cabernet Sauvignon',
        doType: 'Valles Altos de Bolivia',
      });

      expect(res.status).toBe(201);
      // No es la cepa de la D.O. Singani: no apta, sin que nadie lo declare
      expect(res.body.data.isDoEligible).toBe(false);
      wineTerroirId = res.body.data.id;
    });

    it('Paso 2: vendimia y dictamen fitosanitario', async () => {
      const harvRes = await as(agronomistToken).post('/v1/harvest-batches', {
        terroirId: wineTerroirId,
        intakeDate: daysAgo(460),
        grossWeightKg: 8500.0,
        tareWeightKg: 100.0,
        maturity: { brixDegrees: 24.5, ph: 3.6, acidityGl: 5.8 },
      });

      expect(harvRes.status).toBe(201);
      wineHarvestId = harvRes.body.data.id;

      const phytoRes = await as(enologistToken).post(
        `/v1/harvest-batches/${wineHarvestId}/phyto-decisions`,
        { decision: 'APPROVED', notes: 'Uva tinta sana para Gran Reserva' },
      );
      expect(phytoRes.status).toBe(201);
    });

    it('Paso 3: fermentación de vino tinto, completada con destino vino', async () => {
      const res = await as(enologistToken).post('/v1/fermentation-tanks', {
        inputs: [{ harvestBatchId: wineHarvestId }],
        tankCode: 'TK-RED-01',
        capacityLiters: 10000.0,
        material: 'Acero Inoxidable',
        volumeFilledLiters: 5800.0,
        startFermentation: true,
        startDate: `${daysAgo(459)}T10:00:00Z`,
      });

      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('FERMENTING');
      wineTankId = res.body.data.id;
      wineLotId = res.body.data.lotId;

      // Sin completar no hay crianza (H2: `TRC_TANK_NOT_COMPLETED` pleno)
      const early = await as(enologistToken).post('/v1/wine-aging', {
        fermentationTankId: wineTankId,
        containerType: 'Barrica',
        volumeLiters: 225.0,
        plannedMonths: 12,
      });
      expect(early.status).toBe(409);
      expect(early.body.error.code).toBe('TRC_TANK_NOT_COMPLETED');

      const completed = await as(enologistToken).post(
        `/v1/fermentation-tanks/${wineTankId}/complete`,
        {
          endDate: daysAgo(440),
          finalVolumeLiters: 5600.0,
          destination: 'WINE_AGING',
        },
      );
      expect(completed.status).toBe(200);
      expect(completed.body.data.status).toBe('COMPLETED');
    });

    it('Paso 4: [POST /v1/wine-aging] traslado a barricas de roble francés (12 meses)', async () => {
      const res = await as(enologistToken).post('/v1/wine-aging', {
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
      expect(res.body.data.lotId).toBe(wineLotId);
      agingBatchId = res.body.data.id;
    });

    it('Paso 5: bloquea el embotellado prematuro de la barrica con el candado activo', async () => {
      const res = await as(enologistToken).post(
        `/v1/lots/${wineLotId}/bottling`,
        {
          finalAlcoholAbv: 14.2,
          totalBottlesPackaged: 300,
          packagingFormatCl: 75,
          bottlingDate: daysAgo(1),
        },
      );

      expect(res.status).toBe(422);
      expect(codes(res)).toContain('TRC_LOCK_NOT_RELEASED');
    });

    it('Paso 6: embotella tras liberar la guarda de crianza', async () => {
      // Simular 13 meses de crianza: inicio y candado en el pasado
      await prisma.wineAgingBatch.update({
        where: { id: agingBatchId },
        data: {
          startDate: new Date(`${daysAgo(400)}T00:00:00Z`),
          lockUntilDate: new Date(`${daysAgo(30)}T00:00:00Z`),
        },
      });

      const res = await as(enologistToken).post(
        `/v1/lots/${wineLotId}/bottling`,
        {
          finalAlcoholAbv: 14.2,
          totalBottlesPackaged: 300,
          packagingFormatCl: 75,
          bottleType: 'Bordelesa Cónica Verde Antiguo',
          bottlingDate: daysAgo(1),
        },
      );

      expect(res.status).toBe(201);
      expect(res.body.data.internationalLotCode).toContain('WINE');
      expect(res.body.data.productType).toBe('WINE');
    });

    it('Paso 7: grafo del vino criado en barrica', async () => {
      const res = await as(enologistToken).get(`/v1/lots/${wineLotId}/graph`);

      expect(res.status).toBe(200);
      expect(res.body.data.productType).toBe('WINE');
      expect(
        (res.body.data.nodes as { type: string }[]).map((n) => n.type),
      ).toEqual(['TERROIR', 'HARVEST_BATCH', 'TANK', 'WINE_AGING', 'BOTTLING']);
    });
  });

  // ===========================================================================
  // FLUJO 3: SEGURIDAD, VALIDACIONES D.O. Y AISLAMIENTO MULTI-TENANT
  // ===========================================================================
  describe('Reglas de la D.O. y aislamiento entre bodegas', () => {
    it('rechaza el destino singani si la uva viene de menos de 1.600 msnm', async () => {
      const low = await as(agronomistToken).post('/v1/terroirs', {
        parcelName: 'Parcela Santa Cruz Llanuras',
        cadastreCode: 'CAT-SC-01',
        surfaceHectares: 2.0,
        altitudeMasl: 400.0,
        rawMaterialType: 'uva',
        varietyName: 'Moscatel de Alejandría',
      });
      expect(low.status).toBe(201);
      expect(low.body.data.isDoEligible).toBe(false);

      const harvest = await as(agronomistToken).post('/v1/harvest-batches', {
        terroirId: low.body.data.id,
        intakeDate: daysAgo(40),
        grossWeightKg: 1000,
        tareWeightKg: 10,
      });
      expect(harvest.status).toBe(201);
      await as(enologistToken)
        .post(`/v1/harvest-batches/${harvest.body.data.id}/phyto-decisions`, {
          decision: 'APPROVED',
        })
        .expect(201);

      const tank = {
        inputs: [{ harvestBatchId: harvest.body.data.id }],
        tankCode: 'TK-LOW-01',
        capacityLiters: 1000,
        material: 'Inox',
        volumeFilledLiters: 800,
        startFermentation: true,
        startDate: `${daysAgo(39)}T10:00:00Z`,
      };
      // Predeclarar el destino singani ya evalúa la D.O. del lote
      const declared = await as(enologistToken).post('/v1/fermentation-tanks', {
        ...tank,
        destinationType: 'SINGANI_DIST',
      });
      expect(declared.status).toBe(422);
      expect(declared.body.error.code).toBe('TRC_DO_NOT_ELIGIBLE');

      const created = await as(enologistToken).post(
        '/v1/fermentation-tanks',
        tank,
      );
      expect(created.status).toBe(201);

      // Al completar con destino singani: D.O. calculada sobre los pesajes del
      // lote con su instantánea (EA-03), sin que nadie pueda declararla
      const res = await as(enologistToken).post(
        `/v1/fermentation-tanks/${created.body.data.id}/complete`,
        {
          endDate: daysAgo(20),
          finalVolumeLiters: 780,
          destination: 'SINGANI_DIST',
        },
      );

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('TRC_DO_NOT_ELIGIBLE');
      expect(res.body.error.details[0]).toMatchObject({
        code: 'TRC_DO_NOT_ELIGIBLE',
        rule: 'trazabilidad.singani.altitudMinimaMsnm',
        expected: 1600,
        actual: 400,
      });

      // El tanque sigue fermentando y sin destino: no hay destilación posible
      const distillation = await as(enologistToken).post(
        '/v1/production-batches/distillation',
        {
          fermentationTankId: created.body.data.id,
          equipmentIdentifier: 'Alambique 01',
          processStartDate: daysAgo(19),
          inputVolumeLiters: 780.0,
        },
      );
      expect(distillation.status).toBe(409);
      expect(distillation.body.error.code).toBe('TRC_TANK_NOT_COMPLETED');
    });

    it('la bodega 2 no puede crear una vendimia con una parcela de la bodega 1', async () => {
      const res = await as(winery2AdminToken).post('/v1/harvest-batches', {
        terroirId, // Parcela de la bodega 1
        intakeDate: daysAgo(200),
        grossWeightKg: 5000.0,
        tareWeightKg: 50.0,
      });

      expect(res.status).toBe(404);
    });

    it('la bodega 2 no ve los tanques ni el lote de la bodega 1', async () => {
      const tank = await as(winery2AdminToken).get(
        `/v1/fermentation-tanks/${fermentationTankId}`,
      );
      expect(tank.status).toBe(404);
      const lot = await as(winery2AdminToken).get(`/v1/lots/${singaniLotId}`);
      expect(lot.status).toBe(404);
      const graph = await as(winery2AdminToken).get(
        `/v1/lots/${singaniLotId}/graph`,
      );
      expect(graph.status).toBe(404);
    });
  });
});
