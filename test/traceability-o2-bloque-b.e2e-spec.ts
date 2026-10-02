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
  BOTTLE_CSV_HEADER,
  bottleCsvHeader,
} from '../src/modules/lots/domain/bottle-csv';
import {
  formatBottleCode,
  isValidBottleCode,
} from '../src/modules/lots/domain/bottle-code';
import { canonicalize } from '../src/modules/lots/domain/jcs';
import {
  bottleLeafHash,
  merkleProof,
  merkleRoot,
  verifyMerkleProof,
} from '../src/modules/lots/domain/merkle';
import {
  bottleMerkleProof,
  closedDossierLeaves,
} from '../src/modules/lots/lot-dossier';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import {
  ObjectStorage,
  STORAGE_SERVICE,
} from '../src/shared/storage/storage.interface';
import { createObjectStorage } from '../src/shared/storage/storage.module';
import { loadOpenApiValidator } from './helpers/openapi-validator';
import {
  addWineryMember,
  platformStaff,
  staffToken,
  wineryWithOwner,
} from './helpers/staff-session';
import { readZipEntries } from './helpers/zip';
import { uploadTraceFile } from './helpers/trace-files';

/**
 * Ola 2 · bloque B (O2-BE-1, pasos 2.5, 2.6 y 2.8): embotellado seguro,
 * códigos de botella (listado, CSV, ZIP para la imprenta, anular y sustituir)
 * y expediente del lote con hash canónico y raíz Merkle. Con almacenamiento
 * local en una carpeta temporal y las respuestas JSON validadas contra
 * `openapi.json`.
 *
 * Corre en una **base de datos propia** (no solo un esquema): los candados de
 * aviso de Postgres son por base de datos, y el de la cadena de la bitácora
 * lo retiene durante toda su transacción la semilla que cargan otras suites
 * (decenas de segundos), más de lo que espera una escritura auditada (15 s).
 * Además, el worker de otras suites no ve su outbox.
 *
 * La cadena anterior al embotellado (pesaje, tanque, destilación o crianza)
 * se siembra con Prisma: sus rutas son de otros pasos de la ola.
 */
process.env.TRUST_PROXY = '1';
jest.setTimeout(180_000);

const run = `${Date.now()}${randomBytes(3).toString('hex')}`;
const database = `o2b_e2e_${run}`;
const originalUrl = process.env.DATABASE_URL ?? '';
const PASSPORT = 'https://pasaporte.o2b.test';

function urlWithDatabase(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  parsed.searchParams.set('schema', 'public');
  return parsed.toString();
}
const databaseUrl = urlWithDatabase(originalUrl, database);

/** Sentencia de administración en la base original (crear y borrar la propia). */
async function onOriginalDatabase(sql: string): Promise<void> {
  const admin = new PrismaClient({
    datasources: { db: { url: originalUrl } },
  });
  try {
    await admin.$executeRawUnsafe(sql);
  } finally {
    await admin.$disconnect();
  }
}

/** Día de calendario de hace `n` días (UTC; `n ≥ 2` evita el borde de La Paz). */
function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
const dbDate = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
const sha256 = (data: Buffer | string) =>
  createHash('sha256').update(data).digest('hex');
const stripBom = (text: string) =>
  text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

type Res = request.Response;
type Detail = {
  field?: string | null;
  code?: string;
  message?: string;
  meta?: Record<string, unknown>;
};
const details = (res: Res): Detail[] =>
  (res.body.error?.details ?? []) as Detail[];
const codes = (res: Res): string[] => details(res).map((d) => d.code ?? '');

interface Winery {
  id: string;
  terroirId: string;
  ownerMembershipId: string;
}

interface Unit {
  code: string;
  codeFormatted: string;
  serial: number;
  status: string;
  qrUrl: string;
  voided: { reason: string; replacedBy: string | null; by: unknown } | null;
  replaces: string | null;
  exportsCount: number;
  firstExportedAt: string | null;
}

const VINTAGE = Number(daysAgo(260).slice(0, 4));
const SINGANI_BOTTLING = {
  bottlingDate: daysAgo(2),
  packagingFormatCl: 75,
  totalBottlesPackaged: 2950,
  finalAlcoholAbv: 40,
  waterDilutionLiters: 750,
};

describe('Ola 2 · bloque B: embotellado, códigos de botella y expediente (e2e)', () => {
  const openapi = loadOpenApiValidator();
  const storageDir = mkdtempSync(join(tmpdir(), 'doc-o2b-'));
  let app: INestApplication;
  let prisma: PrismaService;
  let storage: ObjectStorage;
  let w1: Winery;
  let w2: Winery;
  let ipSeq = 1;
  let chainSeq = 0;
  const nextIp = () =>
    `10.232.${Math.floor(Math.random() * 200)}.${(ipSeq++ % 250) + 1}`;
  const tokens = {
    owner: '',
    enologist: '',
    operator: '',
    accountant: '',
    other: '',
    admin: '',
    support: '',
  };
  type Who = keyof typeof tokens;
  const http = () => request(app.getHttpServer());

  function call(
    method: 'get' | 'post' | 'patch',
    who: Who,
    path: string,
    body?: object,
    headers: Record<string, string> = {},
  ): request.Test {
    const req = http()[method](path).set('X-Forwarded-For', nextIp());
    if (tokens[who]) req.set('Authorization', `Bearer ${tokens[who]}`);
    for (const [name, value] of Object.entries(headers)) req.set(name, value);
    return body ? req.send(body) : req;
  }

  /** Llamada cuya respuesta se valida contra `openapi.json`. */
  async function checked(
    method: 'get' | 'post' | 'patch',
    who: Who,
    path: string,
    status: number,
    body?: object,
    headers: Record<string, string> = {},
  ): Promise<Res> {
    const res = await call(method, who, path, body, headers);
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
  async function download(
    who: Who | null,
    path: string,
  ): Promise<{
    status: number;
    headers: Record<string, string>;
    body: Buffer;
  }> {
    const req = http().get(path).set('X-Forwarded-For', nextIp());
    if (who) req.set('Authorization', `Bearer ${tokens[who]}`);
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

  async function newWinery(name: string, ownerEmail: string): Promise<Winery> {
    const created = await wineryWithOwner(app, {
      name,
      email: ownerEmail,
      password: 'Password-o2b-123',
      category: WineryCategoryEnum.DISTILLERY,
      region: 'Camargo, Chuquisaca',
    });
    const terroir = await prisma.terroir.create({
      data: {
        wineryId: created.wineryId,
        parcelName: 'Los Parrales',
        surfaceHectares: 4,
        altitudeMasl: 1850,
        rawMaterialType: 'Uva',
        varietyName: 'Moscatel de Alejandría',
      },
    });
    return {
      id: created.wineryId,
      terroirId: terroir.id,
      ownerMembershipId: created.membershipId,
    };
  }

  async function memberToken(
    winery: Winery,
    role: WineryMemberRoleEnum,
    email: string,
  ): Promise<string> {
    const member = await addWineryMember(app, {
      wineryId: winery.id,
      role,
      email,
      fullName: `Persona ${role}`,
    });
    return staffToken(app, {
      userId: member.userId,
      email,
      organizationId: winery.id,
      organizationType: 'WINERY',
      role: role as unknown as MembershipRoleEnum,
    });
  }

  async function createLot(
    who: Who,
    name: string,
    productType: 'SINGANI' | 'WINE',
  ): Promise<string> {
    const res = await call('post', who, '/v1/lots', {
      name,
      harvestYear: VINTAGE,
      productType,
      estimatedBottles: 3000,
      plannedFormatCl: 75,
      ...(productType === 'SINGANI' && { targetAbvPercent: 40 }),
    }).expect(201);
    return res.body.data.id as string;
  }

  /** Pesaje aprobado y tanque trasegado del lote (sembrados). */
  async function seedTank(winery: Winery, lotId: string, destination: string) {
    const n = ++chainSeq;
    const harvest = await prisma.harvestBatch.create({
      data: {
        wineryId: winery.id,
        terroirId: winery.terroirId,
        harvestBatchCode: `HARV-${VINTAGE}-PARRALES-${String(n).padStart(3, '0')}`,
        intakeDate: dbDate(daysAgo(260)),
        harvestYear: VINTAGE,
        grossWeightKg: 18500,
        tareWeightKg: 100,
        netWeightKg: 18400,
        phytosanitaryStatus: 'APPROVED',
        lotId,
        createdByMembershipId: winery.ownerMembershipId,
        terroirSnapshot: {
          parcelName: 'Los Parrales',
          altitudeMasl: 1850,
          varietyName: 'Moscatel de Alejandría',
          rawMaterialType: 'Uva',
          takenAt: new Date().toISOString(),
        },
      },
    });
    const tank = await prisma.fermentationTank.create({
      data: {
        wineryId: winery.id,
        harvestBatchId: harvest.id,
        tankCode: `TK-B-${n}`,
        capacityLiters: 15000,
        volumeFilledLiters: 12100,
        finalVolumeLiters: 12100,
        destinationType: destination as 'SINGANI_DIST' | 'WINE_AGING',
        status: 'TRANSFERRED',
        startDate: new Date(`${daysAgo(258)}T14:00:00Z`),
        endDate: new Date(`${daysAgo(245)}T14:00:00Z`),
        lotId,
        createdByMembershipId: winery.ownerMembershipId,
      },
    });
    await prisma.fermentationTankInput.create({
      data: {
        fermentationTankId: tank.id,
        harvestBatchId: harvest.id,
        kg: 18400,
      },
    });
    return { harvest, tank };
  }

  /** Destilación cerrada del lote, con el reposo cumplido salvo que se indique. */
  async function seedDistillation(
    winery: Winery,
    lotId: string,
    options: { heartLiters?: number; abv?: number; endedDaysAgo?: number } = {},
  ): Promise<string> {
    const { tank } = await seedTank(winery, lotId, 'SINGANI_DIST');
    const heart = options.heartLiters ?? 1500;
    const abv = options.abv ?? 60;
    const ended = options.endedDaysAgo ?? 200;
    const production = await prisma.productionBatch.create({
      data: {
        wineryId: winery.id,
        fermentationTankId: tank.id,
        processType: 'SINGANI_DISTILLATION',
        equipmentIdentifier: 'Alambique AL-B',
        processStartDate: dbDate(daysAgo(ended + 5)),
        processEndDate: dbDate(daysAgo(ended)),
        inputVolumeLiters: 12100,
        outputVolumeLiters: heart,
        headsLiters: 120,
        heartLiters: heart,
        tailsLiters: 210,
        heartAbvPercent: abv,
        initialAlcoholPercentage: abv,
        isDoEligible: true,
        mandatoryRestUntil: dbDate(daysAgo(ended - 180)),
        restStatus: 'RESTING',
        lotId,
        createdByMembershipId: winery.ownerMembershipId,
      },
    });
    await prisma.lot.update({
      where: { id: lotId },
      data: { stage: 'RESTING' },
    });
    return production.id;
  }

  /** Crianza del lote, con el candado cumplido. */
  async function seedAging(winery: Winery, lotId: string): Promise<string> {
    const { tank } = await seedTank(winery, lotId, 'WINE_AGING');
    const aging = await prisma.wineAgingBatch.create({
      data: {
        wineryId: winery.id,
        fermentationTankId: tank.id,
        containerType: 'Barrica',
        containerMaterial: 'Roble francés',
        volumeLiters: 1000,
        plannedMonths: 6,
        startDate: dbDate(daysAgo(240)),
        lockUntilDate: dbDate(daysAgo(50)),
        agingStatus: 'AGING',
        lotId,
        createdByMembershipId: winery.ownerMembershipId,
      },
    });
    await prisma.lot.update({ where: { id: lotId }, data: { stage: 'AGING' } });
    return aging.id;
  }

  /** Lote singani en reposo cumplido, listo para embotellar. */
  async function restingLot(
    who: Who,
    winery: Winery,
    name: string,
    options: Parameters<typeof seedDistillation>[2] = {},
  ): Promise<{ lotId: string; productionId: string }> {
    const lotId = await createLot(who, name, 'SINGANI');
    const productionId = await seedDistillation(winery, lotId, options);
    return { lotId, productionId };
  }

  /** Informe de laboratorio subido una vez: los análisis lo citan por su `key`. */
  let reportKey: string | undefined;
  async function labAnalysis(
    lotId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<Res> {
    reportKey ??= await uploadTraceFile(app, tokens.owner, { ip: nextIp() });
    return call('post', 'owner', `/v1/lots/${lotId}/lab-analyses`, {
      certifiedLaboratoryName: 'Laboratorio e2e ISO 17025',
      accreditedLabCertificationCode: `LAB-${run}`,
      testPerformedAt: daysAgo(2),
      actualAlcoholAbv: 40.05,
      totalAcidityTartaricGl: 4.8,
      volatileAcidityAceticGl: 0.22,
      copperContentMgL: 0.02,
      methanolContentMgL: 48,
      laboratoryReportKey: reportKey,
      ...overrides,
    });
  }

  async function listCodes(lotId: string, query = ''): Promise<Unit[]> {
    const res = await checked(
      'get',
      'owner',
      `/v1/lots/${lotId}/bottle-codes${query}`,
      200,
    );
    return res.body.data.items as Unit[];
  }

  beforeAll(async () => {
    await onOriginalDatabase(`CREATE DATABASE "${database}"`);
    execFileSync(
      process.execPath,
      [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
      { env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'pipe' },
    );
    process.env.DATABASE_URL = databaseUrl;
    process.env.PASSPORT_BASE_URL = PASSPORT;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(STORAGE_SERVICE)
      .useFactory({
        inject: [ConfigService],
        factory: (config: ConfigService) => {
          const env: Record<string, string> = {
            STORAGE_DRIVER: 'local',
            STORAGE_LOCAL_PATH: storageDir,
          };
          return createObjectStorage({
            get: (key: string, fallback?: unknown) =>
              env[key] ?? config.get(key) ?? fallback,
            getOrThrow: (key: string) => env[key] ?? config.getOrThrow(key),
          } as unknown as ConfigService);
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    storage = app.get<ObjectStorage>(STORAGE_SERVICE);

    w1 = await newWinery(
      `Destilería Bloque B ${run}`,
      `duena1-${run}@o2b.test`,
    );
    w2 = await newWinery(`Viñedos Paralelos ${run}`, `duena2-${run}@o2b.test`);
    const owner = async (winery: Winery, email: string) => {
      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      return staffToken(app, {
        userId: user.id,
        email,
        organizationId: winery.id,
        organizationType: 'WINERY',
        role: MembershipRoleEnum.OWNER,
      });
    };
    tokens.owner = await owner(w1, `duena1-${run}@o2b.test`);
    tokens.other = await owner(w2, `duena2-${run}@o2b.test`);
    tokens.enologist = await memberToken(
      w1,
      WineryMemberRoleEnum.ENOLOGIST,
      `enologa-${run}@o2b.test`,
    );
    tokens.operator = await memberToken(
      w1,
      WineryMemberRoleEnum.OPERATOR,
      `operario-${run}@o2b.test`,
    );
    tokens.accountant = await memberToken(
      w1,
      WineryMemberRoleEnum.ACCOUNTANT,
      `contabilidad-${run}@o2b.test`,
    );
    tokens.admin = (
      await platformStaff(app, prisma, {
        email: `admin-${run}@drinksonchain.test`,
        fullName: 'Administración e2e',
        role: MembershipRoleEnum.ADMIN,
      })
    ).token;
    tokens.support = (
      await platformStaff(app, prisma, {
        email: `soporte-${run}@drinksonchain.test`,
        fullName: 'Soporte e2e',
        role: MembershipRoleEnum.SUPPORT,
      })
    ).token;
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await onOriginalDatabase(
      `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`,
    );
    rmSync(storageDir, { recursive: true, force: true });
    process.env.DATABASE_URL = originalUrl;
    delete process.env.PASSPORT_BASE_URL;
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('embotellado seguro (§6.2–§6.3)', () => {
    let lotId: string;
    let productionId: string;

    beforeAll(async () => {
      ({ lotId, productionId } = await restingLot(
        'owner',
        w1,
        'Singani Gran Reserva e2e B',
      ));
    });

    it('la vista previa da el balance y las violaciones sin escribir nada', async () => {
      const ok = await checked(
        'post',
        'enologist',
        `/v1/lots/${lotId}/bottling/preview`,
        200,
        SINGANI_BOTTLING,
      );
      expect(ok.body.data).toMatchObject({
        valid: true,
        violations: [],
        balance: {
          availableLiters: 1500,
          waterDilutionLiters: 750,
          bottledLiters: 2212.5,
          lossLiters: 37.5,
          lossPercent: 1.67,
          maxLossPercent: 5,
          maxBottles: 3000,
          pureAlcohol: { availableLiters: 900, bottledLiters: 885 },
        },
      });
      await expect(
        prisma.bottlingBatch.count({ where: { lotId } }),
      ).resolves.toBe(0);
      await expect(prisma.bottleUnit.count({ where: { lotId } })).resolves.toBe(
        0,
      );
    });

    it('más botellas que litros → TRC_BOTTLING_EXCEEDS_VOLUME con maxBottles (§18)', async () => {
      const res = await checked(
        'post',
        'owner',
        `/v1/lots/${lotId}/bottling`,
        422,
        { ...SINGANI_BOTTLING, totalBottlesPackaged: 3100 },
      );
      expect(res.body.error.code).toBe('TRC_BOTTLING_EXCEEDS_VOLUME');
      expect(details(res)[0]).toMatchObject({
        field: 'totalBottlesPackaged',
        meta: { maxBottles: 3000 },
      });
    });

    it('más agua para inflar botellas → TRC_ALCOHOL_BALANCE_EXCEEDED; la tolerancia de medida es del 0,5 % (S-11)', async () => {
      const watered = await checked(
        'post',
        'owner',
        `/v1/lots/${lotId}/bottling`,
        422,
        {
          ...SINGANI_BOTTLING,
          waterDilutionLiters: 1100,
          totalBottlesPackaged: 3400,
        },
      );
      expect(codes(watered)).toContain('TRC_ALCOHOL_BALANCE_EXCEEDED');
      // 900 L de alcohol puro × 1,005 = 904,5 L → 3.015 botellas de 75 cL al 40 %
      const atTolerance = await checked(
        'post',
        'owner',
        `/v1/lots/${lotId}/bottling/preview`,
        200,
        {
          ...SINGANI_BOTTLING,
          waterDilutionLiters: 800,
          totalBottlesPackaged: 3015,
        },
      );
      expect(atTolerance.body.data.valid).toBe(true);
      const over = await checked(
        'post',
        'owner',
        `/v1/lots/${lotId}/bottling/preview`,
        200,
        {
          ...SINGANI_BOTTLING,
          waterDilutionLiters: 800,
          totalBottlesPackaged: 3016,
        },
      );
      expect(over.body.data.valid).toBe(false);
      expect(
        (over.body.data.violations as Detail[]).map((v) => v.code),
      ).toEqual(['TRC_ALCOHOL_BALANCE_EXCEEDED']);
    });

    it('una fuente repetida no cuenta dos veces: TRC_BOTTLING_SOURCE_INVALID', async () => {
      const res = await checked(
        'post',
        'owner',
        `/v1/lots/${lotId}/bottling`,
        422,
        {
          ...SINGANI_BOTTLING,
          totalBottlesPackaged: 5900,
          waterDilutionLiters: 1500,
          sources: [
            { productionBatchId: productionId, liters: 1500 },
            { productionBatchId: productionId, liters: 1500 },
          ],
        },
      );
      expect(res.body.error.code).toBe('TRC_BOTTLING_SOURCE_INVALID');
      expect(details(res)[0]).toMatchObject({
        field: 'sources.1.productionBatchId',
        meta: { sourceId: productionId },
      });
      // Con una sola vez la fuente, 5.900 botellas no caben
      expect(codes(res)).toContain('TRC_BOTTLING_EXCEEDS_VOLUME');
    });

    it('tomar menos litros de la fuente no esconde merma: se declara el remanente o es merma', async () => {
      const body = {
        ...SINGANI_BOTTLING,
        waterDilutionLiters: 500,
        totalBottlesPackaged: 1950, // 1.462,5 L
        sources: [{ productionBatchId: productionId, liters: 1000 }],
      };
      const hidden = await checked(
        'post',
        'owner',
        `/v1/lots/${lotId}/bottling/preview`,
        200,
        body,
      );
      // Disponible: los 1.500 L de la fuente (queda BOTTLED), no los 1.000 pedidos
      expect(hidden.body.data.balance).toMatchObject({
        availableLiters: 1500,
        lossLiters: 537.5,
        pureAlcohol: { availableLiters: 600 },
      });
      expect(
        (hidden.body.data.violations as Detail[]).map((v) => v.code),
      ).toEqual(['TRC_BOTTLING_LOSS_ABOVE_TOLERANCE']);
      const declared = await checked(
        'post',
        'owner',
        `/v1/lots/${lotId}/bottling/preview`,
        200,
        { ...body, leftover: { liters: 500, disposition: 'RETAINED' } },
      );
      expect(declared.body.data).toMatchObject({
        valid: true,
        balance: { leftoverLiters: 500, lossLiters: 37.5 },
      });
      // Y el alcohol disponible es solo el de los litros que se toman
      const inflated = await checked(
        'post',
        'owner',
        `/v1/lots/${lotId}/bottling/preview`,
        200,
        {
          ...body,
          finalAlcoholAbv: 45,
          leftover: { liters: 500, disposition: 'RETAINED' },
        },
      );
      expect(
        (inflated.body.data.violations as Detail[]).map((v) => v.code),
      ).toEqual(['TRC_ALCOHOL_BALANCE_EXCEEDED']);
      const tooMuch = await checked(
        'post',
        'owner',
        `/v1/lots/${lotId}/bottling/preview`,
        200,
        {
          ...body,
          sources: [{ productionBatchId: productionId, liters: 1600 }],
        },
      );
      expect(
        (tooMuch.body.data.violations as Detail[]).map((v) => v.code),
      ).toContain('TRC_VOLUME_EXCEEDS_AVAILABLE');
    });

    it('la etiqueta es un archivo de la propia bodega: ajena o inexistente → TRC_FILE_NOT_FOUND', async () => {
      const foreign = await checked(
        'post',
        'owner',
        `/v1/lots/${lotId}/bottling`,
        422,
        {
          ...SINGANI_BOTTLING,
          labelDesignKey: `org/${w2.id}/labels/2026/10/etiqueta.png`,
        },
      );
      expect(foreign.body.error.code).toBe('TRC_FILE_NOT_FOUND');
      expect(details(foreign)[0]).toMatchObject({ field: 'labelDesignKey' });
      const missing = await checked(
        'post',
        'owner',
        `/v1/lots/${lotId}/bottling/preview`,
        200,
        {
          ...SINGANI_BOTTLING,
          labelDesignKey: `org/${w1.id}/labels/2026/10/no-existe.png`,
        },
      );
      expect(missing.body.data.valid).toBe(false);
      expect(
        (missing.body.data.violations as Detail[]).map((v) => v.code),
      ).toEqual(['TRC_FILE_NOT_FOUND']);
    });

    it('la fecha de embotellado no puede ser futura ni anterior al fin del reposo', async () => {
      const future = await checked(
        'post',
        'owner',
        `/v1/lots/${lotId}/bottling`,
        422,
        { ...SINGANI_BOTTLING, bottlingDate: '2099-01-01' },
      );
      expect(future.body.error.code).toBe('TRC_DATE_IN_FUTURE');
      const early = await checked(
        'post',
        'owner',
        `/v1/lots/${lotId}/bottling`,
        422,
        { ...SINGANI_BOTTLING, bottlingDate: daysAgo(100) },
      );
      expect(early.body.error.code).toBe('TRC_LOCK_NOT_RELEASED');
    });

    it('vino: sin agua (S-12) y con el tipo derivado de la crianza', async () => {
      const wineLot = await createLot('owner', 'Tinto de altura e2e B', 'WINE');
      await seedAging(w1, wineLot);
      const watered = await checked(
        'post',
        'owner',
        `/v1/lots/${wineLot}/bottling`,
        422,
        {
          bottlingDate: daysAgo(2),
          packagingFormatCl: 75,
          totalBottlesPackaged: 1300,
          finalAlcoholAbv: 13.5,
          waterDilutionLiters: 20,
        },
      );
      expect(codes(watered)).toContain('TRC_DILUTION_NOT_ALLOWED');
      const wine = await checked(
        'post',
        'owner',
        `/v1/lots/${wineLot}/bottling`,
        201,
        {
          bottlingDate: daysAgo(2),
          packagingFormatCl: 75,
          totalBottlesPackaged: 1300,
          finalAlcoholAbv: 13.5,
        },
      );
      expect(wine.body.data).toMatchObject({
        productType: 'WINE',
        balance: { availableLiters: 1000, pureAlcohol: null },
        bottleCodes: { total: 1300, active: 1300 },
      });
      expect(wine.body.data.lotCode).toMatch(/^[A-Z]{3,5}-\d{4}-WINE-\d{3}$/);
    });

    it('embotella una sola vez: código de lote, QR con PASSPORT_BASE_URL y un código por botella', async () => {
      await storage.put(
        `org/${w1.id}/labels/2026/10/etiqueta-${run}.png`,
        Buffer.from('png'),
        'image/png',
      );
      const bottled = await checked(
        'post',
        'enologist',
        `/v1/lots/${lotId}/bottling`,
        201,
        {
          ...SINGANI_BOTTLING,
          labelDesignKey: `org/${w1.id}/labels/2026/10/etiqueta-${run}.png`,
        },
      );
      const lotCode = bottled.body.data.lotCode as string;
      expect(lotCode).toMatch(
        new RegExp(`^[A-Z]{3,5}-${daysAgo(2).slice(0, 4)}-SINGANI-\\d{3}$`),
      );
      expect(bottled.body.data).toMatchObject({
        lotId,
        internationalLotCode: lotCode,
        qrBatchUrl: `${PASSPORT}/b/${lotCode}`,
        blockchainDataHash: null,
        bottleCodes: {
          total: 2950,
          active: 2950,
          voided: 0,
          firstSerial: 1,
          lastSerial: 2950,
        },
        labelDesign: {
          key: `org/${w1.id}/labels/2026/10/etiqueta-${run}.png`,
        },
      });
      const again = await checked(
        'post',
        'owner',
        `/v1/lots/${lotId}/bottling`,
        409,
        SINGANI_BOTTLING,
      );
      expect(again.body.error.code).toBe('TRC_LOT_ALREADY_BOTTLED');
      expect(details(again)[0].meta).toMatchObject({ lotCode });
      const preview = await checked(
        'post',
        'owner',
        `/v1/lots/${lotId}/bottling/preview`,
        409,
        SINGANI_BOTTLING,
      );
      expect(preview.body.error.code).toBe('TRC_LOT_ALREADY_BOTTLED');
      const legacy = await call('post', 'owner', '/v1/bottling', {
        productionBatchId: productionId,
        productType: 'SINGANI',
        finalAlcoholAbv: 40,
        totalBottlesPackaged: 10,
        packagingFormatCl: 75,
        bottlingDate: daysAgo(2),
      });
      // La ruta legada se retiró en H2: el embotellado es el del lote
      expect(legacy.status).toBe(404);

      // Fuente y lote en estados terminales, con sus eventos y la bitácora
      const production = await prisma.productionBatch.findUniqueOrThrow({
        where: { id: productionId },
      });
      expect(production.restStatus).toBe('BOTTLED');
      const lot = await checked('get', 'owner', `/v1/lots/${lotId}`, 200);
      expect(lot.body.data).toMatchObject({
        stage: 'BOTTLED',
        lotCode,
        bottles: 2950,
      });
      const events = await prisma.lotEvent.findMany({
        where: { lotId, type: { in: ['BOTTLED', 'BOTTLE_CODES_GENERATED'] } },
        orderBy: { seq: 'asc' },
      });
      expect(events.map((e) => e.type)).toEqual([
        'BOTTLED',
        'BOTTLE_CODES_GENERATED',
      ]);
      await expect(
        prisma.auditEvent.count({
          where: { action: 'BOTTLED', organizationId: w1.id },
        }),
      ).resolves.toBeGreaterThan(0);
    });

    it('dos bodegas embotellan a la vez: cada una su prefijo y su secuencia, sin colisión (§18)', async () => {
      // La segunda bodega estrena aquí su prefijo de lote y su secuencia
      const [a, b] = await Promise.all([
        restingLot('owner', w1, 'Simultáneo bodega 1'),
        restingLot('other', w2, 'Simultáneo bodega 2'),
      ]);
      const [first, second] = await Promise.all([
        call('post', 'owner', `/v1/lots/${a.lotId}/bottling`, SINGANI_BOTTLING),
        call('post', 'other', `/v1/lots/${b.lotId}/bottling`, SINGANI_BOTTLING),
      ]);
      expect([first.status, second.status]).toEqual([201, 201]);
      const codeA = first.body.data.lotCode as string;
      const codeB = second.body.data.lotCode as string;
      expect(codeA).not.toBe(codeB);
      expect(codeA.split('-')[0]).not.toBe(codeB.split('-')[0]);
      // La otra bodega estrena su secuencia
      expect(codeB).toMatch(/-SINGANI-001$/);
      const prefixes = await prisma.winery.findMany({
        where: { id: { in: [w1.id, w2.id] } },
        select: { lotPrefix: true },
      });
      expect(new Set(prefixes.map((p) => p.lotPrefix)).size).toBe(2);
      // Los códigos de botella son únicos en toda la plataforma
      const all = await prisma.bottleUnit.findMany({ select: { code: true } });
      expect(new Set(all.map((u) => u.code)).size).toBe(all.length);
    });

    it('la misma bodega embotella dos lotes a la vez: números de lote consecutivos y distintos', async () => {
      const lots = await Promise.all(
        [1, 2, 3].map((n) => restingLot('owner', w1, `Paralelo ${n}`)),
      );
      const results = await Promise.all(
        lots.map((l) =>
          call('post', 'owner', `/v1/lots/${l.lotId}/bottling`, {
            ...SINGANI_BOTTLING,
            totalBottlesPackaged: 2900,
          }),
        ),
      );
      expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
      const numbers = results
        .map((r) => Number((r.body.data.lotCode as string).split('-').pop()))
        .sort((x, y) => x - y);
      expect(new Set(numbers).size).toBe(3);
      expect(numbers[2] - numbers[0]).toBe(2);
    });

    it('dos embotellados simultáneos del mismo lote: uno entra y el otro es TRC_LOT_ALREADY_BOTTLED', async () => {
      const { lotId: raced } = await restingLot('owner', w1, 'Carrera e2e');
      const results = await Promise.all([
        call('post', 'owner', `/v1/lots/${raced}/bottling`, SINGANI_BOTTLING),
        call('post', 'enologist', `/v1/lots/${raced}/bottling`, {
          ...SINGANI_BOTTLING,
          totalBottlesPackaged: 2900,
        }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(results.find((r) => r.status === 409)?.body.error.code).toBe(
        'TRC_LOT_ALREADY_BOTTLED',
      );
      await expect(
        prisma.bottlingBatch.count({ where: { lotId: raced } }),
      ).resolves.toBe(1);
      const winner = results.find((r) => r.status === 201)!;
      await expect(
        prisma.bottleUnit.count({ where: { lotId: raced } }),
      ).resolves.toBe(winner.body.data.totalBottlesPackaged);
    });

    it('permisos: el operario no embotella, la plataforma solo lee y otra bodega no ve el lote', async () => {
      const { lotId: guarded } = await restingLot('owner', w1, 'Permisos e2e');
      const operator = await call(
        'post',
        'operator',
        `/v1/lots/${guarded}/bottling`,
        SINGANI_BOTTLING,
      );
      expect(operator.status).toBe(403);
      const platform = await checked(
        'post',
        'admin',
        `/v1/lots/${guarded}/bottling?wineryId=${w1.id}`,
        403,
        SINGANI_BOTTLING,
      );
      expect(platform.body.error.code).toBe('TRC_PLATFORM_READ_ONLY');
      const foreign = await checked(
        'post',
        'other',
        `/v1/lots/${guarded}/bottling/preview`,
        404,
        SINGANI_BOTTLING,
      );
      expect(foreign.body.error.code).toBe('TRC_LOT_NOT_FOUND');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('códigos de botella (§7)', () => {
    let lotId: string;
    let lotCode: string;
    let units: { code: string; serial: number }[];

    beforeAll(async () => {
      ({ lotId } = await restingLot('owner', w1, 'Singani de los códigos'));
    });

    it('antes de embotellar no hay códigos: 409 TRC_LOT_NOT_BOTTLED', async () => {
      const list = await checked(
        'get',
        'owner',
        `/v1/lots/${lotId}/bottle-codes`,
        409,
      );
      expect(list.body.error.code).toBe('TRC_LOT_NOT_BOTTLED');
      expect(details(list)[0].meta).toMatchObject({ stage: 'RESTING' });
      const csv = await checked(
        'get',
        'owner',
        `/v1/lots/${lotId}/bottle-codes/export`,
        409,
      );
      expect(csv.body.error.code).toBe('TRC_LOT_NOT_BOTTLED');
      const zip = await checked(
        'post',
        'owner',
        `/v1/lots/${lotId}/bottle-codes/exports`,
        409,
        { format: 'ZIP', qr: { imageFormat: 'SVG' } },
      );
      expect(zip.body.error.code).toBe('TRC_LOT_NOT_BOTTLED');
    });

    it('lista paginada por serie, con el código formateado y la URL del QR', async () => {
      const bottled = await call(
        'post',
        'owner',
        `/v1/lots/${lotId}/bottling`,
        SINGANI_BOTTLING,
      ).expect(201);
      lotCode = bottled.body.data.lotCode as string;
      units = await prisma.bottleUnit.findMany({
        where: { lotId },
        orderBy: { serial: 'asc' },
        select: { code: true, serial: true },
      });
      expect(units).toHaveLength(2950);

      const first = await checked(
        'get',
        'owner',
        `/v1/lots/${lotId}/bottle-codes?limit=50`,
        200,
      );
      expect(first.body.data).toMatchObject({
        total: 2950,
        limit: 50,
        offset: 0,
      });
      const items = first.body.data.items as Unit[];
      expect(items.map((u) => u.serial)).toEqual(
        Array.from({ length: 50 }, (_, i) => i + 1),
      );
      expect(items[0]).toMatchObject({
        code: units[0].code,
        codeFormatted: formatBottleCode(units[0].code),
        serial: 1,
        lotId,
        lotCode,
        status: 'ACTIVE',
        qrUrl: `${PASSPORT}/b/${units[0].code}`,
        voided: null,
        replaces: null,
        exportsCount: 0,
        firstExportedAt: null,
      });
      expect(items.every((u) => isValidBottleCode(u.code))).toBe(true);
      // La sal de la hoja Merkle no sale por la API
      expect(JSON.stringify(first.body)).not.toMatch(/salt/i);

      const last = await listCodes(lotId, '?limit=100&offset=2900');
      expect(last).toHaveLength(50);
      expect(last[49].serial).toBe(2950);
    });

    it('filtra por rango y estado; un rango imposible es 422 VALIDATION_ERROR', async () => {
      const range = await checked(
        'get',
        'enologist',
        `/v1/lots/${lotId}/bottle-codes?fromSerial=100&toSerial=104`,
        200,
      );
      expect(range.body.data.total).toBe(5);
      expect((range.body.data.items as Unit[]).map((u) => u.serial)).toEqual([
        100, 101, 102, 103, 104,
      ]);
      const voided = await checked(
        'get',
        'owner',
        `/v1/lots/${lotId}/bottle-codes?status=VOIDED`,
        200,
      );
      expect(voided.body.data.total).toBe(0);
      for (const query of [
        'fromSerial=200&toSerial=100',
        'toSerial=2951',
        'fromSerial=2951',
        'fromSerial=0',
        'status=DELIVERED',
        'limit=101',
      ]) {
        const res = await checked(
          'get',
          'owner',
          `/v1/lots/${lotId}/bottle-codes?${query}`,
          422,
        );
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('busca por un fragmento del código (como se teclea) o por la serie', async () => {
      const target = units[1233];
      const typed = `${target.code.slice(0, 4)}-${target.code.slice(4)}`
        .toLowerCase()
        .replace(/0/g, 'o');
      const exact = await listCodes(lotId, `?q=${encodeURIComponent(typed)}`);
      expect(exact.map((u) => u.code)).toEqual([target.code]);
      const fragment = await listCodes(
        lotId,
        `?q=${target.code.slice(1, 7)}&limit=100`,
      );
      expect(fragment.map((u) => u.code)).toContain(target.code);
      const bySerial = await listCodes(lotId, '?q=1234&limit=100');
      expect(bySerial.map((u) => u.serial)).toContain(1234);
      expect(await listCodes(lotId, `?q=${encodeURIComponent('¿?')}`)).toEqual(
        [],
      );
    });

    it('solo OWNER y ENOLOGIST (y de la plataforma, ADMIN y OPERATIONS); otra bodega → 404', async () => {
      const path = `/v1/lots/${lotId}/bottle-codes`;
      for (const who of ['operator', 'accountant'] as const) {
        const res = await checked('get', who, path, 403);
        expect(res.body.error.code).toBe('AUTH_INSUFFICIENT_PERMISSIONS');
        const csv = await checked('get', who, `${path}/export`, 403);
        expect(csv.body.error.code).toBe('AUTH_INSUFFICIENT_PERMISSIONS');
      }
      const foreign = await checked('get', 'other', path, 404);
      expect(foreign.body.error.code).toBe('TRC_LOT_NOT_FOUND');
      const admin = await checked(
        'get',
        'admin',
        `${path}?wineryId=${w1.id}&limit=1`,
        200,
      );
      expect(admin.body.data.total).toBe(2950);
      const support = await checked(
        'get',
        'support',
        `${path}?wineryId=${w1.id}`,
        403,
      );
      expect(support.body.error.code).toBe('AUTH_INSUFFICIENT_PERMISSIONS');
      // La plataforma no exporta ni anula
      const adminCsv = await checked(
        'get',
        'admin',
        `${path}/export?wineryId=${w1.id}`,
        403,
      );
      expect(adminCsv.body.error.code).toBe('AUTH_INSUFFICIENT_PERMISSIONS');
      const adminZip = await checked(
        'post',
        'admin',
        `${path}/exports?wineryId=${w1.id}`,
        403,
        { format: 'ZIP', qr: { imageFormat: 'SVG' } },
      );
      expect(adminZip.body.error.code).toBe('TRC_PLATFORM_READ_ONLY');
      const adminVoid = await checked(
        'post',
        'admin',
        `/v1/bottle-codes/${units[0].code}/void?wineryId=${w1.id}`,
        403,
        { reason: 'Plataforma' },
      );
      expect(adminVoid.body.error.code).toBe('TRC_PLATFORM_READ_ONLY');
      await expect(
        prisma.bottleCodeExport.count({ where: { lotId } }),
      ).resolves.toBe(0);
    });

    it('CSV de los 2.950 códigos por streaming, registrado en la bitácora con su rango', async () => {
      const started = Date.now();
      const res = await download(
        'owner',
        `/v1/lots/${lotId}/bottle-codes/export?format=csv`,
      );
      expect(Date.now() - started).toBeLessThan(30_000);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(res.headers['content-disposition']).toBe(
        `attachment; filename="codigos-${lotCode}-1-2950.csv"`,
      );
      expect(res.headers['x-export-rows']).toBe('2950');
      const text = res.body.toString('utf8');
      expect(text.startsWith(bottleCsvHeader())).toBe(true);
      const lines = text.split('\r\n');
      expect(lines.pop()).toBe('');
      expect(stripBom(lines[0])).toBe(BOTTLE_CSV_HEADER);
      expect(lines).toHaveLength(2951);
      expect(lines[1]).toBe(
        [
          1,
          units[0].code,
          formatBottleCode(units[0].code),
          `${PASSPORT}/b/${units[0].code}`,
          lotCode,
          'Singani de los códigos',
          'SINGANI',
          daysAgo(2),
        ].join(','),
      );
      expect(lines[2950].split(',').slice(0, 2)).toEqual([
        '2950',
        units[2949].code,
      ]);

      const exportId = res.headers['x-export-id'];
      const row = await prisma.bottleCodeExport.findUniqueOrThrow({
        where: { id: exportId },
      });
      expect(row).toMatchObject({
        lotId,
        format: 'CSV',
        status: 'READY',
        rows: 2950,
        fromSerial: 1,
        toSerial: 2950,
        createdByMembershipId: w1.ownerMembershipId,
      });
      const audit = await prisma.auditEvent.findFirstOrThrow({
        where: { action: 'BOTTLE_CODES_EXPORTED', resourceId: exportId },
      });
      expect(audit.organizationId).toBe(w1.id);
      expect(audit.after).toMatchObject({
        lotId,
        lotCode,
        format: 'CSV',
        fromSerial: 1,
        toSerial: 2950,
        rows: 2950,
      });
      const [unit] = await listCodes(lotId, '?limit=1');
      expect(unit.exportsCount).toBe(1);
      expect(unit.firstExportedAt).not.toBeNull();
    });

    it('CSV por rango: solo esas series, y cuenta otra exportación', async () => {
      const res = await download(
        'enologist',
        `/v1/lots/${lotId}/bottle-codes/export?fromSerial=11&toSerial=20`,
      );
      expect(res.status).toBe(200);
      expect(res.headers['x-export-rows']).toBe('10');
      const lines = res.body.toString('utf8').trimEnd().split('\r\n');
      expect(lines).toHaveLength(11);
      expect(lines.slice(1).map((l) => Number(l.split(',')[0]))).toEqual(
        Array.from({ length: 10 }, (_, i) => i + 11),
      );
      const [exportedTwice] = await listCodes(
        lotId,
        '?fromSerial=11&toSerial=11',
      );
      expect(exportedTwice.exportsCount).toBe(2);
      const [exportedOnce] = await listCodes(
        lotId,
        '?fromSerial=21&toSerial=21',
      );
      expect(exportedOnce.exportsCount).toBe(1);
      const invalid = await checked(
        'get',
        'owner',
        `/v1/lots/${lotId}/bottle-codes/export?fromSerial=20&toSerial=11`,
        422,
      );
      expect(invalid.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('anular: el código deja de estar activo, queda en la línea de tiempo y en la bitácora', async () => {
      const target = units[9];
      const unknown = await checked(
        'post',
        'owner',
        '/v1/bottle-codes/ZZZZZZZZ/void',
        404,
        { reason: 'No existe' },
      );
      expect(unknown.body.error.code).toBe('TRC_BOTTLE_CODE_NOT_FOUND');
      const foreign = await checked(
        'post',
        'other',
        `/v1/bottle-codes/${target.code}/void`,
        404,
        { reason: 'De otra bodega' },
      );
      expect(foreign.body.error.code).toBe('TRC_BOTTLE_CODE_NOT_FOUND');
      const operator = await checked(
        'post',
        'operator',
        `/v1/bottle-codes/${target.code}/void`,
        403,
        { reason: 'Sin permiso' },
      );
      expect(operator.body.error.code).toBe('AUTH_INSUFFICIENT_PERMISSIONS');
      const noReason = await checked(
        'post',
        'owner',
        `/v1/bottle-codes/${target.code}/void`,
        422,
        { reason: 'x' },
      );
      expect(noReason.body.error.code).toBe('VALIDATION_ERROR');

      // Se acepta como se teclea: con guion y en minúsculas
      const typed = formatBottleCode(target.code).toLowerCase();
      const voided = await checked(
        'post',
        'enologist',
        `/v1/bottle-codes/${typed}/void`,
        200,
        { reason: 'Botella rota en la línea' },
      );
      expect(voided.body.data).toMatchObject({
        code: target.code,
        serial: 10,
        status: 'VOIDED',
        voided: {
          reason: 'Botella rota en la línea',
          replacedBy: null,
          by: { role: 'ENOLOGIST' },
        },
      });
      const again = await checked(
        'post',
        'owner',
        `/v1/bottle-codes/${target.code}/void`,
        409,
        { reason: 'Otra vez' },
      );
      expect(again.body.error.code).toBe('TRC_BOTTLE_CODE_ALREADY_VOIDED');

      // Invariante: activos = botellas − bajas sin sustituto
      const lot = await checked('get', 'owner', `/v1/lots/${lotId}`, 200);
      expect(lot.body.data.bottles).toBe(2949);
      const event = await prisma.lotEvent.findFirstOrThrow({
        where: { lotId, type: 'BOTTLE_CODE_VOIDED' },
      });
      expect(event).toMatchObject({ stage: 'BOTTLED', visibility: 'INTERNAL' });
      expect(event.data).toMatchObject({ serial: 10, replaced: false });
      // El código no viaja en la línea de tiempo (la ven roles que solo ven totales)
      expect(JSON.stringify(event)).not.toContain(target.code);
      const audit = await prisma.auditEvent.findFirstOrThrow({
        where: { action: 'BOTTLE_CODE_VOIDED', resourceId: target.code },
      });
      expect(audit).toMatchObject({
        organizationId: w1.id,
        reason: 'Botella rota en la línea',
      });
      expect(audit.after).toMatchObject({ fromSerial: 10, toSerial: 10 });
    });

    it('sustituir: código nuevo con la misma serie; el CSV lleva el sustituto y no los anulados', async () => {
      const target = units[19];
      const key = '0b0e7a52-1f0c-4a55-9f0e-3a0d5a1e2b20';
      const replaced = await checked(
        'post',
        'owner',
        `/v1/bottle-codes/${target.code}/void`,
        200,
        { reason: 'Etiqueta dañada', replace: true },
        { 'Idempotency-Key': key },
      );
      const replacement = replaced.body.data.voided.replacedBy as string;
      expect(isValidBottleCode(replacement)).toBe(true);
      expect(replacement).not.toBe(target.code);
      // Un reintento con la misma clave no emite otro código
      const replay = await checked(
        'post',
        'owner',
        `/v1/bottle-codes/${target.code}/void`,
        200,
        { reason: 'Etiqueta dañada', replace: true },
        { 'Idempotency-Key': key },
      );
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body.data.voided.replacedBy).toBe(replacement);

      const pair = await listCodes(lotId, '?fromSerial=20&toSerial=20');
      expect(pair).toHaveLength(2);
      expect(pair[0]).toMatchObject({
        code: target.code,
        status: 'VOIDED',
        voided: { replacedBy: replacement },
      });
      expect(pair[1]).toMatchObject({
        code: replacement,
        serial: 20,
        status: 'ACTIVE',
        replaces: target.code,
        exportsCount: 0,
      });
      const active = await checked(
        'get',
        'owner',
        `/v1/lots/${lotId}/bottle-codes?status=ACTIVE&limit=1`,
        200,
      );
      expect(active.body.data.total).toBe(2949);
      const voidedList = await listCodes(lotId, '?status=VOIDED');
      expect(voidedList.map((u) => u.serial)).toEqual([10, 20]);

      const csv = await download(
        'owner',
        `/v1/lots/${lotId}/bottle-codes/export?fromSerial=9&toSerial=21`,
      );
      expect(csv.headers['x-export-rows']).toBe('12');
      const rows = csv.body
        .toString('utf8')
        .trimEnd()
        .split('\r\n')
        .slice(1)
        .map((l) => l.split(','));
      expect(rows.map((r) => Number(r[0]))).toEqual([
        9, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
      ]);
      expect(rows.find((r) => r[0] === '20')?.[1]).toBe(replacement);
      const none = await checked(
        'get',
        'owner',
        `/v1/lots/${lotId}/bottle-codes/export?fromSerial=10&toSerial=10`,
        422,
      );
      expect(details(none)[0].message).toMatch(/No hay códigos activos/);
    });

    it('ZIP para la imprenta: 202, lo genera la tarea del worker y se descarga con URL firmada', async () => {
      const invalid = await checked(
        'post',
        'owner',
        `/v1/lots/${lotId}/bottle-codes/exports`,
        422,
        {
          format: 'ZIP',
          fromSerial: 30,
          toSerial: 20,
          qr: { imageFormat: 'SVG' },
        },
      );
      expect(invalid.body.error.code).toBe('VALIDATION_ERROR');
      const noQr = await checked(
        'post',
        'owner',
        `/v1/lots/${lotId}/bottle-codes/exports`,
        422,
        { format: 'ZIP' },
      );
      expect(noQr.body.error.code).toBe('VALIDATION_ERROR');

      const accepted = await checked(
        'post',
        'enologist',
        `/v1/lots/${lotId}/bottle-codes/exports`,
        202,
        {
          format: 'ZIP',
          fromSerial: 1,
          toSerial: 40,
          qr: { imageFormat: 'SVG', sizePx: 256, margin: 2 },
        },
      );
      expect(accepted.body.data.status).toBe('PENDING');
      const exportId = accepted.body.data.exportId as string;
      const path = `/v1/lots/${lotId}/bottle-codes/exports/${exportId}`;

      // La tarea viaja por el outbox, en la misma transacción
      const event = await prisma.outboxEvent.findFirstOrThrow({
        where: { aggregateId: exportId },
      });
      expect(event).toMatchObject({
        eventType: 'trace.bottle-codes.export',
        queue: 'default',
        status: 'PENDING',
      });
      expect(event.payload).toMatchObject({
        exportId,
        lotId,
        wineryId: w1.id,
      });
      const pending = await checked('get', 'owner', path, 200);
      expect(pending.body.data).toMatchObject({
        exportId,
        status: 'PENDING',
        format: 'ZIP',
        fromSerial: 1,
        toSerial: 40,
        rows: 39, // la serie 10 está anulada sin sustituto
        downloadUrl: null,
        createdBy: { role: 'ENOLOGIST' },
      });
      expect(
        new Date(pending.body.data.expiresAt as string).getTime() -
          new Date(pending.body.data.createdAt as string).getTime(),
      ).toBe(7 * 86_400_000);

      // Lo que hace el worker con `trace.bottle-codes.export`
      const builder = app.get(BottleCodeExportBuilder);
      const built = await builder.build(exportId);
      expect(built).toMatchObject({ status: 'READY', rows: 39 });
      await expect(builder.build(exportId)).resolves.toMatchObject({
        status: 'SKIPPED',
      });

      const ready = await checked('get', 'owner', path, 200);
      expect(ready.body.data.status).toBe('READY');
      const url = new URL(ready.body.data.downloadUrl as string);
      const file = await download(null, `${url.pathname}${url.search}`);
      expect(file.status).toBe(200);
      expect(file.headers['content-type']).toBe('application/zip');
      expect(file.headers['content-disposition']).toBe('attachment');

      const entries = readZipEntries(file.body);
      expect(entries.size).toBe(40);
      const csv = entries.get('codigos.csv')!.toString('utf8');
      const lines = csv.trimEnd().split('\r\n');
      expect(stripBom(lines[0])).toBe(BOTTLE_CSV_HEADER);
      expect(lines).toHaveLength(40);
      const active = await prisma.bottleUnit.findMany({
        where: { lotId, status: 'ACTIVE', serial: { lte: 40 } },
        orderBy: { serial: 'asc' },
      });
      expect([...entries.keys()].filter((n) => n !== 'codigos.csv')).toEqual(
        active.map((u) => `qr/${u.serial}-${u.code}.svg`),
      );
      const svg = entries
        .get(`qr/${active[0].serial}-${active[0].code}.svg`)!
        .toString('utf8');
      expect(svg).toContain('<svg');
      expect(svg).toContain('width="256"');
      // El ZIP no se firma por la ruta general de archivos
      const key = (
        await prisma.bottleCodeExport.findUniqueOrThrow({
          where: { id: exportId },
        })
      ).storageKey as string;
      expect(key).toBe(`exports/bottle-codes/${w1.id}/${exportId}.zip`);
      await call(
        'get',
        'operator',
        `/v1/uploads/url?key=${encodeURIComponent(key)}`,
      ).expect(404);

      // Otra bodega, otro lote o la plataforma no la ven
      await checked('get', 'other', path, 404);
      const wrongLot = await restingLot('owner', w1, 'Otro lote');
      const missing = await checked(
        'get',
        'owner',
        `/v1/lots/${wrongLot.lotId}/bottle-codes/exports/${exportId}`,
        404,
      );
      expect(missing.body.error.code).toBe('NOT_FOUND');
      await checked('get', 'admin', `${path}?wineryId=${w1.id}`, 403);

      const audit = await prisma.auditEvent.findFirstOrThrow({
        where: { action: 'BOTTLE_CODES_EXPORTED', resourceId: exportId },
      });
      expect(audit.after).toMatchObject({
        format: 'ZIP',
        fromSerial: 1,
        toSerial: 40,
        rows: 39,
      });
    });

    it('ZIP con QR en PNG y caducidad a los 7 días', async () => {
      const accepted = await checked(
        'post',
        'owner',
        `/v1/lots/${lotId}/bottle-codes/exports`,
        202,
        { format: 'ZIP', fromSerial: 2941, qr: { imageFormat: 'PNG' } },
      );
      const exportId = accepted.body.data.exportId as string;
      const builder = app.get(BottleCodeExportBuilder);
      await builder.build(exportId);
      const row = await prisma.bottleCodeExport.findUniqueOrThrow({
        where: { id: exportId },
      });
      const storageKey = row.storageKey as string;
      await expect(storage.exists(storageKey)).resolves.toBe(true);
      const ready = await checked(
        'get',
        'owner',
        `/v1/lots/${lotId}/bottle-codes/exports/${exportId}`,
        200,
      );
      const url = new URL(ready.body.data.downloadUrl as string);
      const file = await download(null, `${url.pathname}${url.search}`);
      const entries = readZipEntries(file.body);
      expect(entries.size).toBe(11);
      const png = [...entries.entries()].find(([n]) => n.endsWith('.png'))!;
      expect(png[0]).toMatch(/^qr\/29\d\d-[0-9A-Z]{8}\.png$/);
      expect(png[1].subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(png[1].readUInt32BE(16)).toBe(512);

      // Caducada: sin URL de descarga y la limpieza borra el archivo
      await prisma.bottleCodeExport.update({
        where: { id: exportId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const expired = await checked(
        'get',
        'owner',
        `/v1/lots/${lotId}/bottle-codes/exports/${exportId}`,
        200,
      );
      expect(expired.body.data).toMatchObject({
        status: 'READY',
        downloadUrl: null,
      });
      await expect(builder.removeExpired()).resolves.toBe(1);
      await expect(storage.exists(storageKey)).resolves.toBe(false);
      await expect(builder.removeExpired()).resolves.toBe(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('expediente del lote (§10)', () => {
    let lotId: string;
    let lotCode: string;
    let hash: string;
    let merkle: string;
    /** Códigos anulados antes del cierre (no entran en la raíz) y el sustituto. */
    let voidedBefore: string;
    let replacedBefore: string;
    let replacement: string;

    beforeAll(async () => {
      ({ lotId } = await restingLot('owner', w1, 'Singani del expediente'));
    });

    it('sin embotellar: faltan requisitos y no se puede cerrar (un detalle por requisito)', async () => {
      const preview = await checked(
        'get',
        'operator',
        `/v1/lots/${lotId}/dossier/preview`,
        200,
      );
      expect(preview.body.data).toMatchObject({
        ready: false,
        hashPreview: null,
      });
      const met = Object.fromEntries(
        (preview.body.data.requirements as { key: string; met: boolean }[]).map(
          (r) => [r.key, r.met],
        ),
      );
      expect(met).toEqual({
        BOTTLED: false,
        LAB_CONFORMING: false,
        BOTTLE_CODES_READY: false,
        NO_OPEN_COMPLIANCE_ISSUES: true,
        NO_OPEN_SOURCES: false,
      });
      const close = await checked(
        'post',
        'owner',
        `/v1/lots/${lotId}/dossier/close`,
        422,
        { confirm: true },
      );
      expect(close.body.error.code).toBe('TRC_DOSSIER_NOT_READY');
      expect(details(close).map((d) => d.meta?.requirement)).toEqual([
        'BOTTLED',
        'LAB_CONFORMING',
        'BOTTLE_CODES_READY',
        'NO_OPEN_SOURCES',
      ]);
      expect(codes(close).every((c) => c === 'TRC_DOSSIER_NOT_READY')).toBe(
        true,
      );
      const open = await checked(
        'get',
        'accountant',
        `/v1/lots/${lotId}/dossier`,
        200,
      );
      expect(open.body.data).toEqual({
        lotId,
        schema: 'doc-dossier/1',
        status: 'OPEN',
        hash: null,
        algorithm: 'sha256/jcs-rfc8785',
        closedAt: null,
        closedBy: null,
        bottleCodes: null,
        anchor: null,
      });
    });

    it('con laboratorio ausente o incompleto: TRC_DOSSIER_NOT_READY (§18)', async () => {
      const bottled = await call(
        'post',
        'owner',
        `/v1/lots/${lotId}/bottling`,
        SINGANI_BOTTLING,
      ).expect(201);
      lotCode = bottled.body.data.lotCode as string;

      const noLab = await checked(
        'post',
        'owner',
        `/v1/lots/${lotId}/dossier/close`,
        422,
        { confirm: true },
      );
      expect(noLab.body.error.code).toBe('TRC_DOSSIER_NOT_READY');
      expect(details(noLab)).toHaveLength(1);
      expect(details(noLab)[0].meta).toEqual({
        requirement: 'LAB_CONFORMING',
        labStatus: 'NOT_RECORDED',
      });

      // Sin metanol (exigido en singani): incompleto, nunca conforme por omisión
      const incomplete = await labAnalysis(lotId, {
        methanolContentMgL: undefined,
      });
      expect(incomplete.status).toBe(201);
      const stillNot = await checked(
        'post',
        'enologist',
        `/v1/lots/${lotId}/dossier/close`,
        422,
        { confirm: true },
      );
      expect(details(stillNot)[0].meta).toEqual({
        requirement: 'LAB_CONFORMING',
        labStatus: 'INCOMPLETE',
      });
      const lot = await checked('get', 'owner', `/v1/lots/${lotId}`, 200);
      expect(lot.body.data).toMatchObject({
        stage: 'BOTTLED',
        dossierStatus: 'OPEN',
      });
    });

    it('una incidencia de cumplimiento abierta bloquea el cierre', async () => {
      expect((await labAnalysis(lotId)).status).toBe(201);
      const issue = await prisma.lotComplianceIssue.create({
        data: {
          lotId,
          code: 'TRC_VOLUME_MISSING',
          message: 'Incidencia de prueba',
          source: 'CORRECTION',
        },
      });
      const blocked = await checked(
        'post',
        'owner',
        `/v1/lots/${lotId}/dossier/close`,
        422,
        { confirm: true },
      );
      expect(details(blocked)[0].meta).toEqual({
        requirement: 'NO_OPEN_COMPLIANCE_ISSUES',
        issueIds: [issue.id],
      });
      await prisma.lotComplianceIssue.update({
        where: { id: issue.id },
        data: { resolvedAt: new Date() },
      });
    });

    it('las bajas anteriores al cierre no impiden cerrar (una sin sustituto y una sustituida)', async () => {
      const [three, four] = await prisma.bottleUnit.findMany({
        where: { lotId, serial: { in: [3, 4] } },
        orderBy: { serial: 'asc' },
      });
      voidedBefore = three.code;
      replacedBefore = four.code;
      await checked(
        'post',
        'owner',
        `/v1/bottle-codes/${three.code}/void`,
        200,
        {
          reason: 'Botella rota al etiquetar',
        },
      );
      const replaced = await checked(
        'post',
        'owner',
        `/v1/bottle-codes/${four.code}/void`,
        200,
        { reason: 'Etiqueta dañada', replace: true },
      );
      replacement = replaced.body.data.voided.replacedBy as string;
      // Sin expediente cerrado todavía no hay prueba Merkle
      await expect(
        bottleMerkleProof(prisma, lotId, replacement),
      ).resolves.toBeNull();
    });

    it('listo: la vista previa da una huella estable, que es la del contenido canónico', async () => {
      const preview = await checked(
        'get',
        'owner',
        `/v1/lots/${lotId}/dossier/preview`,
        200,
      );
      expect(preview.body.data.ready).toBe(true);
      expect(
        (preview.body.data.requirements as { met: boolean }[]).every(
          (r) => r.met,
        ),
      ).toBe(true);
      const hashPreview = preview.body.data.hashPreview as string;
      expect(hashPreview).toMatch(/^[0-9a-f]{64}$/);
      const again = await checked(
        'get',
        'enologist',
        `/v1/lots/${lotId}/dossier/preview`,
        200,
      );
      expect(again.body.data.hashPreview).toBe(hashPreview);

      const canonical = await download(
        'operator',
        `/v1/lots/${lotId}/dossier/canonical`,
      );
      expect(canonical.status).toBe(200);
      expect(canonical.headers['content-type']).toBe(
        'application/json; charset=utf-8',
      );
      expect(canonical.headers['x-dossier-status']).toBe('OPEN');
      expect(sha256(canonical.body)).toBe(hashPreview);
      expect(canonical.headers['x-dossier-hash']).toBe(hashPreview);
      expect(JSON.parse(canonical.body.toString('utf8'))).toMatchObject({
        schema: 'doc-dossier/1',
        closedAt: null,
        closedBy: null,
      });
    });

    it('cerrar exige confirmación y permiso; la plataforma solo lee', async () => {
      for (const body of [{}, { confirm: false }, { confirm: 'true' }]) {
        const res = await checked(
          'post',
          'owner',
          `/v1/lots/${lotId}/dossier/close`,
          422,
          body,
        );
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
      const operator = await call(
        'post',
        'operator',
        `/v1/lots/${lotId}/dossier/close`,
        { confirm: true },
      );
      expect(operator.status).toBe(403);
      const platform = await checked(
        'post',
        'admin',
        `/v1/lots/${lotId}/dossier/close?wineryId=${w1.id}`,
        403,
        { confirm: true },
      );
      expect(platform.body.error.code).toBe('TRC_PLATFORM_READ_ONLY');
      const foreign = await checked(
        'post',
        'other',
        `/v1/lots/${lotId}/dossier/close`,
        404,
        { confirm: true },
      );
      expect(foreign.body.error.code).toBe('TRC_LOT_NOT_FOUND');
      // La plataforma sí lee el expediente
      await checked(
        'get',
        'support',
        `/v1/lots/${lotId}/dossier/preview?wineryId=${w1.id}`,
        200,
      );
    });

    it('cierra: huella SHA-256, raíz Merkle, lote CERTIFIED, evento, bitácora y lot.certified', async () => {
      const [first, second] = await Promise.all([
        call('post', 'owner', `/v1/lots/${lotId}/dossier/close`, {
          confirm: true,
        }),
        call('post', 'enologist', `/v1/lots/${lotId}/dossier/close`, {
          confirm: true,
        }),
      ]);
      // Dos cierres a la vez: uno cierra y el otro encuentra el expediente cerrado
      expect([first.status, second.status].sort()).toEqual([200, 409]);
      const closed = first.status === 200 ? first : second;
      const rejected = first.status === 200 ? second : first;
      openapi.expectResponse('post', `/v1/lots/${lotId}/dossier/close`, closed);
      openapi.expectResponse(
        'post',
        `/v1/lots/${lotId}/dossier/close`,
        rejected,
      );
      expect(rejected.body.error.code).toBe('TRC_DOSSIER_CLOSED');

      hash = closed.body.data.hash as string;
      merkle = closed.body.data.bottleCodes.merkleRoot as string;
      expect(closed.body.data).toMatchObject({
        lotId,
        schema: 'doc-dossier/1',
        status: 'CLOSED',
        algorithm: 'sha256/jcs-rfc8785',
        bottleCodes: {
          count: 2949,
          algorithm: 'sha256-merkle/serial-code-salt',
        },
        anchor: null,
      });
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(merkle).toMatch(/^[0-9a-f]{64}$/);
      expect(['OWNER', 'ENOLOGIST']).toContain(closed.body.data.closedBy.role);

      const lot = await checked('get', 'owner', `/v1/lots/${lotId}`, 200);
      expect(lot.body.data).toMatchObject({
        stage: 'CERTIFIED',
        dossierStatus: 'CLOSED',
      });
      const events = await prisma.lotEvent.findMany({
        where: { lotId, type: 'DOSSIER_CLOSED' },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        stage: 'CERTIFIED',
        visibility: 'PUBLIC',
      });
      expect(events[0].data).toMatchObject({ hash, bottleMerkleRoot: merkle });
      const audit = await prisma.auditEvent.findMany({
        where: { action: 'DOSSIER_CLOSED', resourceId: lotId },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0].after).toMatchObject({
        hash,
        lotCode,
        bottleCount: 2949,
        stage: 'CERTIFIED',
      });
      const outbox = await prisma.outboxEvent.findMany({
        where: { eventType: 'lot.certified', aggregateId: lotId },
      });
      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toMatchObject({ queue: 'chain', aggregateType: 'lot' });
      expect(outbox[0].payload).toMatchObject({
        lotId,
        wineryId: w1.id,
        lotCode,
        hash,
        bottleMerkleRoot: merkle,
        bottleCount: 2949,
      });
    });

    it('el JSON canónico descargado son los bytes exactos que se hashearon', async () => {
      const file = await download(
        'accountant',
        `/v1/lots/${lotId}/dossier/canonical`,
      );
      expect(file.status).toBe(200);
      expect(file.headers['x-dossier-status']).toBe('CLOSED');
      expect(file.headers['x-dossier-hash']).toBe(hash);
      expect(file.headers['content-disposition']).toBe(
        `attachment; filename="expediente-${lotCode}.json"`,
      );
      // Cualquiera puede recalcular la huella
      expect(sha256(file.body)).toBe(hash);
      const text = file.body.toString('utf8');
      const doc = JSON.parse(text) as {
        closedAt: string;
        harvests: unknown[];
        distillations: unknown[];
        labAnalyses: Record<string, unknown>[];
      };
      // …y comprobar que el texto es canónico (RFC 8785)
      expect(canonicalize(doc)).toBe(text);

      const dossier = await checked(
        'get',
        'operator',
        `/v1/lots/${lotId}/dossier`,
        200,
      );
      expect(dossier.body.data).toMatchObject({ status: 'CLOSED', hash });
      expect(doc).toMatchObject({
        schema: 'doc-dossier/1',
        closedAt: dossier.body.data.closedAt,
        closedBy: { membershipId: dossier.body.data.closedBy.membershipId },
        winery: { id: w1.id },
        lot: {
          id: lotId,
          lotCode,
          name: 'Singani del expediente',
          productType: 'SINGANI',
          harvestYear: VINTAGE,
          bottledAt: daysAgo(2),
        },
        rules: {
          origin: 'LOT_CREATION',
          singani: { minRestDays: 180, minAltitudeMasl: 1600 },
        },
        bottling: {
          lotCode,
          totalBottlesPackaged: 2950,
          finalAlcoholAbv: '40.00',
          waterDilutionLiters: '750.000',
          balance: {
            availableLiters: '1500.000',
            bottledLiters: '2212.500',
            lossPercent: '1.67',
            pureAlcohol: {
              availableLiters: '900.000',
              bottledLiters: '885.000',
            },
          },
        },
        bottleCodes: {
          count: 2949,
          merkleRoot: merkle,
          algorithm: 'sha256-merkle/serial-code-salt',
        },
      });
      expect(doc.harvests[0]).toMatchObject({
        netWeightKg: '18400.000',
        terroir: { parcelName: 'Los Parrales', altitudeMasl: '1850.00' },
        recordedBy: { membershipId: w1.ownerMembershipId, role: 'OWNER' },
      });
      expect(doc.distillations[0]).toMatchObject({
        heartLiters: '1500.000',
        heartAbvPercent: '60.00',
        status: 'BOTTLED',
      });
      // Dos análisis: el incompleto (sustituido) y el conforme (vigente)
      expect(
        doc.labAnalyses.map((l) => [l.conformityStatus, l.current]),
      ).toEqual([
        ['INCOMPLETE', false],
        ['CONFORMING', true],
      ]);

      // Sin nombres, correos, URL ni códigos de botella en claro
      const units = await prisma.bottleUnit.findMany({
        where: { lotId, status: 'ACTIVE' },
        orderBy: { serial: 'asc' },
        select: { serial: true, code: true, salt: true },
      });
      expect(text).not.toMatch(/o2b\.test|Persona |Dueña |https?:\/\//);
      expect(text).not.toContain(units[0].code);
      expect(text).not.toContain(units[0].salt);

      // La raíz se recalcula con las hojas SHA-256("{serie}:{código}:{sal}") por serie,
      // y cada botella puede probar que está en ella (lo que publica su pasaporte)
      const leaves = units.map((u) => bottleLeafHash(u.serial, u.code, u.salt));
      expect(merkleRoot(leaves)).toBe(merkle);
      const index = 1233;
      expect(
        verifyMerkleProof(leaves[index], merkleProof(leaves, index), merkle),
      ).toBe(true);
      expect(leaves[index]).toBe(
        sha256(
          `${units[index].serial}:${units[index].code}:${units[index].salt}`,
        ),
      );

      // La prueba de cada botella sale de `bottleMerkleProof`: el sustituto
      // está en la raíz; lo anulado antes del cierre, no
      const proof = await bottleMerkleProof(prisma, lotId, replacement);
      expect(proof?.merkleRoot).toBe(merkle);
      const replacementUnit = units.find((u) => u.code === replacement)!;
      expect(replacementUnit.serial).toBe(4);
      expect(proof?.salt).toBe(replacementUnit.salt);
      expect(
        verifyMerkleProof(
          bottleLeafHash(4, replacement, proof!.salt),
          proof!.path,
          merkle,
        ),
      ).toBe(true);
      await expect(
        bottleMerkleProof(prisma, lotId, voidedBefore),
      ).resolves.toBeNull();
      await expect(
        bottleMerkleProof(prisma, lotId, replacedBefore),
      ).resolves.toBeNull();

      // Lo que lee el pasaporte público (bloque C) está en `lot_dossiers`
      const row = await prisma.lotDossier.findUniqueOrThrow({
        where: { lotId },
      });
      expect(row).toMatchObject({
        schema: 'doc-dossier/1',
        status: 'CLOSED',
        hash,
        canonical: text,
        bottleCount: 2949,
        bottleMerkleRoot: merkle,
      });
      expect(row.closedAt?.toISOString()).toBe(doc.closedAt);
    });

    it('tras el cierre: TRC_DOSSIER_CLOSED al cerrar otra vez o sustituir un código; anular sí se puede (S-14)', async () => {
      const again = await checked(
        'post',
        'owner',
        `/v1/lots/${lotId}/dossier/close`,
        409,
        { confirm: true },
      );
      expect(again.body.error.code).toBe('TRC_DOSSIER_CLOSED');
      expect(details(again)[0].meta).toMatchObject({ hash });
      expect(details(again)[0].meta?.closedAt).toEqual(expect.any(String));

      const [one, two] = await prisma.bottleUnit.findMany({
        where: { lotId, serial: { in: [5, 6] } },
        orderBy: { serial: 'asc' },
      });
      const replace = await checked(
        'post',
        'owner',
        `/v1/bottle-codes/${one.code}/void`,
        409,
        { reason: 'Etiqueta dañada', replace: true },
      );
      expect(replace.body.error.code).toBe('TRC_DOSSIER_CLOSED');
      expect(details(replace)[0]).toMatchObject({ field: 'replace' });
      const voided = await checked(
        'post',
        'owner',
        `/v1/bottle-codes/${two.code}/void`,
        200,
        { reason: 'Botella rota en el almacén' },
      );
      expect(voided.body.data).toMatchObject({
        status: 'VOIDED',
        voided: { replacedBy: null },
      });
      // La última baja (las dos anteriores son de antes del cierre)
      const event = await prisma.lotEvent.findFirstOrThrow({
        where: { lotId, type: 'BOTTLE_CODE_VOIDED' },
        orderBy: { seq: 'desc' },
      });
      expect(event.stage).toBe('CERTIFIED');
      expect(event.data).toMatchObject({ serial: 6, replaced: false });

      // El expediente no cambia: la huella y la raíz quedaron fijadas
      const dossier = await checked(
        'get',
        'owner',
        `/v1/lots/${lotId}/dossier`,
        200,
      );
      expect(dossier.body.data).toMatchObject({
        hash,
        bottleCodes: { count: 2949, merkleRoot: merkle },
      });
      // El código anulado tras el cierre sigue en la raíz y puede probarlo
      const leaves = await closedDossierLeaves(prisma, lotId);
      expect(leaves?.units).toHaveLength(2949);
      const proof = await bottleMerkleProof(prisma, lotId, two.code);
      expect(
        verifyMerkleProof(
          bottleLeafHash(two.serial, two.code, two.salt),
          proof!.path,
          merkle,
        ),
      ).toBe(true);
      const file = await download(
        'owner',
        `/v1/lots/${lotId}/dossier/canonical`,
      );
      expect(sha256(file.body)).toBe(hash);
      const preview = await checked(
        'get',
        'owner',
        `/v1/lots/${lotId}/dossier/preview`,
        200,
      );
      expect(preview.body.data.hashPreview).toBe(hash);

      // Los códigos se siguen pudiendo listar y exportar (reimpresión)
      const csv = await download(
        'owner',
        `/v1/lots/${lotId}/bottle-codes/export?fromSerial=1&toSerial=10`,
      );
      // Series 1–10 menos la 3 (anulada antes) y la 6 (anulada ahora)
      expect(csv.headers['x-export-rows']).toBe('8');

      // El resto del lote es terminal
      const patch = await checked('patch', 'owner', `/v1/lots/${lotId}`, 409, {
        name: 'Otro nombre',
      });
      expect(patch.body.error.code).toBe('TRC_LOT_TERMINAL');
      const discard = await checked(
        'post',
        'owner',
        `/v1/lots/${lotId}/discard`,
        409,
        { reason: 'Ya certificado' },
      );
      expect(discard.body.error.code).toBe('TRC_LOT_TERMINAL');
      const rebottle = await call(
        'post',
        'owner',
        `/v1/lots/${lotId}/bottling`,
        SINGANI_BOTTLING,
      );
      expect(rebottle.status).toBe(409);
    });

    it('un lote descartado no se certifica', async () => {
      const { lotId: discarded } = await restingLot('owner', w1, 'Descartado');
      await call('post', 'owner', `/v1/lots/${discarded}/discard`, {
        reason: 'Prueba e2e del expediente',
      }).expect(200);
      const res = await checked(
        'post',
        'owner',
        `/v1/lots/${discarded}/dossier/close`,
        409,
        { confirm: true },
      );
      expect(res.body.error.code).toBe('TRC_LOT_TERMINAL');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('rendimiento con 5.000 botellas', () => {
    let lotId: string;

    it('embotella y genera 5.000 códigos únicos en una transacción', async () => {
      ({ lotId } = await restingLot('owner', w1, 'Lote grande e2e', {
        heartLiters: 2500,
      }));
      const started = Date.now();
      const bottled = await call(
        'post',
        'owner',
        `/v1/lots/${lotId}/bottling`,
        {
          bottlingDate: daysAgo(2),
          packagingFormatCl: 75,
          totalBottlesPackaged: 5000,
          finalAlcoholAbv: 40,
          waterDilutionLiters: 1250,
        },
      );
      const elapsed = Date.now() - started;
      expect(bottled.status).toBe(201);
      expect(bottled.body.data.bottleCodes).toMatchObject({
        total: 5000,
        active: 5000,
        firstSerial: 1,
        lastSerial: 5000,
      });
      expect(elapsed).toBeLessThan(90_000);
      const units = await prisma.bottleUnit.findMany({
        where: { lotId },
        select: { code: true, serial: true },
      });
      expect(new Set(units.map((u) => u.code)).size).toBe(5000);
      expect(new Set(units.map((u) => u.serial)).size).toBe(5000);
      expect(bottled.body.data.id).toEqual(expect.any(String));
      expect((await labAnalysis(lotId)).status).toBe(201);
    });

    it('exporta los 5.000 por CSV y por ZIP (SVG) sin agotar el tiempo', async () => {
      let started = Date.now();
      const csv = await download(
        'owner',
        `/v1/lots/${lotId}/bottle-codes/export`,
      );
      expect(csv.status).toBe(200);
      expect(csv.body.toString('utf8').trimEnd().split('\r\n')).toHaveLength(
        5001,
      );
      expect(Date.now() - started).toBeLessThan(60_000);

      const accepted = await checked(
        'post',
        'owner',
        `/v1/lots/${lotId}/bottle-codes/exports`,
        202,
        { format: 'ZIP', qr: { imageFormat: 'SVG' } },
      );
      started = Date.now();
      const built = await app
        .get(BottleCodeExportBuilder)
        .build(accepted.body.data.exportId as string);
      expect(built).toMatchObject({ status: 'READY', rows: 5000 });
      expect(Date.now() - started).toBeLessThan(200_000);
      if (built.status === 'READY') {
        // ~1 KB por QR comprimido
        expect(built.bytes).toBeLessThan(15 * 1024 * 1024);
      }
    }, 300_000);

    it('cierra el expediente con la raíz Merkle de 5.000 códigos', async () => {
      const started = Date.now();
      const closed = await checked(
        'post',
        'owner',
        `/v1/lots/${lotId}/dossier/close`,
        200,
        { confirm: true },
      );
      expect(Date.now() - started).toBeLessThan(60_000);
      expect(closed.body.data.bottleCodes.count).toBe(5000);
      const file = await download(
        'owner',
        `/v1/lots/${lotId}/dossier/canonical`,
      );
      expect(sha256(file.body)).toBe(closed.body.data.hash);
    });
  });

  it('las respuestas se validaron contra el contrato', () => {
    const covered = [...openapi.covered];
    for (const operation of [
      'GET /v1/lots/{id}/bottle-codes 200',
      'POST /v1/lots/{id}/bottle-codes/exports 202',
      'GET /v1/lots/{id}/bottle-codes/exports/{exportId} 200',
      'POST /v1/bottle-codes/{code}/void 200',
      'POST /v1/bottle-codes/{code}/void 409',
      'GET /v1/lots/{id}/dossier/preview 200',
      'POST /v1/lots/{id}/dossier/close 200',
      'POST /v1/lots/{id}/dossier/close 409',
      'POST /v1/lots/{id}/dossier/close 422',
      'GET /v1/lots/{id}/dossier 200',
      'POST /v1/lots/{id}/bottling 201',
      'POST /v1/lots/{id}/bottling/preview 200',
    ]) {
      expect(covered).toContain(operation);
    }
  });
});
