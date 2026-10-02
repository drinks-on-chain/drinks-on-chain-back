import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MembershipRoleEnum, Prisma, PrismaClient } from '@prisma/client';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { loadMockFixtures } from '../src/seed/fixtures';
import { lotIdOfHarvest, mockId } from '../src/seed/ids';
import { runSeed } from '../src/seed/run-seed';
import { PLATFORM_ORGANIZATION_ID } from '../src/modules/organizations/organization.constants';
import { isValidBottleCode } from '../src/modules/lots/domain/bottle-code';
import { staffToken } from './helpers/staff-session';
import { createPlatformUser } from './helpers/identity';
import { loadOpenApiValidator } from './helpers/openapi-validator';
import { sha256Of, TEST_PDF, uploadTraceFile } from './helpers/trace-files';

/**
 * Lote del servidor (O2-BE-1) sobre la semilla de demostración en un esquema
 * propio: lotes sembrados, pruebas de elusión (candados, D.O., dictamen,
 * número de botellas, tanque sin completar), secuencias sin carreras, SE-07,
 * plataforma de solo lectura (S-25) y respuestas contra `openapi.json`. Tras
 * el cierre H2 todo va por las rutas del contrato: las legadas ya no existen
 * (la migración *contract* tiene su propia suite, `migration-contract`).
 */
process.env.TRUST_PROXY = '1';

const run = `${Date.now()}${randomBytes(3).toString('hex')}`;
const schema = `o2_e2e_${run}`;
const originalUrl = process.env.DATABASE_URL;

function urlWithSchema(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('schema', name);
  return parsed.toString();
}
const databaseUrl = urlWithSchema(process.env.DATABASE_URL ?? '', schema);

/** Día de calendario de hace `n` días (UTC; `n ≥ 2` evita el borde de La Paz). */
function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

const CINTI = mockId('winery:cintiviejo');
const ALTOS = mockId('winery:altos');

type Res = request.Response;
type Detail = {
  code?: string;
  rule?: string;
  expected?: unknown;
  actual?: unknown;
  meta?: Record<string, unknown>;
};
const codes = (res: Res): string[] =>
  ((res.body.error?.details ?? []) as Detail[]).map((d) => d.code as string);

describe('Ola 2 · lote del servidor y cierres de seguridad (e2e)', () => {
  const openapi = loadOpenApiValidator();
  let prisma: PrismaClient;
  let app: INestApplication;
  let ipSeq = 1;
  const nextIp = () =>
    `10.231.${Math.floor(Math.random() * 200)}.${(ipSeq++ % 250) + 1}`;
  const tokens = {
    cinti: '',
    cintiOperator: '',
    altos: '',
    platform: '',
    consumer: '',
  };
  const http = () => request(app.getHttpServer());

  function call(
    method: 'get' | 'post' | 'patch',
    who: keyof typeof tokens,
    path: string,
    body?: object,
  ): Promise<Res> {
    const req = http()[method](path).set('X-Forwarded-For', nextIp());
    if (tokens[who]) req.set('Authorization', `Bearer ${tokens[who]}`);
    return body ? req.send(body) : req;
  }
  /** Llamada cuya respuesta se valida contra `openapi.json`. */
  async function checked(
    method: 'get' | 'post' | 'patch',
    who: keyof typeof tokens,
    path: string,
    status: number,
    body?: object,
  ): Promise<Res> {
    const res = await call(method, who, path, body);
    expect({
      path,
      status: res.status,
      error: res.body.error?.code,
    }).toMatchObject({ path, status });
    openapi.expectResponse(method, path, res);
    return res;
  }

  async function terroirId(wineryId: string, parcel: string): Promise<string> {
    const t = await prisma.terroir.findFirstOrThrow({
      where: { wineryId, parcelName: { contains: parcel } },
      select: { id: true },
    });
    return t.id;
  }

  /** `FILLING → FERMENTING → COMPLETED` con su destino (§4.2, §4.3). */
  async function completeTank(
    tankId: string,
    endDate: string,
    finalVolumeLiters: number,
    destination: 'WINE_AGING' | 'SINGANI_DIST',
  ): Promise<Res> {
    await checked(
      'post',
      'cinti',
      `/v1/fermentation-tanks/${tankId}/start`,
      200,
    );
    return checked(
      'post',
      'cinti',
      `/v1/fermentation-tanks/${tankId}/complete`,
      200,
      { endDate, finalVolumeLiters, destination },
    );
  }

  async function tokenFor(
    email: string,
    wineryId: string,
    role: MembershipRoleEnum,
  ) {
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    return staffToken(app, {
      userId: user.id,
      email,
      organizationId: wineryId,
      organizationType: 'WINERY',
      role,
    });
  }

  beforeAll(async () => {
    execFileSync(
      process.execPath,
      [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
      {
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: 'pipe',
      },
    );
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    process.env.DATABASE_URL = databaseUrl;
    process.env.PASSPORT_BASE_URL = 'https://pasaporte.e2e.test';
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    // La semilla después del arranque: el catálogo de configuración ya está en la base
    await runSeed(
      prisma,
      {
        superadmin: null,
        demo: {
          password: `demo-${randomBytes(8).toString('hex')}`,
          totpSecret: null,
        },
        bcryptRounds: 4,
        mfaKeys: { jwtSecret: null, mfaEncryptionKey: null },
      },
      undefined,
      loadMockFixtures(),
    );

    tokens.cinti = await tokenFor(
      'admin@cintiviejo.test',
      CINTI,
      MembershipRoleEnum.OWNER,
    );
    tokens.cintiOperator = await tokenFor(
      'operario@cintiviejo.test',
      CINTI,
      MembershipRoleEnum.OPERATOR,
    );
    tokens.altos = await tokenFor(
      'admin@altos.test',
      ALTOS,
      MembershipRoleEnum.OWNER,
    );
    const admin = await createPlatformUser(prisma, {
      email: `admin-o2-${run}@drinksonchain.test`,
      password: 'Plataforma-o2-123',
      role: MembershipRoleEnum.ADMIN,
    });
    tokens.platform = await staffToken(app, {
      userId: admin.id,
      email: admin.email,
      organizationId: PLATFORM_ORGANIZATION_ID,
      organizationType: 'PLATFORM',
      role: MembershipRoleEnum.ADMIN,
    });
    const consumer = await http()
      .post('/v1/auth/signup')
      .set('X-Forwarded-For', nextIp())
      .send({
        email: `consumidor-${run}@e2e.test`,
        password: 'Consumidor-o2-123',
        fullName: 'Consumidor',
      })
      .expect(201);
    tokens.consumer = consumer.body.data.tokens.accessToken as string;
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    if (prisma) {
      await prisma.$executeRawUnsafe(
        `DROP SCHEMA IF EXISTS "${schema}" CASCADE`,
      );
      await prisma.$disconnect();
    }
    process.env.DATABASE_URL = originalUrl;
    delete process.env.PASSPORT_BASE_URL;
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('lotes de demostración de la semilla (§2.6)', () => {
    it('lotes migrados con su id (UUID v5 del pesaje), instantánea, códigos y sin incidencias', async () => {
      // Los lotes migrados (uno por pesaje, como `LotView`) conservan el id
      // que derivó la apertura: UUID v5 de `lot:{pesaje}`, el de los mocks
      const harvests = await prisma.harvestBatch.findMany({
        where: { lot: { rulesOrigin: 'MIGRATION' } },
        select: { id: true, lotId: true },
      });
      expect(harvests).toHaveLength(12);
      expect(harvests.every((h) => h.lotId === lotIdOfHarvest(h.id))).toBe(
        true,
      );

      const list = await checked('get', 'cinti', '/v1/lots?limit=100', 200);
      expect(
        list.body.data.items.every((l: { reference: string }) =>
          /^CVJ-L\d{4}-\d{3}$/.test(l.reference),
        ),
      ).toBe(true);
      expect(
        list.body.data.items.every(
          (l: { complianceIssuesOpen: number }) => l.complianceIssuesOpen === 0,
        ),
      ).toBe(true);

      const bottled = await prisma.lot.findFirstOrThrow({
        where: { lotCode: 'CVJ-2026-SINGANI-001' },
      });
      const detail = await checked(
        'get',
        'cinti',
        `/v1/lots/${bottled.id}`,
        200,
      );
      expect(detail.body.data).toMatchObject({
        stage: 'BOTTLED',
        productType: 'SINGANI',
        bottles: 4080,
        labStatus: 'CONFORMING',
        rules: { origin: 'MIGRATION', singani: { minRestDays: 180 } },
        denomination: { status: 'ELIGIBLE', rulesSource: 'LOT_SNAPSHOT' },
        createdBy: null,
      });
      const bottling = await prisma.bottlingBatch.findFirstOrThrow({
        where: { lotId: bottled.id },
      });
      expect(bottling.qrBatchUrl).toBe(
        'https://pasaporte.e2e.test/b/CVJ-2026-SINGANI-001',
      );
      const unit = await prisma.bottleUnit.findFirstOrThrow({
        where: { lotId: bottled.id, serial: 1 },
      });
      expect(isValidBottleCode(unit.code)).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('recorrido singani con pruebas de elusión (§18)', () => {
    let lotId: string;
    let harvestId: string;
    let tankId: string;
    let productionId: string;
    let bottlingId: string;
    let lotCode: string;
    const year = Number(daysAgo(200).slice(0, 4));

    it('lote en origen: D.O. de las parcelas previstas y la instantánea de reglas', async () => {
      const carreras = await terroirId(CINTI, 'Las Carreras');
      const notEligible = await checked('post', 'cinti', '/v1/lots', 422, {
        name: 'Singani con Vischoqueña',
        harvestYear: year,
        productType: 'SINGANI',
        plannedTerroirIds: [carreras],
      });
      expect(notEligible.body.error.code).toBe('TRC_DO_TERROIR_NOT_ELIGIBLE');
      expect(notEligible.body.error.details[0]).toMatchObject({
        field: 'plannedTerroirIds',
        rule: 'trazabilidad.singani.variedadesExigidas',
        actual: 'Vischoqueña',
      });
      const unsupported = await checked('post', 'cinti', '/v1/lots', 422, {
        name: 'Cerveza',
        harvestYear: year,
        productType: 'BEER',
      });
      expect(unsupported.body.error.code).toBe('TRC_PRODUCT_NOT_SUPPORTED');

      const created = await checked('post', 'cinti', '/v1/lots', 201, {
        name: 'Singani Gran Reserva e2e',
        harvestYear: year,
        productType: 'SINGANI',
        estimatedBottles: 3000,
        plannedFormatCl: 75,
        targetAbvPercent: 40,
        plannedTerroirIds: [await terroirId(CINTI, 'Los Parrales')],
      });
      lotId = created.body.data.id;
      expect(created.body.data).toMatchObject({
        stage: 'ORIGIN',
        productType: 'SINGANI',
        rules: {
          origin: 'LOT_CREATION',
          singani: { minAltitudeMasl: 1600, minRestDays: 180 },
          bottling: { maxLossPercent: 5 },
        },
        createdBy: { role: 'OWNER' },
      });
      expect(created.body.data.reference).toMatch(
        new RegExp(`^CVJ-L${year}-\\d{3}$`),
      );
    });

    it('pesaje: sin autoaprobación (EA-04), D.O. de la parcela con la instantánea y secuencia de la bodega', async () => {
      const selfApproved = await checked(
        'post',
        'cintiOperator',
        '/v1/harvest-batches',
        422,
        {
          lotId,
          terroirId: await terroirId(CINTI, 'Los Parrales'),
          intakeDate: daysAgo(200),
          grossWeightKg: 18500,
          tareWeightKg: 100,
          phytosanitaryStatus: 'APPROVED',
        },
      );
      expect(selfApproved.body.error.code).toBe('TRC_PHYTO_IN_CREATE');

      const wrongParcel = await checked(
        'post',
        'cintiOperator',
        '/v1/harvest-batches',
        422,
        {
          lotId,
          terroirId: await terroirId(CINTI, 'Las Carreras'),
          intakeDate: daysAgo(200),
          grossWeightKg: 1100,
          tareWeightKg: 100,
        },
      );
      expect(wrongParcel.body.error.code).toBe('TRC_DO_TERROIR_NOT_ELIGIBLE');

      const future = await checked(
        'post',
        'cintiOperator',
        '/v1/harvest-batches',
        422,
        {
          lotId,
          terroirId: await terroirId(CINTI, 'Los Parrales'),
          intakeDate: '2099-01-01',
          grossWeightKg: 1100,
          tareWeightKg: 100,
        },
      );
      expect(future.body.error.code).toBe('TRC_DATE_IN_FUTURE');

      const harvest = await checked(
        'post',
        'cintiOperator',
        '/v1/harvest-batches',
        201,
        {
          lotId,
          terroirId: await terroirId(CINTI, 'Los Parrales'),
          intakeDate: daysAgo(200),
          grossWeightKg: 18500,
          tareWeightKg: 100,
          maturity: { brixDegrees: 23.5, ph: 3.5, acidityGl: 5.8 },
        },
      );
      harvestId = harvest.body.data.id;
      expect(harvest.body.data).toMatchObject({
        lotId,
        netWeightKg: 18400,
        availableKg: 18400,
        phytosanitaryStatus: 'PENDING_INSPECTION',
        brixDegrees: 23.5,
        doEvaluation: { status: 'ELIGIBLE' },
      });
      expect(harvest.body.data.maturityAnalyses).toHaveLength(1);
    });

    it('el código de vendimia sale de una secuencia sin carreras (EA-07)', async () => {
      const parcel = await terroirId(CINTI, 'San Roque');
      const created = await Promise.all(
        Array.from({ length: 5 }, () =>
          call('post', 'cintiOperator', '/v1/harvest-batches', {
            terroirId: parcel,
            intakeDate: daysAgo(3),
            grossWeightKg: 600,
            tareWeightKg: 100,
          }),
        ),
      );
      expect(created.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
      const harvestCodes = created.map(
        (r) => r.body.data.harvestBatchCode as string,
      );
      expect(new Set(harvestCodes).size).toBe(5);
      const seqs = harvestCodes
        .map((c) => Number(c.split('-').at(-1)))
        .sort((a, b) => a - b);
      expect(seqs[4] - seqs[0]).toBe(4);
      // Uva recibida sin lote
      const loose = await checked(
        'get',
        'cinti',
        '/v1/harvest-batches?lotId=none&limit=100',
        200,
      );
      expect(loose.body.data.items.length).toBeGreaterThanOrEqual(5);
      expect(
        loose.body.data.items.every(
          (h: { lotId: string | null }) => h.lotId === null,
        ),
      ).toBe(true);
    });

    it('el tanque exige el dictamen aprobado; el dictamen es final (EA-04)', async () => {
      const pending = await checked(
        'post',
        'cinti',
        '/v1/fermentation-tanks',
        422,
        {
          inputs: [{ harvestBatchId: harvestId }],
          tankCode: `TK-E2E-${run}`,
          capacityLiters: 15000,
          volumeFilledLiters: 12100,
          destinationType: 'SINGANI_DIST',
          startDate: `${daysAgo(198)}T14:00:00Z`,
        },
      );
      expect(pending.body.error.code).toBe('TRC_PHYTO_NOT_APPROVED');
      expect(pending.body.error.details[0].meta).toMatchObject({
        harvestBatchId: harvestId,
        status: 'PENDING_INSPECTION',
      });

      const quarantineWithoutReason = await checked(
        'post',
        'cinti',
        `/v1/harvest-batches/${harvestId}/phyto-decisions`,
        422,
        {
          decision: 'QUARANTINE',
        },
      );
      expect(quarantineWithoutReason.body.error.code).toBe('VALIDATION_ERROR');

      const approved = await checked(
        'post',
        'cinti',
        `/v1/harvest-batches/${harvestId}/phyto-decisions`,
        201,
        {
          decision: 'APPROVED',
          decidedAt: `${daysAgo(199)}T12:00:00Z`,
        },
      );
      expect(approved.body.data.phytosanitaryStatus).toBe('APPROVED');
      expect(approved.body.data.phytoDecisions[0]).toMatchObject({
        decision: 'APPROVED',
        source: 'ERP',
        decidedBy: { role: 'OWNER' },
      });

      const again = await checked(
        'post',
        'cinti',
        `/v1/harvest-batches/${harvestId}/phyto-decisions`,
        409,
        { decision: 'REJECTED', notes: 'Cambio de opinión' },
      );
      expect(again.body.error.code).toBe('TRC_PHYTO_DECISION_FINAL');
      await checked(
        'get',
        'cinti',
        `/v1/harvest-batches/${harvestId}/phyto-decisions`,
        200,
      );
      await checked(
        'post',
        'cinti',
        `/v1/harvest-batches/${harvestId}/maturity-analyses`,
        201,
        {
          brixDegrees: 24,
          ph: 3.4,
          acidityGl: 5.9,
          measuredAt: `${daysAgo(199)}T09:00:00Z`,
        },
      );
      await checked(
        'get',
        'cinti',
        `/v1/harvest-batches/${harvestId}/maturity-analyses`,
        200,
      );
    });

    it('tanque y destilación: volumen, balance de masa y D.O. (EA-03)', async () => {
      const over = await checked(
        'post',
        'cinti',
        '/v1/fermentation-tanks',
        422,
        {
          inputs: [{ harvestBatchId: harvestId, kg: 20000 }],
          tankCode: `TK-E2E-${run}`,
          volumeFilledLiters: 12100,
          startDate: `${daysAgo(198)}T14:00:00Z`,
        },
      );
      expect(over.body.error.code).toBe('TRC_VOLUME_EXCEEDS_AVAILABLE');

      const tank = await checked(
        'post',
        'cinti',
        '/v1/fermentation-tanks',
        201,
        {
          inputs: [{ harvestBatchId: harvestId }],
          tankCode: `TK-E2E-${run}`,
          capacityLiters: 15000,
          volumeFilledLiters: 12100,
          destinationType: 'SINGANI_DIST',
          startDate: `${daysAgo(198)}T14:00:00Z`,
        },
      );
      tankId = tank.body.data.id;
      expect(tank.body.data).toMatchObject({
        lotId,
        inputs: [{ harvestBatchId: harvestId, kg: 18400 }],
      });

      const busy = await checked(
        'post',
        'cinti',
        '/v1/fermentation-tanks',
        409,
        {
          inputs: [{ harvestBatchId: harvestId }],
          tankCode: `TK-E2E-${run}`,
          volumeFilledLiters: 100,
          startDate: `${daysAgo(197)}T14:00:00Z`,
        },
      );
      expect(busy.body.error.code).toBe('TRC_TANK_CODE_IN_USE');

      const base = {
        fermentationTankId: tankId,
        equipmentIdentifier: 'Alambique AL-E2E',
        processStartDate: daysAgo(190),
      };
      // Sin completar la fermentación no hay destilación (H2: sin tolerancia)
      const notCompleted = await checked(
        'post',
        'cinti',
        '/v1/production-batches/distillation',
        409,
        { ...base, inputVolumeLiters: 12100 },
      );
      expect(notCompleted.body.error.code).toBe('TRC_TANK_NOT_COMPLETED');
      expect(notCompleted.body.error.details[0].meta).toMatchObject({
        status: 'FILLING',
        tankId,
      });
      const completed = await completeTank(
        tankId,
        daysAgo(192),
        12100,
        'SINGANI_DIST',
      );
      expect(completed.body.data).toMatchObject({
        status: 'COMPLETED',
        destinationType: 'SINGANI_DIST',
      });

      // La D.O. no se declara: el campo ya no existe (EA-03)
      const declared = await checked(
        'post',
        'cinti',
        '/v1/production-batches/distillation',
        422,
        { ...base, inputVolumeLiters: 12100, isDoEligible: true },
      );
      expect(declared.body.error.code).toBe('VALIDATION_ERROR');
      expect(declared.body.error.details[0].field).toBe('isDoEligible');

      const tooMuch = await checked(
        'post',
        'cinti',
        '/v1/production-batches/distillation',
        422,
        {
          ...base,
          inputVolumeLiters: 13000,
        },
      );
      expect(tooMuch.body.error.code).toBe('TRC_VOLUME_EXCEEDS_AVAILABLE');

      const distillation = await checked(
        'post',
        'cinti',
        '/v1/production-batches/distillation',
        201,
        { ...base, inputVolumeLiters: 12100 },
      );
      productionId = distillation.body.data.id;
      expect(distillation.body.data).toMatchObject({
        lotId,
        processEndDate: null,
        isDoEligible: true,
        lock: null,
      });

      const close = `/v1/production-batches/${productionId}/close`;
      const cuts = await checked('post', 'cinti', close, 422, {
        processEndDate: daysAgo(185),
        cuts: { headsLiters: 120, heartLiters: 12000, tailsLiters: 210 },
        heartAbvPercent: 60,
      });
      expect(cuts.body.error.code).toBe('TRC_MASS_BALANCE_EXCEEDED');

      const closed = await checked('post', 'cinti', close, 200, {
        processEndDate: daysAgo(185),
        cuts: { headsLiters: 120, heartLiters: 1500, tailsLiters: 210 },
        heartAbvPercent: 60,
      });
      expect(closed.body.data).toMatchObject({
        lotId,
        heartLiters: 1500,
        heartAbvPercent: 60,
        pureAlcoholLiters: 900,
        isDoEligible: true,
        lock: { kind: 'REST', released: true, rule: { minimum: 180 } },
      });
    });

    it('un cambio de regla a mitad de proceso no afecta al lote (instantánea, CFG-06)', async () => {
      await prisma.settingOverride.create({
        data: {
          key: 'trazabilidad.singani.reposoMinimoDias',
          wineryId: CINTI,
          value: 365,
          reason: 'Prueba e2e: la instantánea manda',
        },
      });
      const other = await checked('post', 'cinti', '/v1/lots', 201, {
        name: 'Lote con reglas nuevas',
        harvestYear: year,
        productType: 'SINGANI',
      });
      expect(other.body.data.rules.singani.minRestDays).toBe(365);
      const same = await checked('get', 'cinti', `/v1/lots/${lotId}`, 200);
      expect(same.body.data.rules.singani.minRestDays).toBe(180);
    });

    it('embotellado: tipo derivado, balance de volumen y de alcohol (EA-01, EA-02)', async () => {
      const path = `/v1/lots/${lotId}/bottling`;
      const body = {
        finalAlcoholAbv: 40,
        waterDilutionLiters: 750,
        totalBottlesPackaged: 2950,
        packagingFormatCl: 75,
        bottlingDate: daysAgo(2),
      };
      // El tipo se deriva del origen: no es un campo, y la ruta legada no existe
      const asWine = await checked('post', 'cinti', path, 422, {
        ...body,
        productType: 'WINE',
      });
      expect(asWine.body.error.code).toBe('VALIDATION_ERROR');
      expect(asWine.body.error.details[0].field).toBe('productType');
      const legacy = await call('post', 'cinti', '/v1/bottling', {
        ...body,
        productionBatchId: productionId,
        productType: 'WINE',
      });
      expect(legacy.status).toBe(404);

      const moreBottles = await checked('post', 'cinti', path, 422, {
        ...body,
        totalBottlesPackaged: 3100,
      });
      expect(moreBottles.body.error.code).toBe('TRC_BOTTLING_EXCEEDS_VOLUME');
      expect(moreBottles.body.error.details[0].meta).toMatchObject({
        maxBottles: 3000,
      });

      const watered = await checked('post', 'cinti', path, 422, {
        ...body,
        waterDilutionLiters: 1100,
        totalBottlesPackaged: 3400,
      });
      expect(codes(watered)).toContain('TRC_ALCOHOL_BALANCE_EXCEEDED');

      const lossy = await checked('post', 'cinti', path, 422, {
        ...body,
        totalBottlesPackaged: 2700,
      });
      expect(lossy.body.error.code).toBe('TRC_BOTTLING_LOSS_ABOVE_TOLERANCE');
      expect(lossy.body.error.details[0]).toMatchObject({
        rule: 'trazabilidad.embotellado.mermaMaximaPorcentaje',
        expected: 5,
      });

      const bottled = await checked('post', 'cinti', path, 201, body);
      bottlingId = bottled.body.data.id;
      lotCode = bottled.body.data.internationalLotCode;
      expect(lotCode).toMatch(
        new RegExp(`^CVJ-${daysAgo(2).slice(0, 4)}-SINGANI-\\d{3}$`),
      );
      expect(bottled.body.data).toMatchObject({
        lotId,
        lotCode,
        productType: 'SINGANI',
        blockchainDataHash: null,
        qrBatchUrl: `https://pasaporte.e2e.test/b/${lotCode}`,
        bottleCodes: {
          total: 2950,
          active: 2950,
          voided: 0,
          firstSerial: 1,
          lastSerial: 2950,
        },
        balance: {
          bottledLiters: 2212.5,
          lossPercent: 1.67,
          pureAlcohol: { availableLiters: 900, bottledLiters: 885 },
        },
      });

      const secondByLot = await checked(
        'post',
        'cinti',
        `/v1/lots/${lotId}/bottling`,
        409,
        {
          bottlingDate: daysAgo(2),
          packagingFormatCl: 75,
          totalBottlesPackaged: 10,
          finalAlcoholAbv: 40,
        },
      );
      expect(secondByLot.body.error.code).toBe('TRC_LOT_ALREADY_BOTTLED');

      const production = await prisma.productionBatch.findUniqueOrThrow({
        where: { id: productionId },
      });
      expect(production.restStatus).toBe('BOTTLED');
      const lot = await checked('get', 'cinti', `/v1/lots/${lotId}`, 200);
      expect(lot.body.data).toMatchObject({
        stage: 'BOTTLED',
        lotCode,
        bottles: 2950,
        labStatus: 'NOT_RECORDED',
      });
    });

    it('laboratorio: conformidad calculada con unidades y reanálisis (EA-08)', async () => {
      const path = `/v1/lots/${lotId}/lab-analyses`;
      const key = await uploadTraceFile(app, tokens.cinti, { ip: nextIp() });
      const base = {
        certifiedLaboratoryName: 'Laboratorio e2e ISO 17025',
        accreditedLabCertificationCode: `LAB-${run}`,
        testPerformedAt: daysAgo(2),
        actualAlcoholAbv: 40.05,
        totalAcidityTartaricGl: 4.8,
        volatileAcidityAceticGl: 0.22,
        copperContentMgL: 0.02,
        laboratoryReportKey: key,
      };
      // La conformidad no se declara y el informe no viaja por URL (H2)
      const declared = await checked('post', 'cinti', path, 422, {
        ...base,
        conformsToSenasagStandards: true,
        laboratoryReportPdfUrl: 'https://laboratorio.e2e.test/informe.pdf',
      });
      expect(
        (declared.body.error.details as { field: string }[])
          .map((d) => d.field)
          .sort(),
      ).toEqual(['conformsToSenasagStandards', 'laboratoryReportPdfUrl']);
      const legacy = await call('post', 'cinti', '/v1/lab-analyses', {
        ...base,
        bottlingBatchId: bottlingId,
      });
      expect(legacy.status).toBe(404);

      const incomplete = await checked('post', 'cinti', path, 201, base);
      expect(incomplete.body.data).toMatchObject({
        conformsToSenasagStandards: false,
        conformityStatus: 'INCOMPLETE',
        current: true,
        conformity: { status: 'INCOMPLETE' },
        report: { key, sha256: sha256Of(TEST_PDF) },
      });
      const complete = await checked('post', 'cinti', path, 201, {
        ...base,
        methanolContentMgL: 48,
      });
      expect(complete.body.data).toMatchObject({
        conformsToSenasagStandards: true,
        conformityStatus: 'CONFORMING',
        methanolMg100mlAa: 11.985,
      });
      const current = await checked(
        'get',
        'cinti',
        `/v1/lab-analyses/batch/${bottlingId}`,
        200,
      );
      expect(current.body.data.id).toBe(complete.body.data.id);
      const lot = await checked('get', 'cinti', `/v1/lots/${lotId}`, 200);
      expect(lot.body.data.labStatus).toBe('CONFORMING');
    });

    it('candado sin cumplir: el embotellado prematuro falla (EA-01)', async () => {
      const early = await checked('post', 'cinti', '/v1/lots', 201, {
        name: 'Singani joven e2e',
        harvestYear: year,
        productType: 'SINGANI',
      });
      const earlyLot = early.body.data.id;
      const harvest = await checked(
        'post',
        'cinti',
        '/v1/harvest-batches',
        201,
        {
          lotId: earlyLot,
          terroirId: await terroirId(CINTI, 'Cañón Viejo'),
          intakeDate: daysAgo(40),
          grossWeightKg: 1600,
          tareWeightKg: 100,
        },
      );
      await checked(
        'post',
        'cinti',
        `/v1/harvest-batches/${harvest.body.data.id}/phyto-decisions`,
        201,
        { decision: 'APPROVED' },
      );
      const tank = await checked(
        'post',
        'cinti',
        '/v1/fermentation-tanks',
        201,
        {
          inputs: [{ harvestBatchId: harvest.body.data.id }],
          tankCode: `TK-E2E-B-${run}`,
          volumeFilledLiters: 1000,
          startDate: `${daysAgo(38)}T10:00:00Z`,
        },
      );
      await completeTank(tank.body.data.id, daysAgo(22), 1000, 'SINGANI_DIST');
      const distillation = await checked(
        'post',
        'cinti',
        '/v1/production-batches/distillation',
        201,
        {
          fermentationTankId: tank.body.data.id,
          equipmentIdentifier: 'AL-B',
          processStartDate: daysAgo(20),
          inputVolumeLiters: 1000,
        },
      );
      await checked(
        'post',
        'cinti',
        `/v1/production-batches/${distillation.body.data.id}/close`,
        200,
        {
          processEndDate: daysAgo(10),
          cuts: { headsLiters: 10, heartLiters: 150, tailsLiters: 20 },
          heartAbvPercent: 65,
        },
      );
      const res = await checked(
        'post',
        'cinti',
        `/v1/lots/${earlyLot}/bottling`,
        422,
        {
          finalAlcoholAbv: 40,
          waterDilutionLiters: 50,
          totalBottlesPackaged: 100,
          packagingFormatCl: 75,
          bottlingDate: daysAgo(2),
        },
      );
      expect(codes(res)).toContain('TRC_LOCK_NOT_RELEASED');
      const lock = (res.body.error.details as Detail[]).find(
        (d) => d.code === 'TRC_LOCK_NOT_RELEASED',
      )!;
      expect(lock).toMatchObject({
        rule: 'trazabilidad.singani.reposoMinimoDias',
      });
      expect(lock.meta).toMatchObject({
        kind: 'REST',
        sourceId: distillation.body.data.id,
      });
      expect(Number(lock.meta?.daysRemaining)).toBeGreaterThan(160);

      // Descartar el lote: terminal, sin más registros
      await checked('post', 'cinti', `/v1/lots/${earlyLot}/discard`, 200, {
        reason: 'Prueba e2e de descarte',
      });
      const closed = await checked(
        'post',
        'cinti',
        '/v1/harvest-batches',
        409,
        {
          lotId: earlyLot,
          terroirId: await terroirId(CINTI, 'Cañón Viejo'),
          intakeDate: daysAgo(5),
          grossWeightKg: 600,
          tareWeightKg: 100,
        },
      );
      expect(closed.body.error.code).toBe('TRC_LOT_TERMINAL');
    });

    it('vino: crianza bajo el mínimo de la instantánea y sin agua (S-12)', async () => {
      await prisma.settingOverride.create({
        data: {
          key: 'trazabilidad.vino.crianzaMinimaMeses',
          wineryId: CINTI,
          value: 6,
          reason: 'Prueba e2e',
        },
      });
      const wine = await checked('post', 'cinti', '/v1/lots', 201, {
        name: 'Tinto e2e',
        harvestYear: year,
        productType: 'WINE',
      });
      const harvest = await checked(
        'post',
        'cinti',
        '/v1/harvest-batches',
        201,
        {
          lotId: wine.body.data.id,
          terroirId: await terroirId(CINTI, 'San Roque'),
          intakeDate: daysAgo(100),
          grossWeightKg: 3100,
          tareWeightKg: 100,
        },
      );
      await checked(
        'post',
        'cinti',
        `/v1/harvest-batches/${harvest.body.data.id}/phyto-decisions`,
        201,
        { decision: 'APPROVED' },
      );
      const singaniTank = await checked(
        'post',
        'cinti',
        '/v1/fermentation-tanks',
        422,
        {
          inputs: [{ harvestBatchId: harvest.body.data.id }],
          tankCode: `TK-E2E-W-${run}`,
          volumeFilledLiters: 2000,
          destinationType: 'SINGANI_DIST',
          startDate: `${daysAgo(98)}T10:00:00Z`,
        },
      );
      expect(singaniTank.body.error.code).toBe('TRC_DESTINATION_MISMATCH');
      const tank = await checked(
        'post',
        'cinti',
        '/v1/fermentation-tanks',
        201,
        {
          inputs: [{ harvestBatchId: harvest.body.data.id }],
          tankCode: `TK-E2E-W-${run}`,
          volumeFilledLiters: 2000,
          destinationType: 'WINE_AGING',
          startDate: `${daysAgo(98)}T10:00:00Z`,
        },
      );
      // Sin completar la fermentación no hay crianza (H2: sin tolerancia)
      const notCompleted = await checked(
        'post',
        'cinti',
        '/v1/wine-aging',
        409,
        {
          fermentationTankId: tank.body.data.id,
          containerType: 'Barrica',
          volumeLiters: 1900,
          plannedMonths: 12,
          startDate: daysAgo(90),
        },
      );
      expect(notCompleted.body.error.code).toBe('TRC_TANK_NOT_COMPLETED');
      await completeTank(tank.body.data.id, daysAgo(92), 1950, 'WINE_AGING');
      const short = await checked('post', 'cinti', '/v1/wine-aging', 422, {
        fermentationTankId: tank.body.data.id,
        containerType: 'Barrica',
        volumeLiters: 1900,
        plannedMonths: 3,
        startDate: daysAgo(90),
      });
      expect(short.body.error.details[0]).toMatchObject({
        code: 'TRC_AGING_BELOW_MINIMUM',
        rule: 'trazabilidad.vino.crianzaMinimaMeses',
        expected: 6,
        actual: 3,
      });
      const aging = await checked('post', 'cinti', '/v1/wine-aging', 201, {
        fermentationTankId: tank.body.data.id,
        containerType: 'Barrica',
        volumeLiters: 1900,
        plannedMonths: 12,
        startDate: daysAgo(90),
      });
      expect(aging.body.data.lock).toMatchObject({
        kind: 'AGING',
        released: false,
      });
      const res = await checked(
        'post',
        'cinti',
        `/v1/lots/${wine.body.data.id}/bottling`,
        422,
        {
          sources: [{ wineAgingBatchId: aging.body.data.id, liters: 1900 }],
          finalAlcoholAbv: 13.5,
          waterDilutionLiters: 10,
          totalBottlesPackaged: 2000,
          packagingFormatCl: 75,
          bottlingDate: daysAgo(2),
        },
      );
      expect(codes(res)).toEqual(
        expect.arrayContaining([
          'TRC_LOCK_NOT_RELEASED',
          'TRC_DILUTION_NOT_ALLOWED',
        ]),
      );

      // Vista previa: las mismas reglas, sin escribir
      const lotBody = {
        bottlingDate: daysAgo(2),
        packagingFormatCl: 75,
        totalBottlesPackaged: 2000,
        finalAlcoholAbv: 13.5,
      };
      const preview = await checked(
        'post',
        'cinti',
        `/v1/lots/${wine.body.data.id}/bottling/preview`,
        200,
        lotBody,
      );
      expect(preview.body.data.valid).toBe(false);
      expect(preview.body.data.violations.map((v: Detail) => v.code)).toContain(
        'TRC_LOCK_NOT_RELEASED',
      );
      expect(preview.body.data.balance).toMatchObject({
        availableLiters: 1900,
        bottledLiters: 1500,
      });
      const direct = await checked(
        'post',
        'cinti',
        `/v1/lots/${wine.body.data.id}/bottling`,
        422,
        lotBody,
      );
      expect(direct.body.error.code).toBe('TRC_LOCK_NOT_RELEASED');
    });

    it('D.O. al predeclarar el destino singani (EA-03) y lote nuevo desde el tanque para uva sin lote', async () => {
      const carreras = await checked(
        'post',
        'cinti',
        '/v1/harvest-batches',
        201,
        {
          terroirId: await terroirId(CINTI, 'Las Carreras'),
          intakeDate: daysAgo(12),
          grossWeightKg: 900,
          tareWeightKg: 100,
        },
      );
      expect(carreras.body.data.lotId).toBeNull();
      await checked(
        'post',
        'cinti',
        `/v1/harvest-batches/${carreras.body.data.id}/phyto-decisions`,
        201,
        { decision: 'APPROVED' },
      );
      const res = await checked(
        'post',
        'cinti',
        '/v1/fermentation-tanks',
        422,
        {
          inputs: [{ harvestBatchId: carreras.body.data.id }],
          tankCode: `TK-E2E-D-${run}`,
          volumeFilledLiters: 500,
          destinationType: 'SINGANI_DIST',
          startDate: `${daysAgo(11)}T10:00:00Z`,
        },
      );
      expect(res.body.error.code).toBe('TRC_DO_NOT_ELIGIBLE');
      expect(res.body.error.details[0]).toMatchObject({
        rule: 'trazabilidad.singani.variedadesExigidas',
        actual: 'Vischoqueña',
      });

      const tank = await checked(
        'post',
        'cinti',
        '/v1/fermentation-tanks',
        201,
        {
          inputs: [{ harvestBatchId: carreras.body.data.id }],
          tankCode: `TK-E2E-D-${run}`,
          volumeFilledLiters: 500,
          startDate: `${daysAgo(11)}T10:00:00Z`,
        },
      );
      expect(tank.body.data.lotId).toEqual(expect.any(String));
      const after = await checked(
        'get',
        'cinti',
        `/v1/harvest-batches/${carreras.body.data.id}`,
        200,
      );
      expect(after.body.data.lotId).toBe(tank.body.data.lotId);
    });

    it('estimación de botellas con motivo y su historial', async () => {
      const noReason = await checked(
        'patch',
        'cinti',
        `/v1/lots/${lotId}`,
        422,
        { estimatedBottles: 2950 },
      );
      expect(noReason.body.error.details[0].field).toBe('reason');
      const updated = await checked(
        'patch',
        'cinti',
        `/v1/lots/${lotId}`,
        200,
        { estimatedBottles: 2950, reason: 'Conteo real' },
      );
      expect(
        updated.body.data.estimatedBottlesHistory.map(
          (h: { value: number }) => h.value,
        ),
      ).toEqual([3000, 2950]);
    });

    it('SE-07: el grafo solo lo ven la bodega dueña y la plataforma; el grafo y el pasaporte legados ya no existen', async () => {
      const graph = await checked(
        'get',
        'cinti',
        `/v1/lots/${lotId}/graph`,
        200,
      );
      const nodes = graph.body.data.nodes as {
        type: string;
        metrics: { key: string; value: unknown }[];
        actor: { role: string } | null;
      }[];
      expect(nodes.map((n) => n.type)).toEqual(
        expect.arrayContaining([
          'TERROIR',
          'HARVEST_BATCH',
          'TANK',
          'DISTILLATION',
          'BOTTLING',
          'LAB_ANALYSIS',
        ]),
      );
      // EA-05: quien embotelló sale de su membresía, no un nombre genérico
      expect(nodes.find((n) => n.type === 'BOTTLING')?.actor).toMatchObject({
        role: 'OWNER',
      });
      await checked('get', 'platform', `/v1/lots/${lotId}/graph`, 200);
      for (const who of ['altos', 'consumer'] as const) {
        const res = await call('get', who, `/v1/lots/${lotId}/graph`);
        expect(res.status).toBe(404);
      }
      // Retirados en H2: el grafo por embotellado y el pasaporte legado
      for (const who of ['cinti', 'platform', 'consumer'] as const) {
        const dag = await call(
          'get',
          who,
          `/v1/traceability/dag/${bottlingId}`,
        );
        expect(dag.status).toBe(404);
      }
      const legacy = await call(
        'get',
        'consumer',
        `/v1/traceability/public/${lotCode}`,
      );
      expect(legacy.status).toBe(404);
    });

    it('la plataforma solo lee la trazabilidad (S-25): 403 TRC_PLATFORM_READ_ONLY', async () => {
      const writes: [string, object][] = [
        [
          `/v1/lots?wineryId=${CINTI}`,
          { name: 'Plataforma', harvestYear: year },
        ],
        [
          `/v1/harvest-batches?wineryId=${CINTI}`,
          {
            terroirId: await terroirId(CINTI, 'Los Parrales'),
            intakeDate: daysAgo(3),
            grossWeightKg: 200,
            tareWeightKg: 100,
          },
        ],
        [
          `/v1/lots/${lotId}/bottling?wineryId=${CINTI}`,
          {
            finalAlcoholAbv: 40,
            totalBottlesPackaged: 1,
            packagingFormatCl: 75,
            bottlingDate: daysAgo(2),
          },
        ],
        [
          `/v1/harvest-batches/${harvestId}/phyto-decisions?wineryId=${CINTI}`,
          { decision: 'APPROVED' },
        ],
      ];
      for (const [path, body] of writes) {
        const res = await call('post', 'platform', path, body);
        expect({
          path,
          status: res.status,
          code: res.body.error?.code,
        }).toEqual({ path, status: 403, code: 'TRC_PLATFORM_READ_ONLY' });
      }
      const read = await checked(
        'get',
        'platform',
        `/v1/lots?wineryId=${CINTI}`,
        200,
      );
      expect(read.body.data.total).toBeGreaterThan(0);
      await checked(
        'get',
        'platform',
        `/v1/lots/${lotId}?wineryId=${CINTI}`,
        200,
      );
    });

    it('aislamiento: el lote de otra bodega es 404 TRC_LOT_NOT_FOUND', async () => {
      const res = await checked('get', 'altos', `/v1/lots/${lotId}`, 404);
      expect(res.body.error.code).toBe('TRC_LOT_NOT_FOUND');
    });

    it('las vistas del lote y el pasaporte (pasos 2.9 y 2.10) ya tienen lógica: no responden 501', async () => {
      const res = await checked(
        'get',
        'cinti',
        `/v1/lots/${lotId}/timeline`,
        200,
      );
      expect(res.body.data.events.length).toBeGreaterThan(0);
      const pub = await checked(
        'get',
        'consumer',
        `/v1/public/passports/${lotCode}`,
        200,
      );
      expect(pub.body.data).toMatchObject({ kind: 'LOT', lotCode });
    });
  });

  it('errores de reglas: `details` ampliado validado contra el contrato', () => {
    expect(openapi.covered.size).toBeGreaterThan(10);
    void Prisma;
  });
});
