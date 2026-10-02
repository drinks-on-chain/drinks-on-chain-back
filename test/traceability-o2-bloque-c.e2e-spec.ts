import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { MembershipRoleEnum, PrismaClient } from '@prisma/client';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { loadMockFixtures } from '../src/seed/fixtures';
import { mockId } from '../src/seed/ids';
import { runSeed } from '../src/seed/run-seed';
import { PLATFORM_ORGANIZATION_ID } from '../src/modules/organizations/organization.constants';
import {
  formatBottleCode,
  generateBottleCode,
  isValidBottleCode,
} from '../src/modules/lots/domain/bottle-code';
import {
  bottleLeaf,
  merkleRoot,
  verifyMerkleProof,
} from '../src/modules/lots/domain/merkle';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { STORAGE_SERVICE } from '../src/shared/storage/storage.interface';
import { createObjectStorage } from '../src/shared/storage/storage.module';
import { createMember, staffToken } from './helpers/staff-session';
import { createPlatformUser } from './helpers/identity';
import { loadOpenApiValidator } from './helpers/openapi-validator';

/**
 * Ola 2 · bloque C (pasos 2.9 y 2.10 de la Etapa 2): vistas del lote (línea de
 * tiempo, balance, grafo, panel y reporte), archivos del lote y pasaporte
 * público, sobre la semilla de demostración en un esquema propio. Incluye las
 * pruebas de elusión del contrato O2 §18 de este alcance: grafo de otra
 * bodega (404), pasaporte inexistente (404) y enumeración (429), pasaporte sin
 * datos inventados, de botella anulada, de bodega suspendida y de lote
 * descartado. Fechas relativas a hoy.
 */
process.env.TRUST_PROXY = '1';

const run = `${Date.now()}${randomBytes(3).toString('hex')}`;
const schema = `o2c_e2e_${run}`;
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
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const PDF = Buffer.from('%PDF-1.4 ficha técnica de prueba del bloque C');

type Res = request.Response;
type Who =
  | 'cinti'
  | 'cintiOperator'
  | 'cintiAccountant'
  | 'altos'
  | 'platform'
  | 'consumer'
  | 'nobody';

describe('Ola 2 · bloque C: vistas del lote, archivos y pasaporte público (e2e)', () => {
  const openapi = loadOpenApiValidator();
  const storageDir = mkdtempSync(join(tmpdir(), 'doc-o2c-'));
  let prisma: PrismaClient;
  let app: INestApplication;
  let ipSeq = 1;
  const nextIp = () =>
    `10.232.${Math.floor(Math.random() * 200)}.${(ipSeq++ % 250) + 1}`;
  /** IP propia de una prueba de límites (no la comparte ninguna otra llamada ni ejecución). */
  const freshIp = () => {
    const [a, b, c] = randomBytes(3);
    return `10.${233 + (a % 20)}.${b}.${(c % 250) + 1}`;
  };
  const tokens: Record<Who, string> = {
    cinti: '',
    cintiOperator: '',
    cintiAccountant: '',
    altos: '',
    platform: '',
    consumer: '',
    nobody: '',
  };
  const http = () => request(app.getHttpServer());

  function call(
    method: 'get' | 'post',
    who: Who,
    path: string,
    body?: object,
    ip = nextIp(),
  ): Promise<Res> {
    const req = http()[method](path).set('X-Forwarded-For', ip);
    if (tokens[who]) req.set('Authorization', `Bearer ${tokens[who]}`);
    return body ? req.send(body) : req;
  }
  /** Llamada cuya respuesta se valida contra `openapi.json`. */
  async function checked(
    method: 'get' | 'post',
    who: Who,
    path: string,
    status: number,
    body?: object,
    ip?: string,
  ): Promise<Res> {
    const res = await call(method, who, path, body, ip);
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

  async function upload(who: Who, file: Buffer, name: string, mime: string) {
    const res = await http()
      .post('/v1/uploads?folder=lotes')
      .set('X-Forwarded-For', nextIp())
      .set('Authorization', `Bearer ${tokens[who]}`)
      .attach('file', file, { filename: name, contentType: mime })
      .expect(201);
    return res.body.data.key as string;
  }

  /**
   * Singani hasta el reposo por las rutas de la API: lote, pesaje de 18.400 kg,
   * dictamen, tanque de 12.100 L y destilación cerrada (corazón 1.500 L al
   * 60 %) hace `restDays` días.
   */
  async function singaniLot(name: string, restDays: number) {
    const start = restDays + 15;
    const year = Number(daysAgo(start).slice(0, 4));
    const lot = await checked('post', 'cinti', '/v1/lots', 201, {
      name,
      harvestYear: year,
      productType: 'SINGANI',
      estimatedBottles: 3000,
      plannedFormatCl: 75,
      targetAbvPercent: 40,
    });
    const lotId = lot.body.data.id as string;
    const harvest = await checked(
      'post',
      'cintiOperator',
      '/v1/harvest-batches',
      201,
      {
        lotId,
        terroirId: await terroirId(CINTI, 'Los Parrales'),
        intakeDate: daysAgo(start),
        grossWeightKg: 18500,
        tareWeightKg: 100,
        maturity: { brixDegrees: 23.5, ph: 3.5, acidityGl: 5.8 },
      },
    );
    const harvestId = harvest.body.data.id as string;
    await checked(
      'post',
      'cinti',
      `/v1/harvest-batches/${harvestId}/phyto-decisions`,
      201,
      { decision: 'APPROVED', decidedAt: `${daysAgo(start - 1)}T12:00:00Z` },
    );
    const tank = await checked('post', 'cinti', '/v1/fermentation-tanks', 201, {
      inputs: [{ harvestBatchId: harvestId }],
      tankCode: `TK-C-${run}-${restDays}`,
      capacityLiters: 15000,
      volumeFilledLiters: 12100,
      destinationType: 'SINGANI_DIST',
      startDate: `${daysAgo(start - 2)}T14:00:00Z`,
    });
    const tankId = tank.body.data.id as string;
    const distillation = await checked(
      'post',
      'cinti',
      '/v1/production-batches/distillation',
      201,
      {
        fermentationTankId: tankId,
        equipmentIdentifier: 'Alambique AL-C',
        processStartDate: daysAgo(restDays + 5),
        processEndDate: daysAgo(restDays),
        initialAlcoholPercentage: 60,
        inputVolumeLiters: 12100,
        outputVolumeLiters: 1500,
        wasteVolumeLiters: 330,
        additionalParams: {
          headDiscardLiters: 120,
          heartYieldLiters: 1500,
          tailDiscardLiters: 210,
        },
      },
    );
    return {
      lotId,
      harvestId,
      tankId,
      productionId: distillation.body.data.id as string,
      year,
    };
  }

  async function bottle(productionId: string, bottles: number) {
    const res = await checked('post', 'cinti', '/v1/bottling', 201, {
      productionBatchId: productionId,
      productType: 'SINGANI',
      finalAlcoholAbv: 40,
      waterDilutionLiters: 750,
      totalBottlesPackaged: bottles,
      packagingFormatCl: 75,
      bottlingDate: daysAgo(2),
    });
    return {
      bottlingId: res.body.data.id as string,
      lotCode: res.body.data.internationalLotCode as string,
    };
  }

  /** Código de botella bien formado que no existe en la base. */
  async function unusedBottleCode(): Promise<string> {
    for (;;) {
      const code = generateBottleCode();
      const used = await prisma.bottleUnit.findUnique({ where: { code } });
      if (!used) return code;
    }
  }

  // Lote principal: singani embotellado (2.950 botellas) con el reposo cumplido
  const main = {
    lotId: '',
    harvestId: '',
    tankId: '',
    productionId: '',
    bottlingId: '',
    lotCode: '',
    year: 0,
  };

  beforeAll(async () => {
    execFileSync(
      process.execPath,
      [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
      {
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          // Esquema propio: sin el candado de migraciones de toda la base, que
          // hace esperar (y caducar) a las suites que migran a la vez
          PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK: '1',
        },
        stdio: 'pipe',
      },
    );
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    process.env.DATABASE_URL = databaseUrl;
    process.env.PASSPORT_BASE_URL = 'https://pasaporte.e2e.test';
    process.env.API_PUBLIC_URL = 'https://api.e2e.test';
    process.env.LOT_BACKFILL_ON_BOOT = 'false';
    const storageEnv: Record<string, string> = {
      STORAGE_DRIVER: 'local',
      STORAGE_LOCAL_PATH: storageDir,
    };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(STORAGE_SERVICE)
      .useFactory({
        inject: [ConfigService],
        factory: (config: ConfigService) =>
          createObjectStorage({
            get: (key: string, def?: unknown) =>
              storageEnv[key] ?? config.get(key) ?? def,
            getOrThrow: (key: string) =>
              storageEnv[key] ?? config.getOrThrow(key),
          } as unknown as ConfigService),
      })
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
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
    // La contable de la semilla está de baja: una propia para estas pruebas
    const accountant = await createMember(app.get(PrismaService), {
      email: `contable-c-${run}@cintiviejo.test`,
      fullName: 'Contable del bloque C',
      organizationId: CINTI,
      role: MembershipRoleEnum.ACCOUNTANT,
    });
    tokens.cintiAccountant = await staffToken(app, {
      userId: accountant.user.id,
      email: accountant.user.email,
      organizationId: CINTI,
      organizationType: 'WINERY',
      role: MembershipRoleEnum.ACCOUNTANT,
    });
    tokens.altos = await tokenFor(
      'admin@altos.test',
      ALTOS,
      MembershipRoleEnum.OWNER,
    );
    const admin = await createPlatformUser(prisma, {
      email: `admin-o2c-${run}@drinksonchain.test`,
      password: 'Plataforma-o2c-123',
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
        email: `consumidor-c-${run}@e2e.test`,
        password: 'Consumidor-o2c-123',
        fullName: 'Consumidora del visor',
      })
      .expect(201);
    tokens.consumer = consumer.body.data.tokens.accessToken as string;

    Object.assign(main, await singaniLot('Singani Gran Reserva bloque C', 185));
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    if (prisma) {
      await prisma.$executeRawUnsafe(
        `DROP SCHEMA IF EXISTS "${schema}" CASCADE`,
      );
      await prisma.$disconnect();
    }
    rmSync(storageDir, { recursive: true, force: true });
    process.env.DATABASE_URL = originalUrl;
    delete process.env.PASSPORT_BASE_URL;
    delete process.env.API_PUBLIC_URL;
    delete process.env.LOT_BACKFILL_ON_BOOT;
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('vistas del lote (§11.1 y §11.3)', () => {
    it('balance antes de embotellar: mermas sin inventar y proyección desde el destilado (S-19)', async () => {
      const res = await checked(
        'get',
        'cinti',
        `/v1/lots/${main.lotId}/balance`,
        200,
      );
      expect(res.body.data).toMatchObject({
        harvest: {
          netKg: 18400,
          approvedKg: 18400,
          rejectedKg: 0,
          pendingKg: 0,
        },
        must: { filledLiters: 12100, litersPerKg: 0.658 },
        // El tanque no registró su volumen final: la merma no se supone en cero
        fermentation: {
          finalLiters: null,
          lossLiters: null,
          lossPercent: null,
        },
        distillation: {
          inputLiters: 12100,
          headsLiters: 120,
          heartLiters: 1500,
          tailsLiters: 210,
          heartAbvPercent: 60,
          pureAlcoholLiters: 900,
        },
        bottling: null,
        // 900 L de alcohol puro ÷ 40 % × (1 − 5 %) ÷ 0,75 L
        projection: { bottles: 2850, basis: 'DISTILLATE' },
      });
      expect(res.body.data.aging).toBeUndefined();

      const origin = await checked('post', 'cinti', '/v1/lots', 201, {
        name: 'Lote en origen bloque C',
        harvestYear: main.year,
        estimatedBottles: 1200,
      });
      const declared = await checked(
        'get',
        'cintiAccountant',
        `/v1/lots/${origin.body.data.id}/balance`,
        200,
      );
      expect(declared.body.data).toMatchObject({
        harvest: { netKg: 0 },
        must: { filledLiters: 0, litersPerKg: null },
        projection: { bottles: 1200, basis: 'DECLARED' },
      });
      // OPERATOR solo tiene la lectura mínima (§14): sin balance
      const operator = await call(
        'get',
        'cintiOperator',
        `/v1/lots/${main.lotId}/balance`,
      );
      expect(operator.status).toBe(403);
    });

    it('embotellado: balance con el del embotellado y proyección = códigos activos', async () => {
      Object.assign(main, await bottle(main.productionId, 2950));
      const res = await checked(
        'get',
        'cinti',
        `/v1/lots/${main.lotId}/balance`,
        200,
      );
      expect(res.body.data).toMatchObject({
        bottling: {
          availableLiters: 1500,
          waterDilutionLiters: 750,
          bottledLiters: 2212.5,
          lossPercent: 1.67,
          maxLossPercent: 5,
          pureAlcohol: { availableLiters: 900, bottledLiters: 885 },
        },
        projection: { bottles: 2950, basis: 'BOTTLED' },
      });
    });

    it('línea de tiempo: eventos en orden con su actor, registros tardíos y candados', async () => {
      const res = await checked(
        'get',
        'cintiOperator',
        `/v1/lots/${main.lotId}/timeline`,
        200,
      );
      const events = res.body.data.events as {
        seq: number;
        type: string;
        lateEntry: boolean;
        visibility: string;
        actor: { role: string } | null;
        resource: { type: string; id: string };
      }[];
      expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
      const types = events.map((e) => e.type);
      for (const type of [
        'LOT_CREATED',
        'HARVEST_WEIGHED',
        'PHYTO_DECIDED',
        'TANK_FILLED',
        'DISTILLATION_STARTED',
        'BOTTLED',
      ]) {
        expect(types).toContain(type);
      }
      const weighed = events.find((e) => e.type === 'HARVEST_WEIGHED');
      // El pesaje se declaró hace 200 días y se registró hoy (S-9)
      expect(weighed).toMatchObject({
        lateEntry: true,
        visibility: 'PUBLIC',
        actor: { role: 'OPERATOR' },
        resource: { id: main.harvestId },
      });
      expect(events.find((e) => e.type === 'LOT_CREATED')).toMatchObject({
        lateEntry: false,
        visibility: 'INTERNAL',
        actor: { role: 'OWNER' },
      });
      expect(res.body.data.locks).toHaveLength(1);
      expect(res.body.data.locks[0]).toMatchObject({
        kind: 'REST',
        sourceId: main.productionId,
        released: true,
        rule: { minimum: 180 },
      });
      expect(res.body.data.estimatedReadyBasis).toBe('LOCK');

      const other = await checked(
        'get',
        'altos',
        `/v1/lots/${main.lotId}/timeline`,
        404,
      );
      expect(other.body.error.code).toBe('TRC_LOT_NOT_FOUND');
      await checked(
        'get',
        'platform',
        `/v1/lots/${main.lotId}/timeline?wineryId=${CINTI}`,
        200,
      );
    });

    it('grafo con datos reales; otra bodega y cualquier otra sesión → 404 (SE-07)', async () => {
      const res = await checked(
        'get',
        'cinti',
        `/v1/lots/${main.lotId}/graph`,
        200,
      );
      const graph = res.body.data as {
        lotCode: string;
        productType: string;
        nodes: {
          id: string;
          type: string;
          quantity: { value: number; unit: string } | null;
          metrics: { key: string; value: number | string | null }[];
          actor: { role: string } | null;
          status: string;
        }[];
        edges: {
          from: string;
          to: string;
          quantity: { value: number; unit: string } | null;
        }[];
      };
      expect(graph).toMatchObject({
        lotCode: main.lotCode,
        productType: 'SINGANI',
      });
      const node = (type: string) => graph.nodes.find((n) => n.type === type);
      const metricOf = (type: string, key: string) =>
        node(type)?.metrics.find((m) => m.key === key)?.value;
      expect(graph.nodes.map((n) => n.type)).toEqual([
        'TERROIR',
        'HARVEST_BATCH',
        'TANK',
        'DISTILLATION',
        'BOTTLING',
      ]);
      expect(node('HARVEST_BATCH')).toMatchObject({
        id: main.harvestId,
        quantity: { value: 18400, unit: 'kg' },
        actor: { role: 'OPERATOR' },
        status: 'APPROVED',
      });
      expect(metricOf('HARVEST_BATCH', 'brixDegrees')).toBe(23.5);
      // No registrado = null (nunca un valor de relleno, EA-05)
      expect(metricOf('TANK', 'finalVolumeLiters')).toBeNull();
      expect(metricOf('TANK', 'lastTemperatureC')).toBeNull();
      expect(metricOf('HARVEST_BATCH', 'temperatureAtIntakeC')).toBeNull();
      expect(node('DISTILLATION')).toMatchObject({
        quantity: { value: 1500, unit: 'L' },
        status: 'BOTTLED',
      });
      expect(node('BOTTLING')).toMatchObject({
        id: main.bottlingId,
        quantity: { value: 2950, unit: 'bottles' },
      });
      expect(graph.edges).toEqual(
        expect.arrayContaining([
          {
            from: main.harvestId,
            to: main.tankId,
            quantity: { value: 18400, unit: 'kg' },
          },
          {
            from: main.tankId,
            to: main.productionId,
            quantity: { value: 12100, unit: 'L' },
          },
          {
            from: main.productionId,
            to: main.bottlingId,
            quantity: { value: 1500, unit: 'L' },
          },
        ]),
      );

      await checked('get', 'platform', `/v1/lots/${main.lotId}/graph`, 200);
      await checked(
        'get',
        'cintiOperator',
        `/v1/lots/${main.lotId}/graph`,
        200,
      );
      for (const who of ['altos', 'consumer'] as const) {
        const denied = await checked(
          'get',
          who,
          `/v1/lots/${main.lotId}/graph`,
          404,
        );
        expect(denied.body.error.code).toBe('TRC_LOT_NOT_FOUND');
      }
      const anonymous = await call(
        'get',
        'nobody',
        `/v1/lots/${main.lotId}/graph`,
      );
      expect(anonymous.status).toBe(401);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('panel y reporte de producción (§11.2 y §11.4)', () => {
    let resting: Awaited<ReturnType<typeof singaniLot>>;
    let hotTankId: string;
    let silentTankId: string;
    let pendingHarvestId: string;

    beforeAll(async () => {
      // Reposo que se libera en 10 días (180 − 170)
      resting = await singaniLot('Singani en reposo bloque C', 170);

      // Uva recibida sin lote y sin dictamen
      const pending = await checked(
        'post',
        'cintiOperator',
        '/v1/harvest-batches',
        201,
        {
          terroirId: await terroirId(CINTI, 'El Molino'),
          intakeDate: daysAgo(4),
          grossWeightKg: 2100,
          tareWeightKg: 100,
        },
      );
      pendingHarvestId = pending.body.data.id as string;

      // Dos tanques fermentando: uno caliente con lectura reciente y otro sin lecturas hace 3 días
      const tankFor = async (code: string, startedDaysAgo: number) => {
        const harvest = await checked(
          'post',
          'cinti',
          '/v1/harvest-batches',
          201,
          {
            newLot: {
              name: `Fermentación ${code}`,
              harvestYear: Number(daysAgo(startedDaysAgo + 1).slice(0, 4)),
            },
            terroirId: await terroirId(CINTI, 'Los Parrales'),
            intakeDate: daysAgo(startedDaysAgo + 1),
            grossWeightKg: 1100,
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
            tankCode: `${code}-${run}`,
            volumeFilledLiters: 650,
            startFermentation: true,
            startDate: `${daysAgo(startedDaysAgo)}T10:00:00Z`,
          },
        );
        expect(tank.body.data.status).toBe('FERMENTING');
        return tank.body.data.id as string;
      };
      hotTankId = await tankFor('TK-HOT', 2);
      silentTankId = await tankFor('TK-SILENT', 3);
      await checked(
        'post',
        'cintiOperator',
        `/v1/fermentation-tanks/${hotTankId}/logs`,
        201,
        {
          temperatureCelsius: 33.5,
          recordedAt: new Date(Date.now() - 3_600_000).toISOString(),
        },
      );
    }, 120_000);

    it('panel: etapas, candados próximos, alertas, dictámenes pendientes y lotes sin laboratorio', async () => {
      const res = await checked(
        'get',
        'cinti',
        '/v1/traceability/dashboard',
        200,
      );
      const panel = res.body.data;
      const stages = await prisma.lot.groupBy({
        by: ['stage'],
        where: { wineryId: CINTI },
        _count: { _all: true },
      });
      for (const row of stages) {
        expect(panel.lotsByStage[row.stage]).toBe(row._count._all);
      }
      expect(panel.lotsByStage.ANCHORED).toBe(0);

      const due = panel.locksDueSoon.find(
        (l: { lotId: string }) => l.lotId === resting.lotId,
      );
      expect(due).toMatchObject({
        name: 'Singani en reposo bloque C',
        lock: {
          kind: 'REST',
          sourceId: resting.productionId,
          released: false,
        },
      });
      // 180 − 170 días; 11 mientras en La Paz aún es el día anterior al de UTC
      expect([10, 11]).toContain(due.lock.daysRemaining);
      expect(
        panel.locksDueSoon.some(
          (l: { lotId: string }) => l.lotId === main.lotId,
        ),
      ).toBe(false);

      const alerts = panel.fermentationAlerts as {
        tankId: string;
        kind: string;
        value: number | null;
        lastReadingAt: string | null;
      }[];
      expect(alerts.filter((a) => a.tankId === hotTankId)).toEqual([
        expect.objectContaining({ kind: 'HIGH_TEMPERATURE', value: 33.5 }),
      ]);
      expect(alerts.filter((a) => a.tankId === silentTankId)).toEqual([
        expect.objectContaining({
          kind: 'NO_READING',
          value: null,
          lastReadingAt: null,
        }),
      ]);

      expect(panel.pendingPhyto).toEqual(
        expect.arrayContaining([
          {
            harvestBatchId: pendingHarvestId,
            harvestBatchCode: expect.any(String),
            lotId: null,
            intakeDate: daysAgo(4),
            status: 'PENDING_INSPECTION',
          },
        ]),
      );
      expect(panel.unassignedHarvestBatches).toBe(
        await prisma.harvestBatch.count({
          where: { wineryId: CINTI, lotId: null },
        }),
      );
      const ids = (list: { id: string }[]) => list.map((l) => l.id);
      expect(ids(panel.bottledWithoutLab)).toContain(main.lotId);
      expect(ids(panel.readyToClose)).not.toContain(main.lotId);

      // OPERATOR no tiene panel (§14); la plataforma lo lee con ?wineryId=
      expect(
        (await call('get', 'cintiOperator', '/v1/traceability/dashboard'))
          .status,
      ).toBe(403);
      const platform = await checked(
        'get',
        'platform',
        `/v1/traceability/dashboard?wineryId=${CINTI}`,
        200,
      );
      expect(platform.body.data.lotsByStage).toEqual(panel.lotsByStage);
      const other = await checked(
        'get',
        'altos',
        '/v1/traceability/dashboard',
        200,
      );
      expect(
        other.body.data.locksDueSoon.some(
          (l: { lotId: string }) => l.lotId === resting.lotId,
        ),
      ).toBe(false);
    });

    it('con el laboratorio conforme el lote queda listo para cerrar', async () => {
      await checked('post', 'cinti', '/v1/lab-analyses', 201, {
        bottlingBatchId: main.bottlingId,
        certifiedLaboratoryName: 'Laboratorio bloque C ISO 17025',
        accreditedLabCertificationCode: `LAB-C-${run}`,
        testPerformedAt: daysAgo(2),
        actualAlcoholAbv: 40.05,
        totalAcidityTartaricGl: 4.8,
        volatileAcidityAceticGl: 0.22,
        copperContentMgL: 0.02,
        methanolContentMgL: 48,
        laboratoryReportPdfUrl: 'https://laboratorio.e2e.test/informe.pdf',
      });
      const res = await checked(
        'get',
        'cinti',
        '/v1/traceability/dashboard',
        200,
      );
      const ids = (list: { id: string }[]) => list.map((l) => l.id);
      expect(ids(res.body.data.bottledWithoutLab)).not.toContain(main.lotId);
      expect(ids(res.body.data.readyToClose)).toContain(main.lotId);
    });

    it('reporte de producción: fila por lote, totales por tipo, CSV y límites', async () => {
      const res = await checked(
        'get',
        'cintiAccountant',
        `/v1/traceability/reports/production?from=${daysAgo(1)}&productType=SINGANI`,
        200,
      );
      const rows = res.body.data.rows as { lotId: string }[];
      expect(rows.find((r) => r.lotId === main.lotId)).toMatchObject({
        lotCode: main.lotCode,
        productType: 'SINGANI',
        stage: 'BOTTLED',
        netKg: 18400,
        mustLiters: 12100,
        baseWineLiters: null,
        heartLiters: 1500,
        bottledLiters: 2212.5,
        bottles: 2950,
        formatCl: 75,
        lossPercentByStage: {
          fermentation: null,
          transfer: 0,
          distillation: 84.88,
          bottling: 1.67,
        },
        litersPerKg: 0.658,
        bottlesPerTonne: 160.33,
        bottlingDate: daysAgo(2),
        labStatus: 'CONFORMING',
      });
      expect(rows.find((r) => r.lotId === resting.lotId)).toMatchObject({
        stage: 'RESTING',
        bottles: null,
        bottledLiters: null,
        labStatus: 'NOT_RECORDED',
      });
      const totals = res.body.data.totals;
      expect(totals.SINGANI).toMatchObject({
        lots: rows.length,
        netKg: 18400 * rows.length,
        bottles: 2950,
      });
      expect(totals.WINE.lots).toBe(0);
      expect(totals.UNDECIDED.lots).toBe(0);

      const staged = await checked(
        'get',
        'cinti',
        '/v1/traceability/reports/production?stage=RESTING,DISTILLING',
        200,
      );
      expect(
        staged.body.data.rows.every(
          (r: { stage: string }) => r.stage === 'RESTING',
        ),
      ).toBe(true);

      const csv = await call(
        'get',
        'cinti',
        `/v1/traceability/reports/production?format=csv&from=${daysAgo(1)}&productType=SINGANI`,
      );
      expect(csv.status).toBe(200);
      expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(csv.headers['content-disposition']).toMatch(
        /^attachment; filename="reporte-produccion-\d{4}-\d{2}-\d{2}\.csv"$/,
      );
      // Empieza por la marca de orden de bytes (las hojas de cálculo lo leen como UTF-8)
      expect(csv.text.charCodeAt(0)).toBe(0xfeff);
      const lines = csv.text.slice(1).trim().split('\r\n');
      expect(lines[0]).toBe(
        'lotId,reference,lotCode,name,productType,harvestYear,stage,netKg,mustLiters,baseWineLiters,heartLiters,' +
          'bottledLiters,bottles,formatCl,lossPercentFermentation,lossPercentTransfer,lossPercentDistillation,' +
          'lossPercentBottling,litersPerKg,bottlesPerTonne,bottlingDate,labStatus',
      );
      expect(lines).toHaveLength(rows.length + 1);
      const mainLine = lines.find((l) => l.startsWith(main.lotId));
      expect(mainLine).toContain(`,${main.lotCode},`);
      expect(mainLine).toContain(',18400,12100,,1500,2212.5,2950,75,');

      for (const query of [
        'stage=NOPE',
        `from=${daysAgo(1)}&to=${daysAgo(5)}`,
        'format=xlsx',
      ]) {
        const bad = await checked(
          'get',
          'cinti',
          `/v1/traceability/reports/production?${query}`,
          422,
        );
        expect(bad.body.error.code).toBe('VALIDATION_ERROR');
      }

      // Más de 10 000 filas → 422 (se simula el recuento: no se crean 10 001 lotes)
      const count = jest
        .spyOn(app.get(PrismaService).lot, 'count')
        .mockResolvedValueOnce(10_001);
      const tooLarge = await checked(
        'get',
        'cinti',
        '/v1/traceability/reports/production',
        422,
      );
      count.mockRestore();
      expect(tooLarge.body.error).toMatchObject({
        code: 'TRC_REPORT_TOO_LARGE',
        details: [{ meta: { rows: 10_001 } }],
      });

      // AGRONOMIST y OPERATOR no tienen reportes (§14)
      expect(
        (
          await call(
            'get',
            'cintiOperator',
            '/v1/traceability/reports/production',
          )
        ).status,
      ).toBe(403);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('archivos del lote (§11.5, S-20)', () => {
    let labelId: string;
    let photoId: string;

    it('adjuntar: privado por defecto, la etiqueta nace pública y la clave debe ser de la bodega', async () => {
      const labelKey = await upload('cinti', PNG, 'etiqueta.png', 'image/png');
      const label = await checked(
        'post',
        'cinti',
        `/v1/lots/${main.lotId}/attachments`,
        201,
        { key: labelKey, kind: 'LABEL', title: '  Etiqueta frontal  ' },
      );
      labelId = label.body.data.id;
      expect(label.body.data).toMatchObject({
        kind: 'LABEL',
        title: 'Etiqueta frontal',
        key: labelKey,
        mimeType: 'image/png',
        sizeBytes: PNG.length,
        sha256: createHash('sha256').update(PNG).digest('hex'),
        visibility: 'PUBLIC',
        createdBy: { role: 'OWNER' },
      });
      expect(label.body.data.url).toContain('/v1/uploads/local?key=');

      const photoKey = await upload(
        'cintiOperator',
        PDF,
        'ficha.pdf',
        'application/pdf',
      );
      const photo = await checked(
        'post',
        'cintiOperator',
        `/v1/lots/${main.lotId}/attachments`,
        201,
        { key: photoKey, kind: 'OTHER', title: 'Ficha técnica' },
      );
      photoId = photo.body.data.id;
      expect(photo.body.data).toMatchObject({
        visibility: 'PRIVATE',
        mimeType: 'application/pdf',
        createdBy: { role: 'OPERATOR' },
      });

      // Solo OWNER o ENOLOGIST publican algo que no sea la etiqueta
      const pushy = await call(
        'post',
        'cintiOperator',
        `/v1/lots/${main.lotId}/attachments`,
        {
          key: photoKey,
          kind: 'PHOTO',
          title: 'Foto',
          visibility: 'PUBLIC',
        },
      );
      expect(pushy.status).toBe(403);

      const foreignKey = await upload('altos', PNG, 'ajena.png', 'image/png');
      for (const key of [
        foreignKey,
        `org/${CINTI}/lotes/2026/01/no-existe.png`,
        '../../etc/passwd',
      ]) {
        const missing = await checked(
          'post',
          'cinti',
          `/v1/lots/${main.lotId}/attachments`,
          422,
          { key, kind: 'PHOTO', title: 'Archivo ajeno' },
        );
        expect(missing.body.error).toMatchObject({
          code: 'TRC_FILE_NOT_FOUND',
          details: [{ field: 'key', code: 'TRC_FILE_NOT_FOUND' }],
        });
      }

      const otherLot = await checked(
        'post',
        'altos',
        `/v1/lots/${main.lotId}/attachments`,
        404,
        { key: foreignKey, kind: 'PHOTO', title: 'En lote ajeno' },
      );
      expect(otherLot.body.error.code).toBe('TRC_LOT_NOT_FOUND');
      const platform = await checked(
        'post',
        'platform',
        `/v1/lots/${main.lotId}/attachments?wineryId=${CINTI}`,
        403,
        { key: labelKey, kind: 'PHOTO', title: 'Plataforma' },
      );
      expect(platform.body.error.code).toBe('TRC_PLATFORM_READ_ONLY');
    });

    it('lista con URL firmadas; el operario solo ve los suyos; la plataforma y contabilidad leen', async () => {
      const all = await checked(
        'get',
        'cinti',
        `/v1/lots/${main.lotId}/attachments`,
        200,
      );
      expect(all.body.data.total).toBe(2);
      expect(
        all.body.data.items.map((a: { id: string }) => a.id).sort(),
      ).toEqual([labelId, photoId].sort());
      const signed = new URL(all.body.data.items[0].url);
      const file = await http()
        .get(`${signed.pathname}${signed.search}`)
        .expect(200);
      expect(file.headers['content-type']).toMatch(
        /^(image\/png|application\/pdf)/,
      );

      const own = await checked(
        'get',
        'cintiOperator',
        `/v1/lots/${main.lotId}/attachments`,
        200,
      );
      expect(own.body.data.items.map((a: { id: string }) => a.id)).toEqual([
        photoId,
      ]);
      for (const [who, query] of [
        ['cintiAccountant', ''],
        ['platform', `?wineryId=${CINTI}`],
      ] as const) {
        const read = await checked(
          'get',
          who,
          `/v1/lots/${main.lotId}/attachments${query}`,
          200,
        );
        expect(read.body.data.total).toBe(2);
      }
      await checked('get', 'altos', `/v1/lots/${main.lotId}/attachments`, 404);
    });

    it('cambiar la visibilidad registra el cambio sin editar el adjunto', async () => {
      const path = `/v1/lots/${main.lotId}/attachments/${photoId}/visibility`;
      expect(
        (await call('post', 'cintiOperator', path, { visibility: 'PUBLIC' }))
          .status,
      ).toBe(403);
      const published = await checked('post', 'cinti', path, 200, {
        visibility: 'PUBLIC',
      });
      expect(published.body.data).toMatchObject({
        id: photoId,
        visibility: 'PUBLIC',
      });
      // La fila del adjunto no se toca: el cambio vive en la línea de tiempo
      const row = await prisma.lotAttachment.findUniqueOrThrow({
        where: { id: photoId },
      });
      expect(row.visibility).toBe('PRIVATE');
      const before = await prisma.lotEvent.count({
        where: { lotId: main.lotId, type: 'FILE_ATTACHED' },
      });
      // Repetir la visibilidad vigente no registra nada
      await checked('post', 'cinti', path, 200, { visibility: 'PUBLIC' });
      expect(
        await prisma.lotEvent.count({
          where: { lotId: main.lotId, type: 'FILE_ATTACHED' },
        }),
      ).toBe(before);

      const hidden = await checked('post', 'cinti', path, 200, {
        visibility: 'PRIVATE',
      });
      expect(hidden.body.data.visibility).toBe('PRIVATE');
      const listed = await checked(
        'get',
        'cinti',
        `/v1/lots/${main.lotId}/attachments`,
        200,
      );
      expect(
        listed.body.data.items.find((a: { id: string }) => a.id === photoId)
          .visibility,
      ).toBe('PRIVATE');

      const audit = await prisma.auditEvent.findMany({
        where: {
          resourceId: photoId,
          action: 'ATTACHMENT_VISIBILITY_CHANGED',
        },
        orderBy: { seq: 'asc' },
      });
      expect(audit.map((a) => a.after)).toEqual([
        { visibility: 'PUBLIC', lotId: main.lotId },
        { visibility: 'PRIVATE', lotId: main.lotId },
      ]);
      const timeline = await checked(
        'get',
        'cinti',
        `/v1/lots/${main.lotId}/timeline`,
        200,
      );
      expect(
        timeline.body.data.events.filter(
          (e: { type: string }) => e.type === 'FILE_ATTACHED',
        ),
      ).toHaveLength(4);

      const unknown = await checked(
        'post',
        'cinti',
        `/v1/lots/${main.lotId}/attachments/${main.harvestId}/visibility`,
        404,
        { visibility: 'PUBLIC' },
      );
      expect(unknown.body.error.code).toBe('NOT_FOUND');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('pasaporte público (§12; PUB-01, PUB-02, PUB-05; EA-05)', () => {
    let bottleCode: string;

    beforeAll(async () => {
      const unit = await prisma.bottleUnit.findFirstOrThrow({
        where: { lotId: main.lotId, serial: 1234 },
      });
      bottleCode = unit.code;
    });

    it('lote: solo datos registrados, roles y no nombres, sin pesos ni volúmenes', async () => {
      const res = await checked(
        'get',
        'nobody',
        `/v1/public/passports/${main.lotCode}`,
        200,
      );
      const passport = res.body.data;
      expect(passport).toMatchObject({
        kind: 'LOT',
        lotCode: main.lotCode,
        name: 'Singani Gran Reserva bloque C',
        productType: 'SINGANI',
        vintage: main.year,
        stage: 'BOTTLED',
        winery: { slug: expect.any(String), active: true },
        denomination: {
          applies: true,
          status: 'ELIGIBLE',
          rules: {
            minAltitudeMasl: 1600,
            requiredVarieties: ['Moscatel de Alejandría'],
          },
          legalException: false,
        },
        origin: {
          status: 'RECORDED',
          terroirs: [
            {
              parcelName: 'Parcela 1 · Los Parrales',
              altitudeMasl: 2350,
              variety: 'Moscatel de Alejandría',
              doStatus: 'ELIGIBLE',
            },
          ],
        },
        harvest: {
          status: 'RECORDED',
          firstIntakeDate: daysAgo(200),
          lastIntakeDate: daysAgo(200),
          phytosanitary: 'APPROVED',
          maturity: { brixDegrees: 23.5, ph: 3.5, acidityGl: 5.8 },
        },
        // El tanque no registró el fin de la fermentación ni lecturas: nada inventado
        fermentation: {
          status: 'RECORDED',
          endDate: null,
          readingsCount: 0,
          treatments: [],
        },
        aging: {
          status: 'NOT_APPLICABLE',
          containerType: null,
          plannedMonths: null,
          unlockDate: null,
        },
        distillation: {
          status: 'RECORDED',
          startDate: daysAgo(190),
          endDate: daysAgo(185),
          heartAbvPercent: 60,
          restMinDays: 180,
          restUntil: daysAgo(5),
        },
        bottling: {
          status: 'RECORDED',
          date: daysAgo(2),
          bottles: 2950,
          formatCl: 75,
          finalAbv: 40,
        },
        lab: {
          status: 'CONFORMING',
          laboratoryName: 'Laboratorio bloque C ISO 17025',
          testedAt: daysAgo(2),
        },
        rules: { origin: 'LOT_CREATION' },
        corrections: { count: 0, lastAt: null },
        // El expediente no está cerrado: el pasaporte lo dice
        dossier: {
          status: 'OPEN',
          hash: null,
          closedAt: null,
          canonicalUrl: null,
          anchor: null,
        },
      });
      expect(
        passport.lab.checks.map((c: { parameter: string }) => c.parameter),
      ).toEqual(expect.arrayContaining(['metanol', 'cobre', 'grado']));
      expect(passport.rules.items.map((i: { key: string }) => i.key)).toEqual(
        expect.arrayContaining([
          'trazabilidad.singani.altitudMinimaMsnm',
          'trazabilidad.singani.reposoMinimoDias',
        ]),
      );

      const timeline = passport.timeline as {
        type: string;
        summary: string;
        actorRole: string | null;
        lateEntry: boolean;
      }[];
      expect(timeline.map((e) => e.type)).toEqual(
        expect.arrayContaining(['HARVEST_WEIGHED', 'PHYTO_DECIDED', 'BOTTLED']),
      );
      // Solo los eventos públicos: ni la creación del lote ni los archivos
      expect(timeline.map((e) => e.type)).not.toContain('LOT_CREATED');
      expect(timeline.map((e) => e.type)).not.toContain('FILE_ATTACHED');
      expect(timeline.find((e) => e.type === 'HARVEST_WEIGHED')).toMatchObject({
        summary: 'Uva recibida y pesada en la bodega',
        actorRole: 'OPERATOR',
        lateEntry: true,
      });

      // S-21 y S-22: ni nombres, ni correos, ni kilos, ni litros, ni claves de archivos
      const text = JSON.stringify(passport);
      const people = await prisma.user.findMany({
        where: { memberships: { some: { organizationId: CINTI } } },
        select: { fullName: true, email: true },
      });
      for (const person of people) {
        expect(text).not.toContain(person.fullName);
        expect(text).not.toContain(person.email);
      }
      // Ninguna clave de persona, peso, volumen, dosis, merma, nota ni archivo…
      const keys = new Set<string>();
      const numbers = new Set<number>();
      const walk = (value: unknown): void => {
        if (typeof value === 'number') numbers.add(value);
        if (typeof value !== 'object' || value === null) return;
        if (Array.isArray(value)) return value.forEach(walk);
        for (const [key, child] of Object.entries(value)) {
          keys.add(key);
          walk(child);
        }
      };
      walk(passport);
      const forbidden =
        /name$|email|membership|userId|kg|weight|liters|volume|dosage|loss|notes|storage/i;
      const allowedNames = new Set([
        'name',
        'parcelName',
        'tradeName',
        'laboratoryName',
      ]);
      expect(
        [...keys].filter((k) => forbidden.test(k) && !allowedNames.has(k)),
      ).toEqual([]);
      // …ni las cifras internas del lote: kilos, mosto, corazón, litros embotellados
      for (const figure of [18400, 18500, 12100, 1500, 2212.5, 750, 900]) {
        expect([...numbers]).not.toContain(figure);
      }
      expect(text).not.toContain('org/');

      // La etiqueta nació pública; la ficha técnica volvió a privada
      expect(passport.publicAttachments).toEqual([
        {
          id: expect.any(String),
          kind: 'LABEL',
          title: 'Etiqueta frontal',
          url: `https://api.e2e.test/v1/public/lots/${main.lotCode}/attachments/${passport.publicAttachments[0].id}`,
        },
      ]);

      const direct = await checked(
        'get',
        'nobody',
        `/v1/public/lots/${main.lotCode.toLowerCase()}`,
        200,
      );
      expect(direct.body.data.lotCode).toBe(main.lotCode);
    });

    it('botella: número de serie, total del lote y código normalizado; sin prueba hasta cerrar el expediente', async () => {
      const res = await checked(
        'get',
        'nobody',
        `/v1/public/passports/${bottleCode}`,
        200,
      );
      expect(res.body.data).toMatchObject({
        kind: 'BOTTLE',
        bottle: {
          code: bottleCode,
          codeFormatted: formatBottleCode(bottleCode),
          serial: 1234,
          lotTotal: 2950,
          status: 'ACTIVE',
          merkleProof: null,
        },
        lot: { kind: 'LOT', lotCode: main.lotCode },
        redemption: null,
      });
      // Como se imprime en la etiqueta (XXXX-XXXX) y en minúsculas
      const typed = await checked(
        'get',
        'nobody',
        `/v1/public/bottles/${formatBottleCode(bottleCode).toLowerCase()}`,
        200,
      );
      expect(typed.body.data.bottle.code).toBe(bottleCode);
    });

    it('caché: Cache-Control, ETag y 304; el pasaporte cambia con cada evento del lote', async () => {
      const path = `/v1/public/lots/${main.lotCode}`;
      const first = await call('get', 'nobody', path);
      expect(first.headers['cache-control']).toBe(
        'public, max-age=60, stale-while-revalidate=600',
      );
      const etag = first.headers.etag as string;
      expect(etag).toMatch(/^W\/"[0-9a-f]{32}"$/);
      const again = await call('get', 'nobody', path);
      expect(again.headers.etag).toBe(etag);
      // Servido de la caché: la misma generación
      expect(again.body.data.generatedAt).toBe(first.body.data.generatedAt);

      const notModified = await http()
        .get(path)
        .set('X-Forwarded-For', nextIp())
        .set('If-None-Match', etag);
      expect(notModified.status).toBe(304);

      // Un evento del lote (un archivo público nuevo) invalida la entrada
      const key = await upload('cinti', PNG, 'contra.png', 'image/png');
      await checked(
        'post',
        'cinti',
        `/v1/lots/${main.lotId}/attachments`,
        201,
        { key, kind: 'LABEL', title: 'Contraetiqueta' },
      );
      const fresh = await call('get', 'nobody', path);
      expect(fresh.headers.etag).not.toBe(etag);
      expect(fresh.body.data.publicAttachments).toHaveLength(2);
    });

    it('adjunto público: 302 a una URL firmada; el privado y el inexistente → 404', async () => {
      const passport = await call(
        'get',
        'nobody',
        `/v1/public/lots/${main.lotCode}`,
      );
      const label = passport.body.data.publicAttachments[0] as {
        id: string;
        url: string;
      };
      const redirect = await call('get', 'nobody', new URL(label.url).pathname);
      expect(redirect.status).toBe(302);
      expect(redirect.headers['cache-control']).toBe('no-store');
      const location = new URL(redirect.headers.location);
      expect(location.pathname).toBe('/v1/uploads/local');
      const file = await http()
        .get(`${location.pathname}${location.search}`)
        .expect(200);
      expect(file.headers['content-type']).toMatch(/^image\/png/);

      const privateOne = await prisma.lotAttachment.findFirstOrThrow({
        where: { lotId: main.lotId, kind: 'OTHER' },
      });
      for (const id of [privateOne.id, main.harvestId]) {
        const res = await checked(
          'get',
          'nobody',
          `/v1/public/lots/${main.lotCode}/attachments/${id}`,
          404,
        );
        expect(res.body.error.code).toBe('PUB_CODE_NOT_FOUND');
      }
    });

    it('código inexistente → 404 uniforme (cacheado 30 s); forma imposible o control inválido → 422', async () => {
      const missingBottle = await unusedBottleCode();
      const responses = [
        await checked(
          'get',
          'nobody',
          `/v1/public/passports/${missingBottle}`,
          404,
        ),
        await checked(
          'get',
          'nobody',
          `/v1/public/bottles/${missingBottle}`,
          404,
        ),
        await checked(
          'get',
          'nobody',
          '/v1/public/passports/CVJ-2031-SINGANI-999',
          404,
        ),
        await checked(
          'get',
          'nobody',
          '/v1/public/lots/CVJ-2031-SINGANI-999',
          404,
        ),
        await checked(
          'get',
          'nobody',
          '/v1/public/lots/CVJ-2031-SINGANI-999/dossier',
          404,
        ),
        // El id interno del lote no es un código del visor
        await checked(
          'get',
          'nobody',
          `/v1/public/passports/${main.lotId}`,
          404,
        ),
      ];
      for (const res of responses) {
        expect(res.body.error).toMatchObject({
          code: 'PUB_CODE_NOT_FOUND',
          message: 'Código no encontrado',
          details: null,
        });
        expect(res.headers['cache-control']).toBe('public, max-age=30');
      }

      // Control inválido: el último carácter cambiado
      const last = bottleCode[bottleCode.length - 1];
      const wrongCheck = bottleCode.slice(0, -1) + (last === '0' ? '1' : '0');
      expect(isValidBottleCode(wrongCheck)).toBe(false);
      for (const path of [
        `/v1/public/passports/${wrongCheck}`,
        `/v1/public/bottles/${wrongCheck}`,
        '/v1/public/bottles/UUUUUUUU',
        '/v1/public/passports/x',
        '/v1/public/lots/--',
        `/v1/public/passports/${'A'.repeat(150)}`,
      ]) {
        const res = await checked('get', 'nobody', path, 422);
        expect(res.body.error.code).toBe('PUB_CODE_MALFORMED');
        expect(res.headers['cache-control']).toBe('no-store');
      }
    });

    it('enumeración: más de 20 códigos inexistentes en 10 min desde una IP → 429 con Retry-After (S-24)', async () => {
      const ip = freshIp();
      for (let i = 0; i < 20; i++) {
        const res = await call(
          'get',
          'nobody',
          `/v1/public/passports/${await unusedBottleCode()}`,
          undefined,
          ip,
        );
        expect({ attempt: i + 1, status: res.status }).toEqual({
          attempt: i + 1,
          status: 404,
        });
      }
      const blocked = await checked(
        'get',
        'nobody',
        `/v1/public/passports/${await unusedBottleCode()}`,
        429,
        undefined,
        ip,
      );
      expect(blocked.body.error.code).toBe('PUB_TOO_MANY_LOOKUPS');
      const retryAfter = Number(blocked.headers['retry-after']);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(600);
      expect(blocked.headers['cache-control']).toBe('no-store');

      // Bloqueada también para los códigos que sí existen, en todas las rutas del pasaporte
      for (const path of [
        `/v1/public/passports/${bottleCode}`,
        `/v1/public/lots/${main.lotCode}`,
        `/v1/public/bottles/${bottleCode}`,
      ]) {
        const res = await checked('get', 'nobody', path, 429, undefined, ip);
        expect(res.body.error.code).toBe('PUB_TOO_MANY_LOOKUPS');
      }
      // Otra IP no se ve afectada, y los códigos mal formados no cuentan
      const other = freshIp();
      for (let i = 0; i < 25; i++) {
        const res = await call(
          'get',
          'nobody',
          '/v1/public/passports/no',
          undefined,
          other,
        );
        expect(res.status).toBe(422);
      }
      await checked(
        'get',
        'nobody',
        `/v1/public/passports/${bottleCode}`,
        200,
        undefined,
        other,
      );
    });

    it('límite de peticiones: 60 por minuto e IP en todas las rutas del pasaporte juntas', async () => {
      const ip = freshIp();
      const paths = [
        `/v1/public/passports/${main.lotCode}`,
        `/v1/public/lots/${main.lotCode}`,
        `/v1/public/bottles/${bottleCode}`,
      ];
      for (let i = 0; i < 60; i++) {
        const res = await call('get', 'nobody', paths[i % 3], undefined, ip);
        expect(res.status).toBe(200);
      }
      const limited = await call('get', 'nobody', paths[0], undefined, ip);
      expect(limited.status).toBe(429);
      expect(limited.body.error.code).toBe('TOO_MANY_REQUESTS');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      // El resto de la API no comparte ese contador
      const wineries = await call(
        'get',
        'nobody',
        '/v1/public/wineries',
        undefined,
        ip,
      );
      expect(wineries.status).toBe(200);
    });

    it('botella anulada: el pasaporte sigue respondiendo con el aviso (VOIDED)', async () => {
      const unit = await prisma.bottleUnit.findFirstOrThrow({
        where: { lotId: main.lotId, serial: 77 },
      });
      const before = await call(
        'get',
        'nobody',
        `/v1/public/bottles/${unit.code}`,
      );
      expect(before.body.data.bottle.status).toBe('ACTIVE');
      await prisma.bottleUnit.update({
        where: { id: unit.id },
        data: {
          status: 'VOIDED',
          voidedAt: new Date(),
          voidReason: 'Etiqueta dañada (e2e)',
        },
      });
      const res = await checked(
        'get',
        'nobody',
        `/v1/public/passports/${unit.code}`,
        200,
      );
      expect(res.body.data).toMatchObject({
        kind: 'BOTTLE',
        bottle: { code: unit.code, serial: 77, status: 'VOIDED' },
        lot: { lotCode: main.lotCode, stage: 'BOTTLED' },
      });
      expect(res.headers.etag).not.toBe(before.headers.etag);
      // El motivo de la anulación es interno
      expect(JSON.stringify(res.body.data)).not.toContain('Etiqueta dañada');
    });

    it('bodega suspendida: el pasaporte sigue visible con winery.active = false (S-23)', async () => {
      await prisma.winery.update({
        where: { id: CINTI },
        data: { certificationStatus: 'SUSPENDED' },
      });
      try {
        const res = await checked(
          'get',
          'nobody',
          `/v1/public/passports/${main.lotCode}`,
          200,
        );
        expect(res.body.data.winery.active).toBe(false);
        const byBottle = await checked(
          'get',
          'nobody',
          `/v1/public/passports/${bottleCode}`,
          200,
        );
        expect(byBottle.body.data.lot.winery.active).toBe(false);
      } finally {
        await prisma.winery.update({
          where: { id: CINTI },
          data: { certificationStatus: 'ACTIVE' },
        });
      }
      const back = await call(
        'get',
        'nobody',
        `/v1/public/passports/${main.lotCode}`,
      );
      expect(back.body.data.winery.active).toBe(true);
    });

    it('expediente cerrado: huella, bytes canónicos y prueba Merkle de la botella', async () => {
      const dossierPath = `/v1/public/lots/${main.lotCode}/dossier`;
      // Abierto: no hay expediente público
      const open = await checked('get', 'nobody', dossierPath, 404);
      expect(open.body.error.code).toBe('PUB_CODE_NOT_FOUND');

      // El cierre es del paso 2.8: aquí se escribe la fila como la deja ese paso
      const units = await prisma.bottleUnit.findMany({
        where: { lotId: main.lotId, status: 'ACTIVE' },
        orderBy: { serial: 'asc' },
      });
      const leaves = units.map((u) => bottleLeaf(u.serial, u.code, u.salt));
      const root = merkleRoot(leaves, { odd: 'DUPLICATE', concat: 'BYTES' });
      const canonical = JSON.stringify({
        closedAt: new Date().toISOString(),
        lot: { lotCode: main.lotCode },
        schema: 'doc-dossier/1',
      });
      const hash = createHash('sha256').update(canonical).digest('hex');
      await prisma.lotDossier.create({
        data: {
          lotId: main.lotId,
          status: 'CLOSED',
          hash,
          canonical,
          bottleCount: units.length,
          bottleMerkleRoot: root,
          closedAt: new Date(),
        },
      });
      await prisma.lot.update({
        where: { id: main.lotId },
        data: { stage: 'CERTIFIED', stageChangedAt: new Date() },
      });

      const lot = await checked(
        'get',
        'nobody',
        `/v1/public/passports/${main.lotCode}`,
        200,
      );
      expect(lot.body.data).toMatchObject({
        stage: 'CERTIFIED',
        dossier: {
          status: 'CLOSED',
          hash,
          canonicalUrl: `https://api.e2e.test${dossierPath}`,
          anchor: null,
        },
      });
      expect(lot.headers['cache-control']).toBe(
        'public, max-age=3600, stale-while-revalidate=600',
      );

      // Los bytes exactos que se hashearon, sin envoltorio
      const raw = await http()
        .get(dossierPath)
        .set('X-Forwarded-For', nextIp())
        .buffer(true)
        .parse((res, done) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => done(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(raw.headers['content-type']).toBe(
        'application/json; charset=utf-8',
      );
      expect(raw.headers.etag).toBe(`"${hash}"`);
      const bytes = raw.body as Buffer;
      expect(bytes.toString('utf8')).toBe(canonical);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(hash);

      // Prueba Merkle: reproduce la raíz del expediente desde el código de la etiqueta
      const bottle = await checked(
        'get',
        'nobody',
        `/v1/public/passports/${bottleCode}`,
        200,
      );
      const proof = bottle.body.data.bottle.merkleProof as {
        salt: string;
        path: { side: 'L' | 'R'; hash: string }[];
      };
      expect(proof).not.toBeNull();
      expect(
        verifyMerkleProof(
          bottleLeaf(1234, bottleCode, proof.salt),
          proof.path,
          root as string,
          'BYTES',
        ),
      ).toBe(true);
      // El de una botella sigue en 60 s: su código aún se puede anular (S-14)
      expect(bottle.headers['cache-control']).toBe(
        'public, max-age=60, stale-while-revalidate=600',
      );
      // La botella anulada antes del cierre no entró al expediente: sin prueba
      const voided = await prisma.bottleUnit.findFirstOrThrow({
        where: { lotId: main.lotId, serial: 77 },
      });
      const voidedPassport = await checked(
        'get',
        'nobody',
        `/v1/public/passports/${voided.code}`,
        200,
      );
      expect(voidedPassport.body.data.bottle).toMatchObject({
        status: 'VOIDED',
        merkleProof: null,
      });

      // Con el expediente cerrado el lote ya no admite archivos
      const key = await upload('cinti', PNG, 'tarde.png', 'image/png');
      const late = await checked(
        'post',
        'cinti',
        `/v1/lots/${main.lotId}/attachments`,
        409,
        { key, kind: 'PHOTO', title: 'Tarde' },
      );
      expect(late.body.error.code).toBe('TRC_DOSSIER_CLOSED');
    });

    it('lote descartado: el pasaporte sigue respondiendo con su aviso y sus códigos anulados (S-23)', async () => {
      const lot = await singaniLot('Singani descartado bloque C', 186);
      const { lotCode } = await bottle(lot.productionId, 2900);
      const unit = await prisma.bottleUnit.findFirstOrThrow({
        where: { lotId: lot.lotId, serial: 10 },
      });
      await checked('post', 'cinti', `/v1/lots/${lot.lotId}/discard`, 200, {
        reason: 'Contaminación detectada en el depósito (e2e)',
      });

      const res = await checked(
        'get',
        'nobody',
        `/v1/public/passports/${lotCode}`,
        200,
      );
      expect(res.body.data).toMatchObject({
        kind: 'LOT',
        lotCode,
        stage: 'DISCARDED',
        bottling: { status: 'RECORDED', bottles: 2900 },
        lab: { status: 'NOT_RECORDED', laboratoryName: null, checks: [] },
        dossier: { status: 'OPEN', hash: null },
      });
      const discarded = (
        res.body.data.timeline as { type: string; summary: string }[]
      ).find((e) => e.type === 'LOT_DISCARDED');
      expect(discarded).toMatchObject({
        summary: 'Lote retirado por la bodega',
      });
      // El motivo es interno: no sale en el pasaporte
      expect(JSON.stringify(res.body.data)).not.toContain('Contaminación');

      const bottlePassport = await checked(
        'get',
        'nobody',
        `/v1/public/passports/${unit.code}`,
        200,
      );
      expect(bottlePassport.body.data).toMatchObject({
        kind: 'BOTTLE',
        bottle: { serial: 10, status: 'VOIDED', merkleProof: null },
        lot: { stage: 'DISCARDED' },
      });
    });

    it('vino migrado de la semilla: crianza registrada, sin destilación ni D.O., reglas fijadas al migrar', async () => {
      const res = await checked(
        'get',
        'nobody',
        '/v1/public/passports/ALT-2026-WINE-001',
        200,
      );
      const passport = res.body.data;
      expect(passport).toMatchObject({
        kind: 'LOT',
        lotCode: 'ALT-2026-WINE-001',
        productType: 'WINE',
        stage: 'BOTTLED',
        denomination: {
          applies: false,
          status: 'NOT_APPLICABLE',
          rules: null,
          legalException: false,
        },
        aging: {
          status: 'RECORDED',
          containerType: expect.any(String),
          plannedMonths: expect.any(Number),
          startDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
          unlockDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        },
        distillation: {
          status: 'NOT_APPLICABLE',
          startDate: null,
          endDate: null,
          heartAbvPercent: null,
          restMinDays: null,
          restUntil: null,
        },
        bottling: { status: 'RECORDED', bottles: 5320, date: '2026-05-12' },
        rules: { origin: 'MIGRATION' },
      });
      expect(
        passport.origin.terroirs.every(
          (t: { doStatus: string }) => t.doStatus === 'NOT_APPLICABLE',
        ),
      ).toBe(true);
      const ruleKeys = passport.rules.items.map((i: { key: string }) => i.key);
      expect(ruleKeys).toContain('trazabilidad.vino.crianzaMinimaMeses');
      expect(ruleKeys).not.toContain('trazabilidad.singani.reposoMinimoDias');
      // Quien no quedó registrado (datos anteriores a la Ola 2) va sin rol: no se inventa
      const roles = (
        passport.timeline as { type: string; actorRole: string | null }[]
      ).map((e) => e.actorRole);
      expect(roles.length).toBeGreaterThan(0);
      expect(roles).toContain(null);
      for (const role of roles) {
        expect([
          null,
          'OWNER',
          'ENOLOGIST',
          'AGRONOMIST',
          'OPERATOR',
          'ACCOUNTANT',
        ]).toContain(role);
      }
    });

    it('perfil público de bodega: activo responde, desconocido 404', async () => {
      const lot = await call(
        'get',
        'nobody',
        `/v1/public/lots/${main.lotCode}`,
      );
      const slug = lot.body.data.winery.slug as string;
      const profile = await checked(
        'get',
        'nobody',
        `/v1/public/wineries/${slug}`,
        200,
      );
      expect(profile.body.data.slug).toBe(slug);
      await checked('get', 'nobody', '/v1/public/wineries/no-existe-c', 404);
    });
  });

  it('cobertura del contrato: las rutas del bloque C se validaron contra openapi.json', () => {
    for (const operation of [
      'GET /v1/lots/{id}/timeline 200',
      'GET /v1/lots/{id}/graph 200',
      'GET /v1/lots/{id}/graph 404',
      'GET /v1/lots/{id}/balance 200',
      'GET /v1/traceability/dashboard 200',
      'GET /v1/traceability/reports/production 200',
      'GET /v1/traceability/reports/production 422',
      'POST /v1/lots/{id}/attachments 201',
      'POST /v1/lots/{id}/attachments 422',
      'GET /v1/lots/{id}/attachments 200',
      'POST /v1/lots/{id}/attachments/{attachmentId}/visibility 200',
      'GET /v1/public/passports/{code} 200',
      'GET /v1/public/passports/{code} 404',
      'GET /v1/public/passports/{code} 422',
      'GET /v1/public/passports/{code} 429',
      'GET /v1/public/lots/{lotCode} 200',
      'GET /v1/public/bottles/{code} 200',
    ]) {
      expect([...openapi.covered]).toContain(operation);
    }
  });
});
