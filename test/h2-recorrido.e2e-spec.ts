import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  MembershipRoleEnum,
  PrismaClient,
  WineryCategoryEnum,
  WineryMemberRoleEnum,
} from '@prisma/client';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { BottleCodeExportBuilder } from '../src/modules/lots/bottle-code-export.builder';
import {
  formatBottleCode,
  generateBottleCode,
} from '../src/modules/lots/domain/bottle-code';
import { BOTTLE_CSV_HEADER } from '../src/modules/lots/domain/bottle-csv';
import {
  bottleLeafHash,
  MerkleStep,
  verifyMerkleProof,
} from '../src/modules/lots/domain/merkle';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { STORAGE_SERVICE } from '../src/shared/storage/storage.interface';
import { createObjectStorage } from '../src/shared/storage/storage.module';
import { loadOpenApiValidator } from './helpers/openapi-validator';
import {
  addWineryMember,
  platformStaff,
  staffToken,
  wineryWithOwner,
} from './helpers/staff-session';
import { readZipEntries } from './helpers/zip';

/**
 * Recorrido H2 por la API (contrato O2 §18): el caso "Singani Gran Reserva
 * 2026" de la parcela al pasaporte de la botella, con las rutas de los tres
 * bloques de la Etapa 2 juntas y fechas relativas a hoy para que el reposo ya
 * esté cumplido. De paso comprueba los cabos entre bloques: registros
 * anulados que dejan de contar en las vistas, el expediente y el pasaporte;
 * correcciones visibles en el grafo y el pasaporte; `TRC_DOSSIER_CLOSED` tras
 * el cierre; y la prueba Merkle del pasaporte contra la raíz del expediente.
 *
 * Pruebas negativas de §18 que viven en las suites de los bloques: destilar
 * con `isDoEligible: true` uva no apta (`traceability-o2`), crianza bajo el
 * mínimo (`bloque-a`), dos embotellados simultáneos de bodegas distintas
 * (`bloque-b`) y enumeración de códigos con 429 (`bloque-c`).
 *
 * Corre en un esquema propio, con bodegas propias (sin la semilla).
 */
process.env.TRUST_PROXY = '1';
jest.setTimeout(240_000);

const run = `${Date.now()}${randomBytes(3).toString('hex')}`;
const schema = `h2_e2e_${run}`;
const originalUrl = process.env.DATABASE_URL;
const PASSPORT = 'https://pasaporte.h2.test';
const API = 'https://api.h2.test';

function urlWithSchema(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('schema', name);
  return parsed.toString();
}
const databaseUrl = urlWithSchema(process.env.DATABASE_URL ?? '', schema);

/** Hoy en America/La_Paz: el día con el que el servidor evalúa los candados. */
function laPazToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/La_Paz',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
function plusDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
/** Día de calendario de hace `n` días en La Paz. */
const daysAgo = (n: number): string => plusDays(laPazToday(), -n);

const sha256 = (data: Buffer | string) =>
  createHash('sha256').update(data).digest('hex');
const stripBom = (text: string) =>
  text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
const PDF = Buffer.from('%PDF-1.4 informe de laboratorio del recorrido H2');

type Res = request.Response;
type Method = 'get' | 'post' | 'patch' | 'put';
interface Detail {
  field?: string | null;
  code?: string;
  rule?: string;
  expected?: unknown;
  actual?: unknown;
  meta?: Record<string, unknown>;
}
const details = (res: Res): Detail[] =>
  (res.body.error?.details ?? []) as Detail[];
const codes = (res: Res): string[] => details(res).map((d) => d.code ?? '');

interface Proof {
  salt: string;
  path: MerkleStep[];
}

describe('Recorrido H2: Singani Gran Reserva de la parcela al pasaporte (e2e)', () => {
  const openapi = loadOpenApiValidator();
  const storageDir = mkdtempSync(join(tmpdir(), 'doc-h2-'));
  let prisma: PrismaClient;
  let app: INestApplication;
  let ipSeq = 1;
  const nextIp = () =>
    `10.231.${Math.floor(Math.random() * 200)}.${(ipSeq++ % 250) + 1}`;
  const tokens = {
    owner: '',
    enologist: '',
    agronomist: '',
    operator: '',
    other: '',
    platform: '',
    nobody: '',
  };
  type Who = keyof typeof tokens;
  const http = () => request(app.getHttpServer());

  let WINERY = '';
  let OTHER = '';
  const year = Number(daysAgo(205).slice(0, 4));
  /** Fin de la destilación hace 185 días: el reposo de 180 venció hace 5. */
  const REST_END = daysAgo(185);
  const UNLOCK = plusDays(REST_END, 180);
  const BOTTLING = {
    bottlingDate: daysAgo(2),
    packagingFormatCl: 75,
    totalBottlesPackaged: 2950,
    finalAlcoholAbv: 40,
    waterDilutionLiters: 750,
  };

  // Lo que el recorrido va dejando
  const terroir = { apt: '', portillo: '' };
  let lotId = '';
  let harvestId = '';
  let tankId = '';
  let wrongLogId = '';
  let wrongTreatmentId = '';
  let productionId = '';
  let bottlingId = '';
  let lotCode = '';
  let incompleteLabId = '';
  let wrongLabId = '';
  let conformingLabId = '';
  let hash = '';
  let merkleRoot = '';
  /** Códigos del recorrido: uno cualquiera, el sustituido, su sustituto y las bajas. */
  const bottle = {
    plain: { code: '', serial: 1234 },
    replaced: { code: '', serial: 7 },
    replacement: { code: '', serial: 7 },
    voidedBefore: { code: '', serial: 8 },
    voidedAfter: { code: '', serial: 9 },
  };

  function call(
    method: Method,
    who: Who,
    path: string,
    body?: object,
  ): Promise<Res> {
    const req = http()[method](path).set('X-Forwarded-For', nextIp());
    if (tokens[who]) req.set('Authorization', `Bearer ${tokens[who]}`);
    return body ? req.send(body) : req;
  }
  /** Llamada cuya respuesta se valida contra `openapi.json`. */
  async function checked(
    method: Method,
    who: Who,
    path: string,
    status: number,
    body?: object,
  ): Promise<Res> {
    const res = await call(method, who, path, body);
    expect({
      path,
      status: res.status,
      error: res.body?.error?.code,
      details: res.status === status ? undefined : res.body?.error?.details,
    }).toMatchObject({ path, status });
    openapi.expectResponse(method, path, res);
    return res;
  }
  /** Descarga binaria (CSV, ZIP, JSON canónico) sin interpretar el cuerpo. */
  async function download(who: Who, path: string) {
    const req = http().get(path).set('X-Forwarded-For', nextIp());
    if (tokens[who]) req.set('Authorization', `Bearer ${tokens[who]}`);
    const res = await req.buffer(true).parse((stream, done) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => done(null, Buffer.concat(chunks)));
    });
    return {
      status: res.status,
      headers: res.headers as Record<string, string>,
      body: res.body as Buffer,
    };
  }
  function correct(
    who: Who,
    status: number,
    body: {
      target: { type: string; id: string };
      kind: 'AMEND' | 'VOID';
      changes?: Record<string, unknown>;
      reason: string;
    },
  ): Promise<Res> {
    return checked('post', who, `/v1/lots/${lotId}/corrections`, status, body);
  }
  function labBody(extra: Record<string, unknown> = {}) {
    return {
      certifiedLaboratoryName: 'Laboratorio H2 ISO 17025',
      accreditedLabCertificationCode: `LAB-H2-${run}`,
      testPerformedAt: daysAgo(1),
      actualAlcoholAbv: 40.05,
      totalAcidityTartaricGl: 4.8,
      volatileAcidityAceticGl: 0.22,
      copperContentMgL: 0.02,
      laboratoryReportPdfUrl: 'https://laboratorio.h2.test/informe.pdf' as
        string | undefined,
      ...extra,
    };
  }
  const passport = (code: string, status = 200) =>
    checked('get', 'nobody', `/v1/public/passports/${code}`, status);
  const unit = (serial: number, status: 'ACTIVE' | 'VOIDED' = 'ACTIVE') =>
    prisma.bottleUnit.findFirstOrThrow({ where: { lotId, serial, status } });

  async function member(role: WineryMemberRoleEnum, fullName: string) {
    const email = `${role.toLowerCase()}-h2-${run}@e2e.test`;
    const { userId } = await addWineryMember(app, {
      wineryId: WINERY,
      role,
      email,
      fullName,
    });
    return staffToken(app, {
      userId,
      email,
      organizationId: WINERY,
      organizationType: 'WINERY',
      role: role as unknown as MembershipRoleEnum,
    });
  }
  async function winery(name: string, key: string) {
    const email = `duena-${key}-h2-${run}@e2e.test`;
    const created = await wineryWithOwner(app, {
      name,
      email,
      password: 'Recorrido-h2-123!',
      fullName: `Dueña de ${name}`,
      category: WineryCategoryEnum.DISTILLERY,
      region: 'Valle de Cinti',
    });
    const token = await staffToken(app, {
      userId: created.ownerId,
      email,
      organizationId: created.wineryId,
      organizationType: 'WINERY',
      role: MembershipRoleEnum.OWNER,
    });
    return { wineryId: created.wineryId, token };
  }

  beforeAll(async () => {
    execFileSync(
      process.execPath,
      [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
      {
        // Esquema propio: sin el candado global de `migrate deploy`
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK: '1',
        },
        stdio: 'pipe',
      },
    );
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    process.env.DATABASE_URL = databaseUrl;
    process.env.PASSPORT_BASE_URL = PASSPORT;
    process.env.API_PUBLIC_URL = API;
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

    const main = await winery(`Destilería Cinti Viejo H2 ${run}`, 'cinti');
    WINERY = main.wineryId;
    tokens.owner = main.token;
    await prisma.winery.update({
      where: { id: WINERY },
      data: { slug: `destileria-cinti-viejo-h2-${run}` },
    });
    tokens.enologist = await member(
      WineryMemberRoleEnum.ENOLOGIST,
      'Enóloga del recorrido',
    );
    tokens.agronomist = await member(
      WineryMemberRoleEnum.AGRONOMIST,
      'Agrónomo del recorrido',
    );
    tokens.operator = await member(
      WineryMemberRoleEnum.OPERATOR,
      'Operario del recorrido',
    );
    const other = await winery(`Bodega Vecina H2 ${run}`, 'vecina');
    OTHER = other.wineryId;
    tokens.other = other.token;
    tokens.platform = (
      await platformStaff(app, app.get(PrismaService), {
        email: `admin-h2-${run}@drinksonchain.test`,
        fullName: 'Administración del recorrido',
        role: MembershipRoleEnum.ADMIN,
      })
    ).token;
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

  // ── 1 · Lote ───────────────────────────────────────────────────────────────
  it('1 · la enóloga crea el lote: instantánea con 1.600 m, Moscatel de Alejandría, 180 días y merma del 5 %', async () => {
    const parcel = (
      parcelName: string,
      altitudeMasl: number,
      varietyName: string,
    ) =>
      checked('post', 'owner', '/v1/terroirs', 201, {
        parcelName,
        surfaceHectares: 2.5,
        altitudeMasl,
        rawMaterialType: 'Uva',
        varietyName,
        // El valor declarado se ignora: la aptitud se calcula (EA-03)
        isDoEligible: true,
      });
    const apt = await parcel(
      'Parcela Cinti 02',
      2350,
      'Moscatel de Alejandría',
    );
    const portillo = await parcel(
      'El Portillo',
      1540,
      'Moscatel de Alejandría',
    );
    terroir.apt = apt.body.data.id;
    terroir.portillo = portillo.body.data.id;
    expect(apt.body.data.isDoEligible).toBe(true);
    expect(portillo.body.data.isDoEligible).toBe(false);

    // La plataforma solo lee la trazabilidad (S-25)
    const platform = await call(
      'post',
      'platform',
      `/v1/lots?wineryId=${WINERY}`,
      { name: 'Lote de la plataforma', harvestYear: year },
    );
    expect({
      status: platform.status,
      code: platform.body.error?.code,
    }).toEqual({ status: 403, code: 'TRC_PLATFORM_READ_ONLY' });

    const lot = await checked('post', 'enologist', '/v1/lots', 201, {
      name: 'Singani Gran Reserva 2026',
      harvestYear: year,
      productType: 'SINGANI',
      estimatedBottles: 3000,
      plannedFormatCl: 75,
      targetAbvPercent: 40,
    });
    lotId = lot.body.data.id;
    expect(lot.body.data).toMatchObject({
      stage: 'ORIGIN',
      productType: 'SINGANI',
      lotCode: null,
      rules: {
        origin: 'LOT_CREATION',
        singani: {
          minAltitudeMasl: 1600,
          requiredVarieties: ['Moscatel de Alejandría'],
          minRestDays: 180,
        },
        bottling: { maxLossPercent: 5 },
      },
    });
  });

  // ── 2 · Vendimia ───────────────────────────────────────────────────────────
  it('2 · pesaje del operario, análisis de la enóloga y dictamen del agrónomo (sin autoaprobación ni parcela no apta)', async () => {
    const weighing = {
      lotId,
      terroirId: terroir.apt,
      intakeDate: daysAgo(205),
      grossWeightKg: 18500,
      tareWeightKg: 100,
      temperatureAtIntakeC: 81,
    };
    const selfApproved = await checked(
      'post',
      'operator',
      '/v1/harvest-batches',
      422,
      { ...weighing, phytosanitaryStatus: 'APPROVED' },
    );
    expect(selfApproved.body.error.code).toBe('TRC_PHYTO_IN_CREATE');
    const portillo = await checked(
      'post',
      'operator',
      '/v1/harvest-batches',
      422,
      { ...weighing, terroirId: terroir.portillo },
    );
    expect(portillo.body.error.code).toBe('TRC_DO_TERROIR_NOT_ELIGIBLE');

    const harvest = await checked(
      'post',
      'operator',
      '/v1/harvest-batches',
      201,
      weighing,
    );
    harvestId = harvest.body.data.id;
    expect(harvest.body.data).toMatchObject({
      lotId,
      netWeightKg: 18400,
      phytosanitaryStatus: 'PENDING_INSPECTION',
    });

    await checked(
      'post',
      'enologist',
      `/v1/harvest-batches/${harvestId}/maturity-analyses`,
      201,
      {
        brixDegrees: 23.5,
        ph: 3.5,
        acidityGl: 5.8,
        measuredAt: `${daysAgo(205)}T15:00:00Z`,
      },
    );

    // Uva pendiente de dictamen: no entra al tanque (EA-04)
    const pending = await checked(
      'post',
      'enologist',
      '/v1/fermentation-tanks',
      422,
      {
        inputs: [{ harvestBatchId: harvestId }],
        tankCode: `TK-H2-${run}`,
        capacityLiters: 15000,
        volumeFilledLiters: 12100,
        startDate: `${daysAgo(204)}T14:00:00Z`,
      },
    );
    expect(pending.body.error.code).toBe('TRC_PHYTO_NOT_APPROVED');

    const decision = await checked(
      'post',
      'agronomist',
      `/v1/harvest-batches/${harvestId}/phyto-decisions`,
      201,
      { decision: 'APPROVED', decidedAt: `${daysAgo(204)}T12:00:00Z` },
    );
    expect(decision.body.data.phytosanitaryStatus).toBe('APPROVED');
    const lot = await checked('get', 'operator', `/v1/lots/${lotId}`, 200);
    expect(lot.body.data.stage).toBe('HARVEST');
  });

  // ── 3 · Vinificación ───────────────────────────────────────────────────────
  it('3 · tanque de 12.100 L, fermentación con lecturas y tratamientos, y completado con destino singani', async () => {
    const tank = await checked(
      'post',
      'enologist',
      '/v1/fermentation-tanks',
      201,
      {
        inputs: [{ harvestBatchId: harvestId }],
        tankCode: `TK-H2-${run}`,
        capacityLiters: 15000,
        volumeFilledLiters: 12100,
        startDate: `${daysAgo(204)}T14:00:00Z`,
      },
    );
    tankId = tank.body.data.id;
    const path = `/v1/fermentation-tanks/${tankId}`;
    const started = await checked('post', 'enologist', `${path}/start`, 200, {
      startedAt: `${daysAgo(203)}T08:00:00Z`,
    });
    expect(started.body.data.status).toBe('FERMENTING');

    const reading = (day: number, temperatureCelsius: number) =>
      checked('post', 'operator', `${path}/logs`, 201, {
        temperatureCelsius,
        specificGravity: 1.05,
        recordedAt: `${daysAgo(day)}T09:00:00Z`,
      });
    await reading(202, 23.8);
    await reading(201, 24.1);
    // Un error de tecleo (245 °C) que se anulará con una corrección
    wrongLogId = (await reading(200, 245)).body.data.id;
    const treatment = (additiveName: string, hour: string) =>
      checked('post', 'enologist', `${path}/treatments`, 201, {
        treatmentType: 'SO2_ADDITION',
        additiveName,
        dosageAppliedGPerHl: 5,
        regulatoryAuthCode: 'SENASAG-ADT-H2-001',
        appliedAt: `${daysAgo(202)}T${hour}:00:00Z`,
      });
    await treatment('Metabisulfito de potasio', '10');
    wrongTreatmentId = (await treatment('Registrado por error', '11')).body.data
      .id;

    const completed = await checked(
      'post',
      'enologist',
      `${path}/complete`,
      200,
      {
        endDate: daysAgo(195),
        finalVolumeLiters: 12100,
        destination: 'SINGANI_DIST',
      },
    );
    expect(completed.body.data).toMatchObject({
      status: 'COMPLETED',
      destinationType: 'SINGANI_DIST',
      availableLiters: 12100,
    });
  });

  // ── Correcciones: registros anulados y marcas en las vistas ────────────────
  it('correcciones antes de destilar: la lectura y el tratamiento anulados dejan de contar; el grafo marca los nodos corregidos', async () => {
    // El operario corrige lo que él registra (S-17)
    const temperature = await correct('operator', 201, {
      target: { type: 'HARVEST_BATCH', id: harvestId },
      kind: 'AMEND',
      changes: { temperatureAtIntakeC: 18 },
      reason: 'La temperatura del pesaje se tecleó sin la coma (81 por 18)',
    });
    expect(temperature.body.data.changes).toEqual([
      { field: 'temperatureAtIntakeC', before: 81, after: 18 },
    ]);
    await correct('operator', 201, {
      target: { type: 'FERMENTATION_LOG', id: wrongLogId },
      kind: 'VOID',
      reason: 'Lectura de 245 °C: error de tecleo, se anula',
    });
    await correct('enologist', 201, {
      target: { type: 'TREATMENT', id: wrongTreatmentId },
      kind: 'VOID',
      reason: 'Tratamiento registrado dos veces por error',
    });

    const graph = await checked(
      'get',
      'enologist',
      `/v1/lots/${lotId}/graph`,
      200,
    );
    const nodes = graph.body.data.nodes as {
      id: string;
      type: string;
      corrected: boolean;
      metrics: { key: string; value: number | string | null }[];
    }[];
    const metric = (id: string, key: string) =>
      nodes.find((n) => n.id === id)?.metrics.find((m) => m.key === key)?.value;
    // Vigentes: dos lecturas (la de 245 °C no cuenta) y un tratamiento
    expect(metric(tankId, 'readings')).toBe(2);
    expect(metric(tankId, 'lastTemperatureC')).toBe(24.1);
    expect(metric(tankId, 'treatments')).toBe(1);
    expect(metric(harvestId, 'temperatureAtIntakeC')).toBe(18);
    // `corrected` sale de `trace_corrections`: el pesaje por la suya y el
    // tanque por las de su lectura y su tratamiento; la parcela, sin tocar
    expect(Object.fromEntries(nodes.map((n) => [n.type, n.corrected]))).toEqual(
      { TERROIR: false, HARVEST_BATCH: true, TANK: true },
    );

    const timeline = await checked(
      'get',
      'operator',
      `/v1/lots/${lotId}/timeline`,
      200,
    );
    const events = timeline.body.data.events as {
      type: string;
      corrected: boolean;
      resource: { id: string };
    }[];
    expect(events.filter((e) => e.type === 'CORRECTION')).toHaveLength(3);
    expect(events.find((e) => e.type === 'HARVEST_WEIGHED')?.corrected).toBe(
      true,
    );
    expect(
      events.find(
        (e) =>
          e.type === 'TREATMENT_APPLIED' && e.resource.id === wrongTreatmentId,
      )?.corrected,
    ).toBe(true);

    // El tanque devuelve los anulados marcados, no los borra
    const tank = await checked(
      'get',
      'enologist',
      `/v1/fermentation-tanks/${tankId}`,
      200,
    );
    const logs = tank.body.data.logs as { id: string; voided: boolean }[];
    expect(logs).toHaveLength(3);
    expect(logs.filter((l) => l.voided).map((l) => l.id)).toEqual([wrongLogId]);
  });

  // ── 4 · Destilación y reposo ───────────────────────────────────────────────
  it('4 · destilación de 12.100 L cerrada con cabezas 120, corazón 1.500 al 60 % y colas 210: reposo cumplido', async () => {
    const open = await checked(
      'post',
      'enologist',
      '/v1/production-batches/distillation',
      201,
      {
        fermentationTankId: tankId,
        equipmentIdentifier: 'Alambique AL-H2',
        processStartDate: daysAgo(194),
        inputVolumeLiters: 12100,
      },
    );
    productionId = open.body.data.id;
    const path = `/v1/production-batches/${productionId}`;
    const close = {
      processEndDate: REST_END,
      cuts: { headsLiters: 120, heartLiters: 1500, tailsLiters: 210 },
      heartAbvPercent: 60,
    };
    // Cortes mayores que la entrada
    const cuts = await checked('post', 'enologist', `${path}/close`, 422, {
      ...close,
      cuts: { headsLiters: 120, heartLiters: 12000, tailsLiters: 210 },
    });
    expect(details(cuts)[0]).toMatchObject({
      code: 'TRC_MASS_BALANCE_EXCEEDED',
      meta: { inputLiters: 12100, outputLiters: 12330 },
    });

    const closed = await checked(
      'post',
      'enologist',
      `${path}/close`,
      200,
      close,
    );
    expect(closed.body.data).toMatchObject({
      headsLiters: 120,
      heartLiters: 1500,
      tailsLiters: 210,
      heartAbvPercent: 60,
      // Registro tardío: el candado ya estaba cumplido al cerrar
      restStatus: 'READY',
      lock: { unlockDate: UNLOCK, released: true },
    });
    const lot = await checked('get', 'enologist', `/v1/lots/${lotId}`, 200);
    expect(lot.body.data.stage).toBe('RESTING');

    const balance = await checked(
      'get',
      'enologist',
      `/v1/lots/${lotId}/balance`,
      200,
    );
    expect(balance.body.data).toMatchObject({
      harvest: { netKg: 18400, approvedKg: 18400 },
      must: { filledLiters: 12100 },
      distillation: {
        inputLiters: 12100,
        headsLiters: 120,
        heartLiters: 1500,
        tailsLiters: 210,
        heartAbvPercent: 60,
        pureAlcoholLiters: 900,
      },
      bottling: null,
    });
  });

  // ── 5 · Embotellado ────────────────────────────────────────────────────────
  it('un cambio de regla en el back office a mitad de proceso no afecta al lote', async () => {
    const override = await checked(
      'put',
      'platform',
      '/v1/platform/settings/trazabilidad.singani.reposoMinimoDias/overrides',
      200,
      {
        wineryIds: [WINERY],
        value: 365,
        reason: 'Recorrido H2: la instantánea del lote manda',
      },
    );
    expect(override.status).toBe(200);
    const later = await checked('post', 'enologist', '/v1/lots', 201, {
      name: 'Singani con la regla nueva (H2)',
      harvestYear: year,
      productType: 'SINGANI',
    });
    expect(later.body.data.rules.singani.minRestDays).toBe(365);

    // El lote del recorrido conserva sus 180 días: el reposo sigue cumplido
    const production = await checked(
      'get',
      'enologist',
      `/v1/production-batches/${productionId}`,
      200,
    );
    expect(production.body.data.lock).toMatchObject({
      unlockDate: UNLOCK,
      released: true,
      rule: { minimum: 180, applied: 180 },
    });
  });

  it('5 · vista previa y embotellado de 2.950 botellas de 75 cL al 40 % con 750 L de agua; las elusiones fallan', async () => {
    const path = `/v1/lots/${lotId}/bottling`;
    const preview = await checked(
      'post',
      'enologist',
      `${path}/preview`,
      200,
      BOTTLING,
    );
    expect(preview.body.data).toMatchObject({
      valid: true,
      violations: [],
      balance: {
        availableLiters: 1500,
        waterDilutionLiters: 750,
        bottledLiters: 2212.5,
        leftoverLiters: 0,
        lossLiters: 37.5,
        lossPercent: 1.67,
        maxLossPercent: 5,
        pureAlcohol: { availableLiters: 900, bottledLiters: 885 },
        maxBottles: 3000,
      },
    });
    const nothing = await checked('get', 'enologist', `/v1/lots/${lotId}`, 200);
    expect(nothing.body.data).toMatchObject({
      stage: 'RESTING',
      lotCode: null,
    });

    // Antes del fin del reposo (fecha de embotellado anterior al desbloqueo)
    const early = await checked('post', 'enologist', path, 422, {
      ...BOTTLING,
      bottlingDate: plusDays(UNLOCK, -5),
    });
    expect(details(early)[0]).toMatchObject({
      code: 'TRC_LOCK_NOT_RELEASED',
      rule: 'trazabilidad.singani.reposoMinimoDias',
      meta: { sourceId: productionId, kind: 'REST', unlockDate: UNLOCK },
    });
    // Declarando vino por la ruta legada: el tipo se deriva del origen (EA-01)
    const asWine = await checked('post', 'enologist', '/v1/bottling', 422, {
      ...BOTTLING,
      productionBatchId: productionId,
      productType: 'WINE',
    });
    expect(codes(asWine)).toContain('TRC_PRODUCT_TYPE_MISMATCH');
    // Más botellas que litros
    const tooMany = await checked('post', 'enologist', path, 422, {
      ...BOTTLING,
      totalBottlesPackaged: 3100,
    });
    expect(tooMany.body.error.code).toBe('TRC_BOTTLING_EXCEEDS_VOLUME');
    expect(details(tooMany)[0].meta).toMatchObject({ maxBottles: 3000 });
    // Más agua para inflar botellas: el alcohol puro no da
    const watered = await checked('post', 'enologist', path, 422, {
      ...BOTTLING,
      waterDilutionLiters: 1000,
      totalBottlesPackaged: 3300,
    });
    expect(codes(watered)).toContain('TRC_ALCOHOL_BALANCE_EXCEEDED');
    // El operario no embotella
    await checked('post', 'operator', path, 403, BOTTLING);

    const bottled = await checked('post', 'enologist', path, 201, BOTTLING);
    bottlingId = bottled.body.data.id;
    lotCode = bottled.body.data.lotCode;
    expect(lotCode).toMatch(
      new RegExp(`^[A-Z0-9]+-${laPazToday().slice(0, 4)}-SINGANI-\\d{3}$`),
    );
    expect(bottled.body.data).toMatchObject({
      lotId,
      productType: 'SINGANI',
      totalBottlesPackaged: 2950,
      qrBatchUrl: `${PASSPORT}/b/${lotCode}`,
      balance: {
        bottledLiters: 2212.5,
        lossPercent: 1.67,
        pureAlcohol: { availableLiters: 900, bottledLiters: 885 },
      },
      bottleCodes: {
        total: 2950,
        active: 2950,
        voided: 0,
        firstSerial: 1,
        lastSerial: 2950,
      },
    });
    // Un embotellado por lote (EA-02)
    const again = await checked('post', 'enologist', path, 409, BOTTLING);
    expect(again.body.error.code).toBe('TRC_LOT_ALREADY_BOTTLED');

    const lot = await checked('get', 'enologist', `/v1/lots/${lotId}`, 200);
    expect(lot.body.data).toMatchObject({ stage: 'BOTTLED', lotCode });
    bottle.plain.code = (await unit(bottle.plain.serial)).code;
  });

  // ── 6 · Códigos, laboratorio y expediente ──────────────────────────────────
  it('6a · exportación CSV y ZIP de los 2.950 códigos', async () => {
    const csv = await download(
      'enologist',
      `/v1/lots/${lotId}/bottle-codes/export?format=csv`,
    );
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(csv.headers['content-disposition']).toBe(
      `attachment; filename="codigos-${lotCode}-1-2950.csv"`,
    );
    expect(csv.headers['x-export-rows']).toBe('2950');
    const lines = csv.body.toString('utf8').split('\r\n');
    expect(lines.pop()).toBe('');
    expect(stripBom(lines[0])).toBe(BOTTLE_CSV_HEADER);
    expect(lines).toHaveLength(2951);
    expect(lines[bottle.plain.serial]).toBe(
      [
        bottle.plain.serial,
        bottle.plain.code,
        formatBottleCode(bottle.plain.code),
        `${PASSPORT}/b/${bottle.plain.code}`,
        lotCode,
        'Singani Gran Reserva 2026',
        'SINGANI',
        BOTTLING.bottlingDate,
      ].join(','),
    );
    expect(new Set(lines.slice(1).map((l) => l.split(',')[1])).size).toBe(2950);

    const accepted = await checked(
      'post',
      'enologist',
      `/v1/lots/${lotId}/bottle-codes/exports`,
      202,
      { format: 'ZIP', qr: { imageFormat: 'SVG' } },
    );
    expect(accepted.body.data.status).toBe('PENDING');
    const exportId = accepted.body.data.exportId as string;
    // Lo que hace el worker con `trace.bottle-codes.export` (del outbox)
    const event = await prisma.outboxEvent.findFirstOrThrow({
      where: { aggregateId: exportId },
    });
    expect(event).toMatchObject({
      eventType: 'trace.bottle-codes.export',
      queue: 'default',
    });
    const built = await app.get(BottleCodeExportBuilder).build(exportId);
    expect(built).toMatchObject({ status: 'READY', rows: 2950 });
    const ready = await checked(
      'get',
      'enologist',
      `/v1/lots/${lotId}/bottle-codes/exports/${exportId}`,
      200,
    );
    expect(ready.body.data).toMatchObject({ status: 'READY', rows: 2950 });
    const url = new URL(ready.body.data.downloadUrl as string);
    const zip = await download('nobody', `${url.pathname}${url.search}`);
    expect(zip.status).toBe(200);
    const entries = readZipEntries(zip.body);
    expect(entries.size).toBe(2951);
    expect(
      entries.has(`qr/${bottle.plain.serial}-${bottle.plain.code}.svg`),
    ).toBe(true);
  });

  it('6b · bajas de códigos antes del cierre: una sustituida (misma serie) y una sin sustituto', async () => {
    bottle.replaced.code = (await unit(bottle.replaced.serial)).code;
    bottle.voidedBefore.code = (await unit(bottle.voidedBefore.serial)).code;
    bottle.voidedAfter.code = (await unit(bottle.voidedAfter.serial)).code;
    const replaced = await checked(
      'post',
      'enologist',
      `/v1/bottle-codes/${bottle.replaced.code}/void`,
      200,
      { reason: 'Etiqueta dañada en la línea', replace: true },
    );
    expect(replaced.body.data).toMatchObject({
      status: 'VOIDED',
      serial: bottle.replaced.serial,
    });
    bottle.replacement.code = replaced.body.data.voided.replacedBy;
    expect(bottle.replacement.code).toMatch(/^[0-9A-Z]{8}$/);
    await checked(
      'post',
      'enologist',
      `/v1/bottle-codes/${bottle.voidedBefore.code}/void`,
      200,
      { reason: 'Botella rota en el almacén' },
    );
  });

  it('6c · laboratorio: incompleto no cierra el expediente; un análisis anulado deja de contar; conforme con metanol en mg/100 mL a.a.', async () => {
    const path = `/v1/lots/${lotId}/lab-analyses`;
    // Sin metanol: nunca conforme por omisión (EA-08)
    const incomplete = await checked('post', 'enologist', path, 201, labBody());
    incompleteLabId = incomplete.body.data.id;
    expect(incomplete.body.data.conformityStatus).toBe('INCOMPLETE');
    const notReady = await checked(
      'post',
      'enologist',
      `/v1/lots/${lotId}/dossier/close`,
      422,
      { confirm: true },
    );
    expect(notReady.body.error.code).toBe('TRC_DOSSIER_NOT_READY');
    expect(details(notReady).map((d) => d.meta)).toEqual([
      { requirement: 'LAB_CONFORMING', labStatus: 'INCOMPLETE' },
    ]);

    // Un análisis con el cobre mal transcrito (8 mg/L, límite 6): no conforme
    const wrong = await checked('post', 'enologist', path, 201, {
      ...labBody({ methanolMg100mlAa: 12, copperContentMgL: 8 }),
    });
    wrongLabId = wrong.body.data.id;
    expect(wrong.body.data).toMatchObject({
      conformityStatus: 'NON_CONFORMING',
      current: true,
    });
    await correct('enologist', 201, {
      target: { type: 'LAB_ANALYSIS', id: wrongLabId },
      kind: 'VOID',
      reason: 'El informe era de otro lote: se anula el análisis',
    });
    // La vigencia vuelve al anterior (incompleto): el lote sigue sin cerrar
    const afterVoid = await checked('get', 'operator', path, 200);
    expect(
      Object.fromEntries(
        (
          afterVoid.body.data.items as {
            id: string;
            current: boolean;
            voided: boolean;
          }[]
        ).map((a) => [a.id, [a.current, a.voided]]),
      ),
    ).toEqual({
      [incompleteLabId]: [true, false],
      [wrongLabId]: [false, true],
    });
    const preview = await checked(
      'get',
      'operator',
      `/v1/lots/${lotId}/dossier/preview`,
      200,
    );
    expect(preview.body.data.ready).toBe(false);
    expect((await passport(lotCode)).body.data.lab).toMatchObject({
      status: 'INCOMPLETE',
    });
    const dashboard = await checked(
      'get',
      'enologist',
      '/v1/traceability/dashboard',
      200,
    );
    const ids = (list: { id: string }[]) => list.map((l) => l.id);
    expect(ids(dashboard.body.data.readyToClose)).not.toContain(lotId);

    // Informe por su `key` y metanol en mg/100 mL de alcohol anhidro
    const upload = await http()
      .post('/v1/uploads?folder=lab')
      .set('Authorization', `Bearer ${tokens.enologist}`)
      .set('X-Forwarded-For', nextIp())
      .attach('file', PDF, 'informe-laboratorio.pdf')
      .expect(201);
    const conforming = await checked('post', 'enologist', path, 201, {
      ...labBody({
        methanolMg100mlAa: 12,
        laboratoryReportPdfUrl: undefined,
        laboratoryReportKey: upload.body.data.key,
      }),
    });
    conformingLabId = conforming.body.data.id;
    expect(conforming.body.data).toMatchObject({
      conformityStatus: 'CONFORMING',
      conformsToSenasagStandards: true,
      methanolMg100mlAa: 12,
      current: true,
      units: { methanolMg100mlAa: 'mg/100 mL de alcohol anhidro' },
    });
    expect(
      (
        conforming.body.data.conformity.checks as {
          parameter: string;
          result: string;
        }[]
      ).map((c) => [c.parameter, c.result]),
    ).toEqual(
      expect.arrayContaining([
        ['metanol', 'PASS'],
        ['cobre', 'PASS'],
        ['grado', 'PASS'],
      ]),
    );

    const ready = await checked(
      'get',
      'enologist',
      '/v1/traceability/dashboard',
      200,
    );
    expect(ids(ready.body.data.readyToClose)).toContain(lotId);
    const report = await checked(
      'get',
      'owner',
      '/v1/traceability/reports/production',
      200,
    );
    expect(
      (report.body.data.rows as { lotId: string }[]).find(
        (r) => r.lotId === lotId,
      ),
    ).toMatchObject({
      lotCode,
      netKg: 18400,
      mustLiters: 12100,
      heartLiters: 1500,
      bottledLiters: 2212.5,
      bottles: 2950,
      labStatus: 'CONFORMING',
    });
    // El análisis anulado sigue en el grafo, marcado
    const graph = await checked('get', 'owner', `/v1/lots/${lotId}/graph`, 200);
    const labs = (
      graph.body.data.nodes as {
        id: string;
        type: string;
        status: string;
        corrected: boolean;
      }[]
    ).filter((n) => n.type === 'LAB_ANALYSIS');
    expect(
      Object.fromEntries(labs.map((n) => [n.id, [n.status, n.corrected]])),
    ).toEqual({
      [incompleteLabId]: ['SUPERSEDED', false],
      [wrongLabId]: ['VOIDED', true],
      [conformingLabId]: ['CONFORMING', false],
    });
  });

  it('pasaporte antes del cierre: expediente abierto y botella sin prueba Merkle', async () => {
    const lot = await passport(lotCode);
    expect(lot.body.data).toMatchObject({
      kind: 'LOT',
      stage: 'BOTTLED',
      dossier: { status: 'OPEN', hash: null, canonicalUrl: null },
    });
    const one = await passport(bottle.plain.code);
    expect(one.body.data.bottle).toMatchObject({
      serial: 1234,
      lotTotal: 2950,
      status: 'ACTIVE',
      merkleProof: null,
    });
  });

  it('6d · cierre del expediente: huella recalculable desde los bytes canónicos, con los anulados marcados', async () => {
    const preview = await checked(
      'get',
      'enologist',
      `/v1/lots/${lotId}/dossier/preview`,
      200,
    );
    expect(preview.body.data.ready).toBe(true);
    const operator = await checked(
      'post',
      'operator',
      `/v1/lots/${lotId}/dossier/close`,
      403,
      { confirm: true },
    );
    expect(operator.body.error.code).toBe('AUTH_INSUFFICIENT_PERMISSIONS');

    const closed = await checked(
      'post',
      'enologist',
      `/v1/lots/${lotId}/dossier/close`,
      200,
      { confirm: true },
    );
    hash = closed.body.data.hash;
    merkleRoot = closed.body.data.bottleCodes.merkleRoot;
    expect(closed.body.data).toMatchObject({
      status: 'CLOSED',
      schema: 'doc-dossier/1',
      algorithm: 'sha256/jcs-rfc8785',
      closedBy: { role: 'ENOLOGIST' },
      // 2.950 menos la baja sin sustituto; la serie 7 lleva su sustituto
      bottleCodes: {
        count: 2949,
        algorithm: 'sha256-merkle/serial-code-salt',
      },
      anchor: null,
    });
    const lot = await checked('get', 'operator', `/v1/lots/${lotId}`, 200);
    expect(lot.body.data.stage).toBe('CERTIFIED');

    // Los bytes públicos son los que se hashearon
    const file = await download('nobody', `/v1/public/lots/${lotCode}/dossier`);
    expect(file.status).toBe(200);
    expect(sha256(file.body)).toBe(hash);
    const doc = JSON.parse(file.body.toString('utf8')) as {
      lot: { lotCode: string };
      harvests: { netWeightKg: string; temperatureAtIntakeC: string }[];
      tanks: {
        readings: { id: string; voidedAt: string | null }[];
        treatments: { id: string; voidedAt: string | null }[];
      }[];
      labAnalyses: { id: string; current: boolean; voidedAt: string | null }[];
      corrections: { kind: string; target: { type: string } }[];
      bottleCodes: { count: number; merkleRoot: string };
    };
    expect(doc.lot.lotCode).toBe(lotCode);
    expect(doc.harvests[0]).toMatchObject({
      netWeightKg: '18400.000',
      temperatureAtIntakeC: '18.00',
    });
    expect(doc.bottleCodes).toEqual({
      count: 2949,
      merkleRoot,
      algorithm: 'sha256-merkle/serial-code-salt',
    });
    // Los registros anulados quedan en el expediente, marcados
    const voidedIds = (list: { id: string; voidedAt: string | null }[]) =>
      list.filter((r) => r.voidedAt !== null).map((r) => r.id);
    expect(doc.tanks[0].readings).toHaveLength(3);
    expect(voidedIds(doc.tanks[0].readings)).toEqual([wrongLogId]);
    expect(doc.tanks[0].treatments).toHaveLength(2);
    expect(voidedIds(doc.tanks[0].treatments)).toEqual([wrongTreatmentId]);
    expect(voidedIds(doc.labAnalyses)).toEqual([wrongLabId]);
    expect(doc.labAnalyses.filter((l) => l.current).map((l) => l.id)).toEqual([
      conformingLabId,
    ]);
    expect(
      doc.corrections.map((c) => `${c.kind}:${c.target.type}`).sort(),
    ).toEqual([
      'AMEND:HARVEST_BATCH',
      'VOID:FERMENTATION_LOG',
      'VOID:LAB_ANALYSIS',
      'VOID:TREATMENT',
    ]);
    // Los códigos de botella no van en claro
    expect(file.body.toString('utf8')).not.toContain(bottle.plain.code);
  });

  it('tras el cierre: correcciones, laboratorio y archivos → TRC_DOSSIER_CLOSED; el resto del lote es terminal', async () => {
    const correction = await correct('enologist', 409, {
      target: { type: 'HARVEST_BATCH', id: harvestId },
      kind: 'AMEND',
      changes: { temperatureAtIntakeC: 19 },
      reason: 'Corrección tardía, con el expediente ya cerrado',
    });
    expect(correction.body.error.code).toBe('TRC_DOSSIER_CLOSED');
    expect(details(correction)[0].meta).toMatchObject({ hash });
    expect(details(correction)[0].meta?.closedAt).toEqual(expect.any(String));

    const lab = await checked(
      'post',
      'enologist',
      `/v1/lots/${lotId}/lab-analyses`,
      409,
      labBody({ methanolMg100mlAa: 12 }),
    );
    expect(lab.body.error.code).toBe('TRC_DOSSIER_CLOSED');
    const legacyLab = await checked(
      'post',
      'enologist',
      '/v1/lab-analyses',
      409,
      { ...labBody({ methanolMg100mlAa: 12 }), bottlingBatchId: bottlingId },
    );
    expect(legacyLab.body.error.code).toBe('TRC_DOSSIER_CLOSED');

    const upload = await http()
      .post('/v1/uploads?folder=lotes')
      .set('Authorization', `Bearer ${tokens.enologist}`)
      .set('X-Forwarded-For', nextIp())
      .attach('file', PDF, 'ficha.pdf')
      .expect(201);
    const attachment = await checked(
      'post',
      'enologist',
      `/v1/lots/${lotId}/attachments`,
      409,
      { key: upload.body.data.key, kind: 'OTHER', title: 'Ficha tardía' },
    );
    expect(attachment.body.error.code).toBe('TRC_DOSSIER_CLOSED');

    // Las demás escrituras de un lote certificado: etapa terminal
    const rename = await checked(
      'patch',
      'enologist',
      `/v1/lots/${lotId}`,
      409,
      {
        name: 'Otro nombre',
      },
    );
    expect(rename.body.error.code).toBe('TRC_LOT_TERMINAL');
    const weighing = await checked(
      'post',
      'operator',
      '/v1/harvest-batches',
      409,
      {
        lotId,
        terroirId: terroir.apt,
        intakeDate: daysAgo(3),
        grossWeightKg: 1100,
        tareWeightKg: 100,
      },
    );
    expect(weighing.body.error.code).toBe('TRC_LOT_TERMINAL');
    // El expediente no cambió
    const dossier = await checked(
      'get',
      'operator',
      `/v1/lots/${lotId}/dossier`,
      200,
    );
    expect(dossier.body.data).toMatchObject({ status: 'CLOSED', hash });
  });

  // ── 7 · Pasaporte ──────────────────────────────────────────────────────────
  it('7a · pasaporte del lote: datos registrados, correcciones contadas y registros anulados fuera', async () => {
    const res = await passport(lotCode);
    const data = res.body.data;
    expect(data).toMatchObject({
      kind: 'LOT',
      lotCode,
      name: 'Singani Gran Reserva 2026',
      productType: 'SINGANI',
      vintage: year,
      stage: 'CERTIFIED',
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
            parcelName: 'Parcela Cinti 02',
            altitudeMasl: 2350,
            variety: 'Moscatel de Alejandría',
          },
        ],
      },
      harvest: {
        status: 'RECORDED',
        phytosanitary: 'APPROVED',
        maturity: { brixDegrees: 23.5, ph: 3.5, acidityGl: 5.8 },
      },
      // Solo lo vigente: dos lecturas y un tratamiento
      fermentation: { status: 'RECORDED', readingsCount: 2 },
      aging: { status: 'NOT_APPLICABLE' },
      distillation: {
        status: 'RECORDED',
        heartAbvPercent: 60,
        restMinDays: 180,
        restUntil: UNLOCK,
      },
      bottling: {
        status: 'RECORDED',
        bottles: 2950,
        formatCl: 75,
        finalAbv: 40,
      },
      lab: { status: 'CONFORMING', laboratoryName: 'Laboratorio H2 ISO 17025' },
      dossier: {
        status: 'CLOSED',
        hash,
        canonicalUrl: `${API}/v1/public/lots/${lotCode}/dossier`,
        anchor: null,
      },
    });
    expect(
      (data.fermentation.treatments as { additive: string }[]).map(
        (t) => t.additive,
      ),
    ).toEqual(['Metabisulfito de potasio']);
    // De las correcciones, cuántas y cuándo (S-22); leídas de `trace_corrections`
    expect(data.corrections.count).toBe(4);
    expect(data.corrections.lastAt).toEqual(expect.any(String));
    expect(await prisma.traceCorrection.count({ where: { lotId } })).toBe(4);
    const timeline = data.timeline as {
      type: string;
      corrected: boolean;
      actorRole: string | null;
    }[];
    expect(timeline.find((e) => e.type === 'HARVEST_WEIGHED')).toMatchObject({
      corrected: true,
      actorRole: 'OPERATOR',
    });
    // El análisis anulado no sale; los otros dos, sí
    expect(timeline.filter((e) => e.type === 'LAB_REGISTERED')).toHaveLength(2);
    expect(timeline.map((e) => e.type)).toEqual(
      expect.arrayContaining([
        'PHYTO_DECIDED',
        'TANK_FILLED',
        'FERMENTATION_COMPLETED',
        'DISTILLATION_CLOSED',
        'BOTTLED',
        'DOSSIER_CLOSED',
      ]),
    );
    // Sin cifras internas ni motivos (S-22)
    const text = JSON.stringify(data);
    expect(text).not.toContain('18400');
    expect(text).not.toContain('12100');
    expect(text).not.toContain('otro lote');
    expect(res.headers['cache-control']).toBe(
      'public, max-age=3600, stale-while-revalidate=600',
    );
  });

  it('7b · pasaporte de la botella: la prueba Merkle reproduce la raíz del expediente; las bajas, según S-14', async () => {
    const verify = (
      serial: number,
      code: string,
      proof: Proof | null,
    ): boolean =>
      proof !== null &&
      verifyMerkleProof(
        bottleLeafHash(serial, code, proof.salt),
        proof.path,
        merkleRoot,
      );
    const proofOf = async (code: string) => {
      const res = await passport(code);
      return res.body.data.bottle as {
        code: string;
        serial: number;
        lotTotal: number;
        status: string;
        merkleProof: Proof | null;
      };
    };

    // La raíz guardada es la del expediente canónico público
    const stored = await prisma.lotDossier.findUniqueOrThrow({
      where: { lotId },
    });
    expect(stored.bottleMerkleRoot).toBe(merkleRoot);

    const plain = await proofOf(bottle.plain.code);
    expect(plain).toMatchObject({
      code: bottle.plain.code,
      serial: 1234,
      lotTotal: 2950,
      status: 'ACTIVE',
    });
    expect(plain.merkleProof?.salt).toMatch(/^[0-9a-f]{32}$/);
    // 2.949 hojas: 12 niveles como mucho
    expect(plain.merkleProof?.path.length).toBeLessThanOrEqual(12);
    expect(verify(1234, bottle.plain.code, plain.merkleProof)).toBe(true);
    // Otra etiqueta con la misma serie y la misma sal no verifica
    expect(verify(1234, generateBottleCode(), plain.merkleProof)).toBe(false);
    expect(verify(1235, bottle.plain.code, plain.merkleProof)).toBe(false);
    // Tecleado con guion y minúsculas, el mismo pasaporte
    const typed = await passport(
      formatBottleCode(bottle.plain.code).toLowerCase(),
    );
    expect(typed.body.data.bottle.code).toBe(bottle.plain.code);

    // Sustituido antes del cierre: el anulado no entró en la raíz; el sustituto sí
    const replaced = await proofOf(bottle.replaced.code);
    expect(replaced).toMatchObject({
      serial: 7,
      status: 'VOIDED',
      merkleProof: null,
    });
    const replacement = await proofOf(bottle.replacement.code);
    expect(replacement).toMatchObject({ serial: 7, status: 'ACTIVE' });
    expect(verify(7, bottle.replacement.code, replacement.merkleProof)).toBe(
      true,
    );
    // Baja sin sustituto antes del cierre: sin prueba
    expect(await proofOf(bottle.voidedBefore.code)).toMatchObject({
      serial: 8,
      status: 'VOIDED',
      merkleProof: null,
    });

    // S-14: con el expediente cerrado, un código se anula pero no se sustituye
    const before = await proofOf(bottle.voidedAfter.code);
    expect(verify(9, bottle.voidedAfter.code, before.merkleProof)).toBe(true);
    const substitute = await checked(
      'post',
      'enologist',
      `/v1/bottle-codes/${bottle.voidedAfter.code}/void`,
      409,
      { reason: 'Etiqueta dañada', replace: true },
    );
    expect(substitute.body.error.code).toBe('TRC_DOSSIER_CLOSED');
    const voided = await checked(
      'post',
      'enologist',
      `/v1/bottle-codes/${bottle.voidedAfter.code}/void`,
      200,
      { reason: 'Botella rota tras el cierre' },
    );
    expect(voided.body.data).toMatchObject({
      status: 'VOIDED',
      voided: { replacedBy: null },
    });
    // El visor avisa "código anulado", y la botella sigue probando que formó
    // parte del expediente: la raíz y la huella no cambian
    const after = await proofOf(bottle.voidedAfter.code);
    expect(after).toMatchObject({ serial: 9, status: 'VOIDED' });
    expect(after.merkleProof).toEqual(before.merkleProof);
    expect(verify(9, bottle.voidedAfter.code, after.merkleProof)).toBe(true);
    // Las demás pruebas siguen valiendo con la baja posterior
    const again = await proofOf(bottle.plain.code);
    expect(again.merkleProof).toEqual(plain.merkleProof);
    const dossier = await checked(
      'get',
      'enologist',
      `/v1/lots/${lotId}/dossier`,
      200,
    );
    expect(dossier.body.data).toMatchObject({
      hash,
      bottleCodes: { count: 2949, merkleRoot },
    });
    const bottling = await checked(
      'get',
      'enologist',
      `/v1/bottling/${bottlingId}`,
      200,
    );
    expect(bottling.body.data.bottleCodes).toMatchObject({
      active: 2948,
      voided: 3,
    });
    // El pasaporte de una botella no se cachea una hora: aún se puede anular
    const cache = await passport(bottle.plain.code);
    expect(cache.headers['cache-control']).toBe(
      'public, max-age=60, stale-while-revalidate=600',
    );
  });

  it('aislamiento: el grafo de otra bodega → 404; un pasaporte inexistente → 404 uniforme', async () => {
    const graph = await checked('get', 'other', `/v1/lots/${lotId}/graph`, 404);
    expect(graph.body.error.code).toBe('TRC_LOT_NOT_FOUND');
    await checked('get', 'other', `/v1/lots/${lotId}/dossier`, 404);
    await checked(
      'post',
      'other',
      `/v1/bottle-codes/${bottle.plain.code}/void`,
      404,
      { reason: 'No es de esta bodega' },
    );
    // La plataforma lee, con la bodega indicada
    await checked(
      'get',
      'platform',
      `/v1/lots/${lotId}/graph?wineryId=${WINERY}`,
      200,
    );
    expect(OTHER).not.toBe(WINERY);

    let unused = generateBottleCode();
    while (await prisma.bottleUnit.findUnique({ where: { code: unused } })) {
      unused = generateBottleCode();
    }
    const missing = await passport(unused, 404);
    expect(missing.body.error).toMatchObject({
      code: 'PUB_CODE_NOT_FOUND',
      message: 'Código no encontrado',
    });
    const missingLot = await passport('ZZZ-2026-SINGANI-999', 404);
    expect(missingLot.body.error.code).toBe('PUB_CODE_NOT_FOUND');
  });
});
