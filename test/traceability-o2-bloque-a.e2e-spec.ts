import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MembershipRoleEnum, PrismaClient } from '@prisma/client';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { loadMockFixtures } from '../src/seed/fixtures';
import { mockId } from '../src/seed/ids';
import { runSeed } from '../src/seed/run-seed';
import { PLATFORM_ORGANIZATION_ID } from '../src/modules/organizations/organization.constants';
import { TraceLocksReleaseTask } from '../src/modules/lots/jobs/locks-release.task';
import { AuditService } from '../src/shared/audit/audit.service';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { staffToken } from './helpers/staff-session';
import { createPlatformUser } from './helpers/identity';
import { loadOpenApiValidator } from './helpers/openapi-validator';
import { sha256Of } from './helpers/trace-files';

/**
 * Ola 2 · pasos 2.3, 2.4 y 2.7 (O2-BE-1, bloque A) sobre la semilla de
 * demostración en un esquema propio: transiciones del tanque y bifurcación,
 * cierre de la destilación con cortes y balance de masa, descartes, candados
 * con la instantánea y la tarea diaria `trace.locks.release`, laboratorio del
 * lote y correcciones compensatorias (incidencias `CORRECTION` y
 * reevaluación). Incluye las pruebas de elusión de §18 de estos pasos, con
 * las respuestas validadas contra `openapi.json`.
 */
process.env.TRUST_PROXY = '1';
// Cada caso recorre muchas llamadas con su transacción y su bitácora
jest.setTimeout(240_000);

const run = `${Date.now()}${randomBytes(3).toString('hex')}`;
const schema = `o2a_e2e_${run}`;
const originalUrl = process.env.DATABASE_URL;

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
/**
 * Día de calendario de hace `n` días **en La Paz** (no en UTC): así los días
 * que faltan para un candado son exactos a cualquier hora, también entre las
 * 00:00 y las 04:00 UTC, cuando La Paz sigue en el día anterior.
 */
function daysAgo(n: number): string {
  return plusDays(laPazToday(), -n);
}
function daysAhead(n: number): string {
  return daysAgo(-n);
}
/** `ymd` + `days` (para comprobar fechas de desbloqueo). */
function plusDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const CINTI = mockId('winery:cintiviejo');
const ALTOS = mockId('winery:altos');
const PDF = Buffer.from('%PDF-1.4 informe de laboratorio de prueba');

type Res = request.Response;
type Method = 'get' | 'post' | 'patch';
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
const codes = (res: Res): string[] => details(res).map((d) => d.code as string);

describe('Ola 2 · bloque A: vinificación, crianza y destilación, laboratorio y correcciones (e2e)', () => {
  const openapi = loadOpenApiValidator();
  let prisma: PrismaClient;
  let app: INestApplication;
  let ipSeq = 1;
  const nextIp = () =>
    `10.232.${Math.floor(Math.random() * 200)}.${(ipSeq++ % 250) + 1}`;
  const tokens = {
    cinti: '',
    cintiAgronomist: '',
    cintiOperator: '',
    altos: '',
    platform: '',
  };
  type Who = keyof typeof tokens;
  const http = () => request(app.getHttpServer());
  const year = Number(daysAgo(200).slice(0, 4));

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
      error: res.body.error?.code,
      details: res.status === status ? undefined : res.body.error?.details,
    }).toMatchObject({ path, status });
    openapi.expectResponse(method, path, res);
    return res;
  }

  async function terroirId(parcel: string): Promise<string> {
    const t = await prisma.terroir.findFirstOrThrow({
      where: { wineryId: CINTI, parcelName: { contains: parcel } },
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

  /** Corrección compensatoria del lote. */
  function correct(
    who: Who,
    lotId: string,
    status: number,
    body: {
      target: { type: string; id: string };
      kind: 'AMEND' | 'VOID';
      changes?: Record<string, unknown>;
      reason?: string;
    },
  ): Promise<Res> {
    return checked('post', who, `/v1/lots/${lotId}/corrections`, status, {
      reason: 'Corrección de la prueba e2e del bloque A',
      ...body,
    });
  }

  /** Lote con un pesaje aprobado y su tanque (camino corto para cada caso). */
  async function lotWithTank(input: {
    name: string;
    productType?: 'WINE' | 'SINGANI';
    parcel: string;
    netKg: number;
    intakeDaysAgo: number;
    tankCode: string;
    filledLiters: number;
  }): Promise<{ lotId: string; harvestId: string; tankId: string }> {
    const lot = await checked('post', 'cinti', '/v1/lots', 201, {
      name: input.name,
      harvestYear: year,
      ...(input.productType && { productType: input.productType }),
    });
    const lotId = lot.body.data.id as string;
    const harvest = await checked(
      'post',
      'cintiOperator',
      '/v1/harvest-batches',
      201,
      {
        lotId,
        terroirId: await terroirId(input.parcel),
        intakeDate: daysAgo(input.intakeDaysAgo),
        grossWeightKg: input.netKg + 100,
        tareWeightKg: 100,
      },
    );
    const harvestId = harvest.body.data.id as string;
    await checked(
      'post',
      'cintiAgronomist',
      `/v1/harvest-batches/${harvestId}/phyto-decisions`,
      201,
      { decision: 'APPROVED' },
    );
    const tank = await checked('post', 'cinti', '/v1/fermentation-tanks', 201, {
      inputs: [{ harvestBatchId: harvestId }],
      tankCode: input.tankCode,
      volumeFilledLiters: input.filledLiters,
      startFermentation: true,
      startDate: `${daysAgo(input.intakeDaysAgo - 1)}T14:00:00Z`,
    });
    return { lotId, harvestId, tankId: tank.body.data.id as string };
  }

  beforeAll(async () => {
    execFileSync(
      process.execPath,
      [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
      {
        // Esquema propio: sin el candado global de `migrate deploy`, que
        // comparten las suites que migran a la vez (espera máxima de 10 s)
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
    tokens.cintiAgronomist = await tokenFor(
      'agronomo@cintiviejo.test',
      CINTI,
      MembershipRoleEnum.AGRONOMIST,
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
      email: `admin-o2a-${run}@drinksonchain.test`,
      password: 'Plataforma-o2a-123',
      role: MembershipRoleEnum.ADMIN,
    });
    tokens.platform = await staffToken(app, {
      userId: admin.id,
      email: admin.email,
      organizationId: PLATFORM_ORGANIZATION_ID,
      organizationType: 'PLATFORM',
      role: MembershipRoleEnum.ADMIN,
    });
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
  describe('singani: del tanque a los códigos con las acciones nuevas', () => {
    let lotId: string;
    let harvestId: string;
    let tankId: string;
    let logId: string;
    let treatmentId: string;
    let productionId: string;
    let bottlingId: string;
    const tankCode = `TK-A-S-${run}`;
    const tankPath = () => `/v1/fermentation-tanks/${tankId}`;

    it('origen: D.O. de la parcela del pesaje y dictamen que bloquea el tanque (anulable por corrección)', async () => {
      const lot = await checked('post', 'cinti', '/v1/lots', 201, {
        name: 'Singani bloque A',
        harvestYear: year,
        productType: 'SINGANI',
        estimatedBottles: 3000,
        plannedFormatCl: 75,
        targetAbvPercent: 40,
      });
      lotId = lot.body.data.id;

      const wrongParcel = await checked(
        'post',
        'cintiOperator',
        '/v1/harvest-batches',
        422,
        {
          lotId,
          terroirId: await terroirId('Las Carreras'),
          intakeDate: daysAgo(220),
          grossWeightKg: 1100,
          tareWeightKg: 100,
        },
      );
      expect(wrongParcel.body.error.code).toBe('TRC_DO_TERROIR_NOT_ELIGIBLE');

      const harvest = await checked(
        'post',
        'cintiOperator',
        '/v1/harvest-batches',
        201,
        {
          lotId,
          terroirId: await terroirId('Los Parrales'),
          intakeDate: daysAgo(220),
          grossWeightKg: 18500,
          tareWeightKg: 100,
        },
      );
      harvestId = harvest.body.data.id;
      expect(harvest.body.data).toMatchObject({
        correctedFields: [],
        voided: false,
        correctionIds: [],
      });

      const tankBody = {
        inputs: [{ harvestBatchId: harvestId }],
        tankCode,
        capacityLiters: 15000,
        volumeFilledLiters: 12100,
        startDate: `${daysAgo(218)}T14:00:00Z`,
      };
      const pending = await checked(
        'post',
        'cinti',
        '/v1/fermentation-tanks',
        422,
        tankBody,
      );
      expect(pending.body.error.code).toBe('TRC_PHYTO_NOT_APPROVED');

      // Cuarentena por error: tampoco entra al tanque (S-2)
      const quarantine = await checked(
        'post',
        'cintiAgronomist',
        `/v1/harvest-batches/${harvestId}/phyto-decisions`,
        201,
        { decision: 'QUARANTINE', notes: 'Sospecha de oídio en la muestra' },
      );
      const decisionId = quarantine.body.data.phytoDecisions[0].id as string;
      const inQuarantine = await checked(
        'post',
        'cinti',
        '/v1/fermentation-tanks',
        422,
        tankBody,
      );
      expect(details(inQuarantine)[0]).toMatchObject({
        code: 'TRC_PHYTO_NOT_APPROVED',
        actual: 'QUARANTINE',
        meta: { harvestBatchId: harvestId, status: 'QUARANTINE' },
      });

      // El operario no dictamina: tampoco corrige un dictamen (S-17)
      const forbidden = await correct('cintiOperator', lotId, 403, {
        target: { type: 'PHYTO_DECISION', id: decisionId },
        kind: 'VOID',
      });
      expect(forbidden.body.error.code).toBe('AUTH_INSUFFICIENT_PERMISSIONS');
      // Un dictamen no se enmienda: se anula y se dicta otro
      const amend = await correct('cintiAgronomist', lotId, 422, {
        target: { type: 'PHYTO_DECISION', id: decisionId },
        kind: 'AMEND',
        changes: { decision: 'APPROVED' },
      });
      expect(amend.body.error.code).toBe(
        'TRC_CORRECTION_FIELD_NOT_CORRECTABLE',
      );
      const voided = await correct('cintiAgronomist', lotId, 201, {
        target: { type: 'PHYTO_DECISION', id: decisionId },
        kind: 'VOID',
        reason: 'La muestra era de otra parcela: dictamen registrado por error',
      });
      expect(voided.body.data).toMatchObject({
        lotId,
        kind: 'VOID',
        target: { type: 'PHYTO_DECISION', id: decisionId },
        changes: [],
        createdBy: { role: 'AGRONOMIST' },
      });
      const afterVoid = await checked(
        'get',
        'cinti',
        `/v1/harvest-batches/${harvestId}`,
        200,
      );
      expect(afterVoid.body.data).toMatchObject({
        phytosanitaryStatus: 'PENDING_INSPECTION',
        phytoDecisions: [],
      });
      const history = await checked(
        'get',
        'cinti',
        `/v1/harvest-batches/${harvestId}/phyto-decisions`,
        200,
      );
      expect(history.body.data.items).toHaveLength(1);
      expect(history.body.data.items[0]).toMatchObject({
        id: decisionId,
        voided: true,
        correctionIds: [voided.body.data.id],
      });
      const twice = await correct('cintiAgronomist', lotId, 409, {
        target: { type: 'PHYTO_DECISION', id: decisionId },
        kind: 'VOID',
      });
      expect(twice.body.error.code).toBe('CONFLICT');

      await checked(
        'post',
        'cintiAgronomist',
        `/v1/harvest-batches/${harvestId}/phyto-decisions`,
        201,
        { decision: 'APPROVED', decidedAt: `${daysAgo(219)}T12:00:00Z` },
      );
      const tank = await checked(
        'post',
        'cinti',
        '/v1/fermentation-tanks',
        201,
        tankBody,
      );
      tankId = tank.body.data.id;
      expect(tank.body.data).toMatchObject({
        status: 'FILLING',
        availableLiters: 12100,
        transferLossLiters: null,
        destinationType: null,
      });
      expect(tank.body.data.transitions).toHaveLength(1);
      expect(tank.body.data.transitions[0]).toMatchObject({
        status: 'FILLING',
        by: { role: 'OWNER' },
      });

      // Con la uva en el tanque, su dictamen ya no se anula
      const final = await prisma.phytoDecision.findFirstOrThrow({
        where: { harvestBatchId: harvestId, voidedAt: null },
      });
      const locked = await correct('cintiAgronomist', lotId, 409, {
        target: { type: 'PHYTO_DECISION', id: final.id },
        kind: 'VOID',
      });
      expect(locked.body.error.code).toBe('TRC_PHYTO_DECISION_FINAL');
    });

    it('transiciones del tanque: acciones, no PATCH (§4.2)', async () => {
      const skip = await checked(
        'post',
        'cinti',
        `${tankPath()}/complete`,
        409,
        {
          endDate: daysAgo(205),
          finalVolumeLiters: 12000,
          destination: 'SINGANI_DIST',
        },
      );
      expect(skip.body.error.code).toBe('TRC_TANK_INVALID_TRANSITION');
      expect(details(skip)[0].meta).toMatchObject({
        from: 'FILLING',
        to: 'COMPLETED',
      });
      const dirty = await checked(
        'post',
        'cinti',
        `${tankPath()}/clean`,
        409,
        {},
      );
      expect(details(dirty)[0].meta).toMatchObject({
        from: 'FILLING',
        to: 'CLEANED',
      });

      const operator = await checked(
        'post',
        'cintiOperator',
        `${tankPath()}/start`,
        403,
        {},
      );
      expect(operator.body.error.code).toBe('AUTH_INSUFFICIENT_PERMISSIONS');
      const early = await checked('post', 'cinti', `${tankPath()}/start`, 422, {
        startedAt: `${daysAgo(219)}T08:00:00Z`,
      });
      expect(early.body.error.code).toBe('TRC_DATE_BEFORE_PREVIOUS_STAGE');
      const future = await checked(
        'post',
        'cinti',
        `${tankPath()}/start`,
        422,
        {
          startedAt: `${daysAhead(2)}T08:00:00Z`,
        },
      );
      expect(future.body.error.code).toBe('TRC_DATE_IN_FUTURE');

      const started = await checked(
        'post',
        'cinti',
        `${tankPath()}/start`,
        200,
        { startedAt: `${daysAgo(217)}T08:00:00Z` },
      );
      expect(started.body.data.status).toBe('FERMENTING');
      expect(
        started.body.data.transitions.map((t: { status: string }) => t.status),
      ).toEqual(['FILLING', 'FERMENTING']);
      const again = await checked(
        'post',
        'cinti',
        `${tankPath()}/start`,
        409,
        {},
      );
      expect(again.body.error.code).toBe('TRC_TANK_INVALID_TRANSITION');

      // Lecturas y tratamiento (los corrige o anula §9)
      const log = await checked(
        'post',
        'cintiOperator',
        `${tankPath()}/logs`,
        201,
        {
          temperatureCelsius: 22.5,
          specificGravity: 1.085,
          recordedAt: `${daysAgo(216)}T09:00:00Z`,
        },
      );
      logId = log.body.data.id;
      await checked('post', 'cintiOperator', `${tankPath()}/logs`, 201, {
        temperatureCelsius: 24,
        recordedAt: `${daysAgo(215)}T09:00:00Z`,
      });
      const treatment = await checked(
        'post',
        'cinti',
        `${tankPath()}/treatments`,
        201,
        {
          treatmentType: 'SO2_ADDITION',
          additiveName: 'Metabisulfito de potasio',
          dosageAppliedGPerHl: 5,
          regulatoryAuthCode: 'SENASAG-ADT-E2E-001',
          appliedAt: `${daysAgo(216)}T10:00:00Z`,
        },
      );
      treatmentId = treatment.body.data.id;
    });

    it('bifurcación al completar: destino coherente, volumen y fechas (§4.3, ERP-09)', async () => {
      const body = {
        endDate: daysAgo(205),
        finalVolumeLiters: 12000,
        destination: 'SINGANI_DIST',
      };
      const tooMuch = await checked(
        'post',
        'cinti',
        `${tankPath()}/complete`,
        422,
        { ...body, finalVolumeLiters: 12500 },
      );
      expect(details(tooMuch)[0]).toMatchObject({
        code: 'TRC_VOLUME_EXCEEDS_AVAILABLE',
        field: 'finalVolumeLiters',
        expected: 12100,
        actual: 12500,
      });
      const asWine = await checked(
        'post',
        'cinti',
        `${tankPath()}/complete`,
        422,
        { ...body, destination: 'WINE_AGING' },
      );
      expect(details(asWine)[0]).toMatchObject({
        code: 'TRC_DESTINATION_MISMATCH',
        expected: 'SINGANI_DIST',
        actual: 'WINE_AGING',
      });
      const future = await checked(
        'post',
        'cinti',
        `${tankPath()}/complete`,
        422,
        { ...body, endDate: daysAhead(3) },
      );
      expect(future.body.error.code).toBe('TRC_DATE_IN_FUTURE');
      const before = await checked(
        'post',
        'cinti',
        `${tankPath()}/complete`,
        422,
        { ...body, endDate: daysAgo(230) },
      );
      expect(before.body.error.code).toBe('TRC_DATE_BEFORE_PREVIOUS_STAGE');

      const completed = await checked(
        'post',
        'cinti',
        `${tankPath()}/complete`,
        200,
        body,
      );
      expect(completed.body.data).toMatchObject({
        status: 'COMPLETED',
        destinationType: 'SINGANI_DIST',
        finalVolumeLiters: 12000,
        availableLiters: 12000,
        transferLossLiters: null,
      });
      expect(completed.body.data.transitions).toHaveLength(3);
      const events = await prisma.lotEvent.findMany({
        where: { lotId, resourceId: tankId },
        orderBy: { seq: 'asc' },
        select: { type: true },
      });
      expect(events.map((e) => e.type)).toEqual(
        expect.arrayContaining([
          'TANK_FILLED',
          'FERMENTATION_STARTED',
          'FERMENTATION_COMPLETED',
        ]),
      );
      const audit = await prisma.auditEvent.count({
        where: { action: 'TANK_TRANSITION', resourceId: tankId },
      });
      expect(audit).toBe(2);

      // Solo se limpia un tanque transferido
      const dirty = await checked(
        'post',
        'cinti',
        `${tankPath()}/clean`,
        409,
        {},
      );
      expect(details(dirty)[0].meta).toMatchObject({
        from: 'COMPLETED',
        to: 'CLEANED',
      });
      // El laboratorio llega con el embotellado
      const noLab = await checked(
        'post',
        'cinti',
        `/v1/lots/${lotId}/lab-analyses`,
        409,
        { ...labBody(), laboratoryReportKey: await reportKey() },
      );
      expect(noLab.body.error.code).toBe('TRC_LOT_NOT_BOTTLED');
    });

    it('correcciones antes de embotellar: con motivo, sin editar ni borrar; lo que incumple una regla se rechaza', async () => {
      // El operario pesó: puede corregir el pesaje (S-17); las entradas del
      // tanque siguen al neto porque toda la uva entró al tanque
      const weight = await correct('cintiOperator', lotId, 201, {
        target: { type: 'HARVEST_BATCH', id: harvestId },
        kind: 'AMEND',
        changes: { grossWeightKg: 18450, notes: 'Ticket de báscula reemitido' },
        reason: 'La báscula estaba descalibrada; ticket reemitido',
      });
      expect(weight.body.data.createdBy.role).toBe('OPERATOR');
      expect(weight.body.data.changes).toEqual(
        expect.arrayContaining([
          { field: 'grossWeightKg', before: 18500, after: 18450 },
          { field: 'netWeightKg', before: 18400, after: 18350 },
          { field: `tankInputs.${tankCode}.kg`, before: 18400, after: 18350 },
        ]),
      );
      const harvest = await checked(
        'get',
        'cinti',
        `/v1/harvest-batches/${harvestId}`,
        200,
      );
      expect(harvest.body.data).toMatchObject({
        grossWeightKg: 18450,
        netWeightKg: 18350,
        availableKg: 0,
        notes: 'Ticket de báscula reemitido',
        voided: false,
        correctionIds: [weight.body.data.id],
      });
      expect(harvest.body.data.correctedFields).toEqual(
        expect.arrayContaining(['grossWeightKg', 'netWeightKg', 'notes']),
      );
      const event = await prisma.lotEvent.findFirstOrThrow({
        where: { lotId, type: 'HARVEST_WEIGHED' },
      });
      expect(event.corrected).toBe(true);

      // Lista cerrada de campos y de registros anulables
      const code = await correct('cinti', lotId, 422, {
        target: { type: 'HARVEST_BATCH', id: harvestId },
        kind: 'AMEND',
        changes: { harvestBatchCode: 'HARV-OTRO', grossWeightKg: 18000 },
      });
      expect(details(code)[0]).toMatchObject({
        code: 'TRC_CORRECTION_FIELD_NOT_CORRECTABLE',
        field: 'changes.harvestBatchCode',
      });
      const voidHarvest = await correct('cinti', lotId, 422, {
        target: { type: 'HARVEST_BATCH', id: harvestId },
        kind: 'VOID',
      });
      expect(voidHarvest.body.error.code).toBe(
        'TRC_CORRECTION_FIELD_NOT_CORRECTABLE',
      );
      const noReason = await correct('cinti', lotId, 422, {
        target: { type: 'HARVEST_BATCH', id: harvestId },
        kind: 'AMEND',
        changes: { grossWeightKg: 18440 },
        reason: 'corto',
      });
      expect(noReason.body.error.code).toBe('VALIDATION_ERROR');
      const same = await correct('cinti', lotId, 422, {
        target: { type: 'HARVEST_BATCH', id: harvestId },
        kind: 'AMEND',
        changes: { grossWeightKg: 18450 },
      });
      expect(same.body.error.code).toBe('VALIDATION_ERROR');
      const parcel = await correct('cinti', lotId, 422, {
        target: { type: 'TERROIR', id: await terroirId('Los Parrales') },
        kind: 'AMEND',
        changes: { altitudeMasl: 2000 },
      });
      expect(parcel.body.error.code).toBe('VALIDATION_ERROR');

      // Una corrección que incumple una regla del lote se rechaza entera
      const final = await correct('cinti', lotId, 422, {
        target: { type: 'FERMENTATION_TANK', id: tankId },
        kind: 'AMEND',
        changes: { finalVolumeLiters: 12600 },
      });
      expect(final.body.error.code).toBe('TRC_CORRECTION_BREAKS_RULES');
      expect(details(final)[0]).toMatchObject({
        code: 'TRC_VOLUME_EXCEEDS_AVAILABLE',
        expected: 12100,
        actual: 12600,
      });
      const lessGrapes = await correct('cinti', lotId, 422, {
        target: { type: 'FERMENTATION_TANK', id: tankId },
        kind: 'AMEND',
        changes: { startDate: `${daysAgo(240)}T14:00:00Z` },
      });
      expect(lessGrapes.body.error.code).toBe('TRC_CORRECTION_BREAKS_RULES');
      expect(codes(lessGrapes)).toContain('TRC_DATE_BEFORE_PREVIOUS_STAGE');
      const untouched = await checked('get', 'cinti', tankPath(), 200);
      expect(untouched.body.data).toMatchObject({
        finalVolumeLiters: 12000,
        correctedFields: [],
      });

      // Tanques y tratamientos: solo dirección y enología
      const operator = await correct('cintiOperator', lotId, 403, {
        target: { type: 'TREATMENT', id: treatmentId },
        kind: 'AMEND',
        changes: { dosageAppliedGPerHl: 6 },
      });
      expect(operator.body.error.code).toBe('AUTH_INSUFFICIENT_PERMISSIONS');
      await correct('cinti', lotId, 201, {
        target: { type: 'TREATMENT', id: treatmentId },
        kind: 'AMEND',
        changes: { dosageAppliedGPerHl: 6 },
      });
      // Una lectura errónea se anula (la registró el operario)
      const voidLog = await correct('cintiOperator', lotId, 201, {
        target: { type: 'FERMENTATION_LOG', id: logId },
        kind: 'VOID',
        reason: 'Lectura tomada en otro tanque',
      });
      const tank = await checked('get', 'cinti', tankPath(), 200);
      const logs = tank.body.data.logs as {
        id: string;
        voided: boolean;
        voidedAt: string | null;
        correctionIds: string[];
      }[];
      expect(logs).toHaveLength(2);
      expect(logs.find((l) => l.id === logId)).toMatchObject({
        voided: true,
        correctionIds: [voidLog.body.data.id],
      });
      expect(logs.find((l) => l.id === logId)?.voidedAt).not.toBeNull();
      expect(logs.find((l) => l.id !== logId)).toMatchObject({ voided: false });
      // El evento diario de lecturas cuenta solo las vigentes: la anulada sale
      // del recuento y el evento de su día queda marcado como corregido
      const readings = await prisma.lotEvent.findMany({
        where: { lotId, type: 'FERMENTATION_READINGS', resourceId: tankId },
        select: { data: true, corrected: true, summary: true },
      });
      expect(
        readings.reduce(
          (n, e) => n + Number((e.data as { count?: number }).count ?? 0),
          0,
        ),
      ).toBe(1);
      const affected = readings.filter((e) => e.corrected);
      expect(affected).toHaveLength(1);
      expect(affected[0].summary).toMatch(
        /^(1 lectura en |Lecturas anuladas en )/,
      );
      expect(tank.body.data.treatments[0]).toMatchObject({
        dosageAppliedGPerHl: 6,
        correctedFields: ['dosageAppliedGPerHl'],
      });
      const voidedAgain = await correct('cinti', lotId, 409, {
        target: { type: 'FERMENTATION_LOG', id: logId },
        kind: 'AMEND',
        changes: { temperatureCelsius: 20 },
      });
      expect(voidedAgain.body.error.code).toBe('CONFLICT');

      // Aislamiento, plataforma de solo lectura y registros de otro lote
      const other = await correct('altos', lotId, 404, {
        target: { type: 'HARVEST_BATCH', id: harvestId },
        kind: 'AMEND',
        changes: { grossWeightKg: 1 },
      });
      expect(other.body.error.code).toBe('TRC_LOT_NOT_FOUND');
      const platform = await checked(
        'post',
        'platform',
        `/v1/lots/${lotId}/corrections?wineryId=${CINTI}`,
        403,
        {
          target: { type: 'HARVEST_BATCH', id: harvestId },
          kind: 'AMEND',
          changes: { grossWeightKg: 1 },
          reason: 'La plataforma solo lee la trazabilidad',
        },
      );
      expect(platform.body.error.code).toBe('TRC_PLATFORM_READ_ONLY');
      const foreign = await prisma.harvestBatch.findFirstOrThrow({
        where: { wineryId: CINTI, lotId: { not: lotId } },
      });
      const notInLot = await correct('cinti', lotId, 404, {
        target: { type: 'HARVEST_BATCH', id: foreign.id },
        kind: 'AMEND',
        changes: { grossWeightKg: 100 },
      });
      expect(notInLot.body.error.code).toBe('NOT_FOUND');

      // El original nunca se pierde: está en la corrección y en la bitácora
      const list = await checked(
        'get',
        'cintiOperator',
        `/v1/lots/${lotId}/corrections`,
        200,
      );
      expect(list.body.data.total).toBe(4);
      expect(list.body.data.items[0].id).toBe(voidLog.body.data.id);
      expect(
        await prisma.auditEvent.count({
          where: { action: 'CORRECTION_REGISTERED', organizationId: CINTI },
        }),
      ).toBe(4);
    });

    it('destilación: tanque transferido al agotarse, cierre con cortes y balance de masa (§5.2)', async () => {
      const open = await checked(
        'post',
        'cinti',
        '/v1/production-batches/distillation',
        201,
        {
          fermentationTankId: tankId,
          equipmentIdentifier: 'Alambique AL-A',
          processStartDate: daysAgo(200),
          inputVolumeLiters: 12000,
        },
      );
      productionId = open.body.data.id;
      expect(open.body.data).toMatchObject({
        lotId,
        processEndDate: null,
        lock: null,
        availableLiters: null,
      });
      // COMPLETED → TRANSFERRED automático al agotarse su volumen (§4.2)
      const tank = await checked('get', 'cinti', tankPath(), 200);
      expect(tank.body.data).toMatchObject({
        status: 'TRANSFERRED',
        availableLiters: 0,
        transferLossLiters: 0,
      });
      expect(
        tank.body.data.transitions.map((t: { status: string }) => t.status),
      ).toEqual(['FILLING', 'FERMENTING', 'COMPLETED', 'TRANSFERRED']);
      const empty = await checked(
        'post',
        'cinti',
        '/v1/production-batches/distillation',
        409,
        {
          fermentationTankId: tankId,
          equipmentIdentifier: 'Alambique AL-A',
          processStartDate: daysAgo(199),
          inputVolumeLiters: 10,
        },
      );
      expect(empty.body.error.code).toBe('TRC_TANK_NOT_COMPLETED');
      const lateLog = await checked(
        'post',
        'cintiOperator',
        `${tankPath()}/logs`,
        409,
        { temperatureCelsius: 20, recordedAt: `${daysAgo(199)}T09:00:00Z` },
      );
      expect(lateLog.body.error.code).toBe('TRC_TANK_NOT_ACTIVE');

      const path = `/v1/production-batches/${productionId}`;
      const close = {
        processEndDate: daysAgo(100),
        cuts: { headsLiters: 120, heartLiters: 1500, tailsLiters: 210 },
        heartAbvPercent: 60,
        vinasseLiters: 10000,
      };
      const cuts = await checked('post', 'cinti', `${path}/close`, 422, {
        ...close,
        cuts: { headsLiters: 120, heartLiters: 12000, tailsLiters: 210 },
        vinasseLiters: 0,
      });
      expect(details(cuts)[0]).toMatchObject({
        code: 'TRC_MASS_BALANCE_EXCEEDED',
        expected: 12000,
        actual: 12330,
        meta: { inputLiters: 12000, outputLiters: 12330 },
      });
      const vinasse = await checked('post', 'cinti', `${path}/close`, 422, {
        ...close,
        vinasseLiters: 10200,
      });
      expect(vinasse.body.error.code).toBe('TRC_MASS_BALANCE_EXCEEDED');
      const before = await checked('post', 'cinti', `${path}/close`, 422, {
        ...close,
        processEndDate: daysAgo(201),
      });
      expect(before.body.error.code).toBe('TRC_DATE_BEFORE_PREVIOUS_STAGE');
      const future = await checked('post', 'cinti', `${path}/close`, 422, {
        ...close,
        processEndDate: daysAhead(2),
      });
      expect(future.body.error.code).toBe('TRC_DATE_IN_FUTURE');
      const operator = await checked(
        'post',
        'cintiOperator',
        `${path}/close`,
        403,
        close,
      );
      expect(operator.body.error.code).toBe('AUTH_INSUFFICIENT_PERMISSIONS');
      const otherWinery = await checked(
        'post',
        'altos',
        `${path}/close`,
        404,
        close,
      );
      expect(otherWinery.body.error.code).toBe('NOT_FOUND');

      const closed = await checked(
        'post',
        'cinti',
        `${path}/close`,
        200,
        close,
      );
      const unlock = plusDays(daysAgo(100), 180);
      expect(closed.body.data).toMatchObject({
        restStatus: 'RESTING',
        headsLiters: 120,
        heartLiters: 1500,
        tailsLiters: 210,
        vinasseLiters: 10000,
        heartAbvPercent: 60,
        pureAlcoholLiters: 900,
        availableLiters: 1500,
        lock: {
          kind: 'REST',
          released: false,
          unlockDate: unlock,
          daysRemaining: 80,
          rule: {
            settingKey: 'trazabilidad.singani.reposoMinimoDias',
            minimum: 180,
          },
        },
      });
      const lot = await checked('get', 'cinti', `/v1/lots/${lotId}`, 200);
      expect(lot.body.data).toMatchObject({
        stage: 'RESTING',
        nextLock: { unlockDate: unlock },
      });
      const twice = await checked('post', 'cinti', `${path}/close`, 409, close);
      expect(twice.body.error.code).toBe('TRC_DISTILLATION_ALREADY_CLOSED');
      const rest = await checked('get', 'cinti', `${path}/rest-status`, 200);
      expect(rest.body.data).toMatchObject({
        restStatus: 'RESTING',
        isRestCompleted: false,
        daysRemaining: 80,
      });

      // Los cortes corregidos no pueden superar la entrada
      const heart = await correct('cinti', lotId, 422, {
        target: { type: 'PRODUCTION_BATCH', id: productionId },
        kind: 'AMEND',
        changes: { heartLiters: 3000 },
      });
      expect(heart.body.error.code).toBe('TRC_CORRECTION_BREAKS_RULES');
      expect(codes(heart)).toEqual(['TRC_MASS_BALANCE_EXCEEDED']);
    });

    it('candado de reposo con la instantánea: ni el embotellado prematuro ni un cambio de regla lo eluden', async () => {
      const body = {
        bottlingDate: daysAgo(2),
        packagingFormatCl: 75,
        totalBottlesPackaged: 2950,
        finalAlcoholAbv: 40,
        waterDilutionLiters: 750,
      };
      const early = await checked(
        'post',
        'cinti',
        `/v1/lots/${lotId}/bottling`,
        422,
        body,
      );
      expect(details(early)[0]).toMatchObject({
        code: 'TRC_LOCK_NOT_RELEASED',
        rule: 'trazabilidad.singani.reposoMinimoDias',
        meta: { sourceId: productionId, kind: 'REST', daysRemaining: 80 },
      });

      // La plataforma acorta el reposo a mitad de proceso: el lote conserva sus 180 días
      await prisma.settingOverride.create({
        data: {
          key: 'trazabilidad.singani.reposoMinimoDias',
          wineryId: CINTI,
          value: 365,
          reason: 'Prueba e2e: la instantánea manda',
        },
      });
      const other = await checked('post', 'cinti', '/v1/lots', 201, {
        name: 'Singani con reglas nuevas (bloque A)',
        harvestYear: year,
        productType: 'SINGANI',
      });
      expect(other.body.data.rules.singani.minRestDays).toBe(365);
      const production = await checked(
        'get',
        'cinti',
        `/v1/production-batches/${productionId}`,
        200,
      );
      expect(production.body.data.lock).toMatchObject({
        unlockDate: plusDays(daysAgo(100), 180),
        rule: { minimum: 180, applied: 180 },
      });
      const still = await checked(
        'post',
        'cinti',
        `/v1/lots/${lotId}/bottling`,
        422,
        body,
      );
      expect(still.body.error.code).toBe('TRC_LOCK_NOT_RELEASED');

      // La tarea diaria no libera lo que no está cumplido
      const task = new TraceLocksReleaseTask(
        app.get(PrismaService),
        app.get(AuditService),
      );
      await task.run();
      expect(
        await prisma.lotEvent.count({
          where: { lotId, type: 'LOCK_RELEASED' },
        }),
      ).toBe(0);

      // La fecha de cierre estaba mal registrada: se corrige con motivo y el
      // candado se recalcula desde la fecha corregida
      const corrected = await correct('cinti', lotId, 201, {
        target: { type: 'PRODUCTION_BATCH', id: productionId },
        kind: 'AMEND',
        changes: { processEndDate: daysAgo(190) },
        reason: 'El parte del alambique fecha el corte 90 días antes',
      });
      expect(corrected.body.data.changes).toEqual([
        {
          field: 'processEndDate',
          before: daysAgo(100),
          after: daysAgo(190),
        },
        {
          field: 'mandatoryRestUntil',
          before: plusDays(daysAgo(100), 180),
          after: daysAgo(10),
        },
      ]);
      const ready = await checked(
        'get',
        'cinti',
        `/v1/production-batches/${productionId}`,
        200,
      );
      expect(ready.body.data).toMatchObject({
        restStatus: 'READY',
        lock: { released: true, unlockDate: daysAgo(10), daysRemaining: 0 },
      });
      expect(ready.body.data.correctedFields).toEqual(
        expect.arrayContaining(['processEndDate', 'mandatoryRestUntil']),
      );
      const released = await prisma.lotEvent.findMany({
        where: { lotId, type: 'LOCK_RELEASED' },
      });
      expect(released).toHaveLength(1);
      expect(released[0]).toMatchObject({
        actorMembershipId: null,
        resourceId: productionId,
        visibility: 'PUBLIC',
      });

      const bottled = await checked(
        'post',
        'cinti',
        `/v1/lots/${lotId}/bottling`,
        201,
        body,
      );
      bottlingId = bottled.body.data.id;
      const lot = await checked('get', 'cinti', `/v1/lots/${lotId}`, 200);
      expect(lot.body.data).toMatchObject({ stage: 'BOTTLED', bottles: 2950 });
    });

    it('laboratorio del lote: informe por su key, unidades, conformidad calculada y reanálisis (§8)', async () => {
      const path = `/v1/lots/${lotId}/lab-analyses`;
      const upload = await http()
        .post('/v1/uploads?folder=lab')
        .set('Authorization', `Bearer ${tokens.cinti}`)
        .set('X-Forwarded-For', nextIp())
        .attach('file', PDF, 'informe-laboratorio.pdf')
        .expect(201);
      const key = upload.body.data.key as string;
      // La subida devuelve la huella del archivo (contrato O2 §0)
      expect(upload.body.data.sha256).toBe(sha256Of(PDF));

      const noReport = await checked('post', 'cinti', path, 422, labBody());
      expect(noReport.body.error.code).toBe('VALIDATION_ERROR');
      expect(details(noReport)[0].field).toBe('laboratoryReportKey');
      // La URL del informe (alias hasta H2) ya no es un campo
      const byUrl = await checked('post', 'cinti', path, 422, {
        ...labBody(),
        laboratoryReportKey: key,
        laboratoryReportPdfUrl: 'https://laboratorio.e2e.test/informe.pdf',
      });
      expect(byUrl.body.error.code).toBe('VALIDATION_ERROR');
      expect(details(byUrl)[0].field).toBe('laboratoryReportPdfUrl');
      for (const key of [
        `org/${ALTOS}/lab/2026/10/informe.pdf`,
        `org/${CINTI}/lab/2026/10/no-existe.pdf`,
      ]) {
        const missing = await checked('post', 'cinti', path, 422, {
          ...labBody(),
          laboratoryReportKey: key,
        });
        expect(missing.body.error.code).toBe('TRC_FILE_NOT_FOUND');
      }
      const beforeBottling = await checked('post', 'cinti', path, 422, {
        ...labBody(),
        laboratoryReportKey: key,
        testPerformedAt: daysAgo(30),
      });
      expect(beforeBottling.body.error.code).toBe(
        'TRC_DATE_BEFORE_PREVIOUS_STAGE',
      );
      const mismatch = await checked('post', 'cinti', path, 422, {
        ...labBody(),
        laboratoryReportKey: key,
        methanolContentMgL: 48,
        methanolMg100mlAa: 48,
      });
      expect(mismatch.body.error.code).toBe('VALIDATION_ERROR');
      const operator = await checked(
        'post',
        'cintiOperator',
        path,
        403,
        labBody(),
      );
      expect(operator.body.error.code).toBe('AUTH_INSUFFICIENT_PERMISSIONS');

      // Sin metanol: nunca conforme por omisión (EA-08)
      const incomplete = await checked('post', 'cinti', path, 201, {
        ...labBody(),
        laboratoryReportKey: key,
      });
      expect(incomplete.body.data).toMatchObject({
        lotId,
        bottlingBatchId: bottlingId,
        conformityStatus: 'INCOMPLETE',
        conformsToSenasagStandards: false,
        current: true,
        voided: false,
        // El informe queda atado a sus bytes: la huella se guarda con la `key`
        report: { key, sha256: sha256Of(PDF) },
        recordedBy: { role: 'OWNER' },
        units: { methanolMg100mlAa: 'mg/100 mL de alcohol anhidro' },
      });
      expect(incomplete.body.data.report.url).toEqual(expect.any(String));

      // Reanálisis: metanol en mg/L de producto → mg/100 mL a.a. (10 × mgL / grado)
      const complete = await checked('post', 'cinti', path, 201, {
        ...labBody(),
        laboratoryReportKey: key,
        methanolContentMgL: 48,
      });
      expect(complete.body.data).toMatchObject({
        conformityStatus: 'CONFORMING',
        conformsToSenasagStandards: true,
        methanolMg100mlAa: 11.985,
        current: true,
      });
      const list = await checked('get', 'cintiOperator', path, 200);
      expect(list.body.data.total).toBe(2);
      expect(
        list.body.data.items.map((a: { id: string; current: boolean }) => [
          a.id,
          a.current,
        ]),
      ).toEqual([
        [complete.body.data.id, true],
        [incomplete.body.data.id, false],
      ]);
      const hidden = await checked('get', 'altos', path, 404);
      expect(hidden.body.error.code).toBe('TRC_LOT_NOT_FOUND');
      let lot = await checked('get', 'cinti', `/v1/lots/${lotId}`, 200);
      expect(lot.body.data.labStatus).toBe('CONFORMING');

      // Corregir un valor recalcula la conformidad con la instantánea
      const copper = await correct('cinti', lotId, 201, {
        target: { type: 'LAB_ANALYSIS', id: complete.body.data.id },
        kind: 'AMEND',
        changes: { copperContentMgL: 9 },
        reason: 'El informe firmado indica 9 mg/L de cobre, no 0,02',
      });
      expect(copper.body.data.changes).toEqual([
        { field: 'copperContentMgL', before: 0.02, after: 9 },
        {
          field: 'conformityStatus',
          before: 'CONFORMING',
          after: 'NON_CONFORMING',
        },
      ]);
      lot = await checked('get', 'cinti', `/v1/lots/${lotId}`, 200);
      expect(lot.body.data.labStatus).toBe('NON_CONFORMING');

      // Anular el vigente devuelve la vigencia al anterior sin anular
      await correct('cinti', lotId, 201, {
        target: { type: 'LAB_ANALYSIS', id: complete.body.data.id },
        kind: 'VOID',
        reason: 'El informe corresponde a otro lote del laboratorio',
      });
      const current = await checked(
        'get',
        'cinti',
        `/v1/lab-analyses/batch/${bottlingId}`,
        200,
      );
      expect(current.body.data).toMatchObject({
        id: incomplete.body.data.id,
        current: true,
        voided: false,
      });
      const after = await checked('get', 'cinti', path, 200);
      expect(after.body.data.items[0]).toMatchObject({
        id: complete.body.data.id,
        current: false,
        voided: true,
        conformityStatus: 'NON_CONFORMING',
      });
      lot = await checked('get', 'cinti', `/v1/lots/${lotId}`, 200);
      expect(lot.body.data.labStatus).toBe('INCOMPLETE');
    });

    it('correcciones tras embotellar: la regla de un embotellado ya hecho abre una incidencia CORRECTION y otra corrección la resuelve', async () => {
      // El grado del corazón era menor: el alcohol embotellado ya no cuadra
      const weaker = await correct('cinti', lotId, 201, {
        target: { type: 'PRODUCTION_BATCH', id: productionId },
        kind: 'AMEND',
        changes: { heartAbvPercent: 55 },
        reason: 'El alcoholímetro del corte se recalibró: 55 % vol',
      });
      let lot = await checked('get', 'cinti', `/v1/lots/${lotId}`, 200);
      expect(lot.body.data.complianceIssuesOpen).toBe(1);
      expect(lot.body.data.complianceIssues).toHaveLength(1);
      expect(lot.body.data.complianceIssues[0]).toMatchObject({
        code: 'TRC_ALCOHOL_BALANCE_EXCEEDED',
        source: 'CORRECTION',
        resolvedAt: null,
      });
      expect(lot.body.data.complianceIssues[0].details[0]).toMatchObject({
        code: 'TRC_ALCOHOL_BALANCE_EXCEEDED',
        expected: 825,
        actual: 885,
      });
      const event = await prisma.lotEvent.findFirstOrThrow({
        where: { lotId, type: 'CORRECTION' },
        orderBy: { seq: 'desc' },
      });
      expect(event.visibility).toBe('INTERNAL');
      expect(event.data).toMatchObject({
        correctionId: weaker.body.data.id,
        openedIssueIds: [lot.body.data.complianceIssues[0].id],
      });
      const list = await checked(
        'get',
        'cinti',
        '/v1/lots?hasComplianceIssues=true&limit=100',
        200,
      );
      expect(list.body.data.items.map((l: { id: string }) => l.id)).toContain(
        lotId,
      );

      // Ni el número de botellas ni el código de lote son corregibles
      const bottles = await correct('cinti', lotId, 422, {
        target: { type: 'BOTTLING', id: bottlingId },
        kind: 'AMEND',
        changes: { totalBottlesPackaged: 2700 },
      });
      expect(bottles.body.error.code).toBe(
        'TRC_CORRECTION_FIELD_NOT_CORRECTABLE',
      );

      // El valor correcto resuelve la incidencia (resolvedAt)
      await correct('cinti', lotId, 201, {
        target: { type: 'PRODUCTION_BATCH', id: productionId },
        kind: 'AMEND',
        changes: { heartAbvPercent: 60 },
        reason: 'Segunda medición con el alcoholímetro patrón: 60 % vol',
      });
      lot = await checked('get', 'cinti', `/v1/lots/${lotId}`, 200);
      expect(lot.body.data.complianceIssuesOpen).toBe(0);
      expect(lot.body.data.complianceIssues[0].resolvedAt).not.toBeNull();

      // El remanente declarado del embotellado sí se corrige
      const leftover = await correct('cinti', lotId, 201, {
        target: { type: 'BOTTLING', id: bottlingId },
        kind: 'AMEND',
        changes: { leftover: { liters: 20, disposition: 'RETAINED' } },
        reason: 'Quedaron 20 L en la línea, guardados en una damajuana',
      });
      expect(leftover.body.data.changes).toEqual([
        {
          field: 'leftover',
          before: null,
          after: { liters: 20, disposition: 'RETAINED', notes: null },
        },
      ]);
      const bottling = await checked(
        'get',
        'cinti',
        `/v1/bottling/${bottlingId}`,
        200,
      );
      expect(bottling.body.data).toMatchObject({
        leftover: { liters: 20, disposition: 'RETAINED' },
        balance: { leftoverLiters: 20, lossLiters: 17.5 },
        correctedFields: ['leftover'],
        voided: false,
      });

      // Limpiar el tanque libera su código físico (S-7)
      const cleaned = await checked(
        'post',
        'cinti',
        `${tankPath()}/clean`,
        200,
        {},
      );
      expect(cleaned.body.data.status).toBe('CLEANED');
      expect(cleaned.body.data.transitions).toHaveLength(5);
      const twice = await checked(
        'post',
        'cinti',
        `${tankPath()}/clean`,
        409,
        {},
      );
      expect(details(twice)[0].meta).toMatchObject({
        from: 'CLEANED',
        to: 'CLEANED',
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('vino: bifurcación sin tipo, crianza, tarea diaria de candados y descarte', () => {
    let lotId: string;
    let tankA: string;
    let tankB: string;
    let agingA: string;
    let agingB: string;
    let bottlingId: string;
    const complete = (tank: string, status: number, body: object) =>
      checked(
        'post',
        'cinti',
        `/v1/fermentation-tanks/${tank}/complete`,
        status,
        body,
      );

    it('la primera bifurcación fija el tipo del lote; D.O. comprobada si es singani', async () => {
      await prisma.settingOverride.create({
        data: {
          key: 'trazabilidad.vino.crianzaMinimaMeses',
          wineryId: CINTI,
          value: 6,
          reason: 'Prueba e2e: crianza mínima de 6 meses',
        },
      });
      const lot = await checked('post', 'cinti', '/v1/lots', 201, {
        name: 'Tinto bloque A',
        harvestYear: year,
      });
      lotId = lot.body.data.id;
      expect(lot.body.data).toMatchObject({
        productType: null,
        rules: { wine: { minAgingMonths: 6 } },
      });
      const harvest = await checked(
        'post',
        'cintiOperator',
        '/v1/harvest-batches',
        201,
        {
          lotId,
          terroirId: await terroirId('San Roque'),
          intakeDate: daysAgo(450),
          grossWeightKg: 3100,
          tareWeightKg: 100,
        },
      );
      const harvestId = harvest.body.data.id as string;

      // El informe del dictamen va por su key: de la bodega y existente
      const decisions = `/v1/harvest-batches/${harvestId}/phyto-decisions`;
      const decision = {
        decision: 'APPROVED',
        decidedAt: `${daysAgo(449)}T12:00:00Z`,
      };
      const missing = await checked('post', 'cintiAgronomist', decisions, 422, {
        ...decision,
        inspectionReportKey: `org/${CINTI}/inspections/2026/10/no-existe.pdf`,
      });
      expect(missing.body.error.code).toBe('TRC_FILE_NOT_FOUND');
      const upload = await http()
        .post('/v1/uploads?folder=inspections')
        .set('Authorization', `Bearer ${tokens.cintiAgronomist}`)
        .set('X-Forwarded-For', nextIp())
        .attach('file', PDF, 'inspeccion.pdf')
        .expect(201);
      const approved = await checked(
        'post',
        'cintiAgronomist',
        decisions,
        201,
        {
          ...decision,
          inspectionReportKey: upload.body.data.key,
        },
      );
      expect(
        approved.body.data.phytoDecisions[0].inspectionReport,
      ).toMatchObject({ key: upload.body.data.key, url: expect.any(String) });
      const tank = (code: string, kg: number, liters: number) =>
        checked('post', 'cinti', '/v1/fermentation-tanks', 201, {
          inputs: [{ harvestBatchId: harvestId, kg }],
          tankCode: `${code}-${run}`,
          capacityLiters: 2000,
          volumeFilledLiters: liters,
          startFermentation: true,
          startDate: `${daysAgo(448)}T10:00:00Z`,
        });
      const a = await tank('TK-A-W1', 2000, 1400);
      const b = await tank('TK-A-W2', 1000, 700);
      tankA = a.body.data.id;
      tankB = b.body.data.id;
      expect(a.body.data).toMatchObject({ status: 'FERMENTING' });
      expect(a.body.data.transitions).toHaveLength(1);

      // Negra Criolla no es apta: el destino singani no se puede decidir
      const singani = await complete(tankA, 422, {
        endDate: daysAgo(430),
        finalVolumeLiters: 1300,
        destination: 'SINGANI_DIST',
      });
      expect(singani.body.error.code).toBe('TRC_DO_NOT_ELIGIBLE');
      expect(details(singani)[0]).toMatchObject({
        rule: 'trazabilidad.singani.variedadesExigidas',
        actual: 'Negra Criolla',
      });
      let current = await checked('get', 'cinti', `/v1/lots/${lotId}`, 200);
      expect(current.body.data.productType).toBeNull();

      const wine = await complete(tankA, 200, {
        endDate: daysAgo(430),
        finalVolumeLiters: 1300,
        destination: 'WINE_AGING',
      });
      expect(wine.body.data).toMatchObject({
        status: 'COMPLETED',
        destinationType: 'WINE_AGING',
        availableLiters: 1300,
      });
      current = await checked('get', 'cinti', `/v1/lots/${lotId}`, 200);
      expect(current.body.data.productType).toBe('WINE');
      expect(
        await prisma.lotEvent.count({
          where: { lotId, type: 'PRODUCT_DECIDED' },
        }),
      ).toBe(1);

      // Todos los tanques del lote comparten destino
      const mixed = await complete(tankB, 422, {
        endDate: daysAgo(430),
        finalVolumeLiters: 650,
        destination: 'SINGANI_DIST',
      });
      expect(details(mixed)[0]).toMatchObject({
        code: 'TRC_DESTINATION_MISMATCH',
        expected: 'WINE_AGING',
        actual: 'SINGANI_DIST',
      });
      await complete(tankB, 200, {
        endDate: daysAgo(430),
        finalVolumeLiters: 650,
        destination: 'WINE_AGING',
      });
    });

    it('crianza: mínimo de la instantánea aunque cambie la configuración, y tanque transferido con su merma', async () => {
      const body = {
        fermentationTankId: tankA,
        containerType: 'Barrica',
        volumeLiters: 1250,
        plannedMonths: 12,
        startDate: daysAgo(425),
      };
      const short = await checked('post', 'cinti', '/v1/wine-aging', 422, {
        ...body,
        plannedMonths: 3,
      });
      expect(details(short)[0]).toMatchObject({
        code: 'TRC_AGING_BELOW_MINIMUM',
        rule: 'trazabilidad.vino.crianzaMinimaMeses',
        expected: 6,
        actual: 3,
      });
      // Bajar el mínimo en la configuración no afecta al lote ya creado
      await prisma.settingOverride.updateMany({
        where: { key: 'trazabilidad.vino.crianzaMinimaMeses', wineryId: CINTI },
        data: { value: 1 },
      });
      const stillShort = await checked('post', 'cinti', '/v1/wine-aging', 422, {
        ...body,
        plannedMonths: 3,
      });
      expect(details(stillShort)[0]).toMatchObject({
        code: 'TRC_AGING_BELOW_MINIMUM',
        expected: 6,
      });

      const a = await checked('post', 'cinti', '/v1/wine-aging', 201, body);
      agingA = a.body.data.id;
      // Registro tardío: el candado ya está cumplido, pero lo persiste la tarea
      expect(a.body.data).toMatchObject({
        agingStatus: 'AGING',
        lock: { kind: 'AGING', released: true },
      });
      const b = await checked('post', 'cinti', '/v1/wine-aging', 201, {
        ...body,
        fermentationTankId: tankB,
        volumeLiters: 650,
        plannedMonths: 24,
      });
      agingB = b.body.data.id;
      expect(b.body.data.lock).toMatchObject({ released: false });

      const tank = await checked(
        'get',
        'cinti',
        `/v1/fermentation-tanks/${tankA}`,
        200,
      );
      expect(tank.body.data).toMatchObject({
        status: 'TRANSFERRED',
        availableLiters: 0,
        transferLossLiters: 50,
      });
      const second = await checked(
        'post',
        'cinti',
        '/v1/wine-aging',
        409,
        body,
      );
      expect(second.body.error.code).toBe(
        'FERMENTATION_TANK_ALREADY_TRANSFERRED',
      );
    });

    it('tarea diaria trace.locks.release: persiste los candados cumplidos, una sola vez', async () => {
      const task = new TraceLocksReleaseTask(
        app.get(PrismaService),
        app.get(AuditService),
      );
      const first = await task.run();
      expect(first.failed).toBe(0);
      expect(first.released).toBeGreaterThanOrEqual(1);

      const a = await checked('get', 'cinti', `/v1/wine-aging/${agingA}`, 200);
      expect(a.body.data.agingStatus).toBe('READY');
      const b = await checked('get', 'cinti', `/v1/wine-aging/${agingB}`, 200);
      expect(b.body.data.agingStatus).toBe('AGING');
      const events = await prisma.lotEvent.findMany({
        where: { lotId, type: 'LOCK_RELEASED' },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        resourceId: agingA,
        resourceType: 'wine_aging_batch',
        actorMembershipId: null,
      });
      const audit = await prisma.auditEvent.findMany({
        where: { action: 'LOCK_RELEASED', resourceId: agingA },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actorUserId: null,
        organizationId: CINTI,
      });

      // Idempotente: la segunda pasada no toca nada
      const second = await task.run();
      expect(second).toMatchObject({ released: 0, failed: 0 });
      expect(
        await prisma.lotEvent.count({
          where: { lotId, type: 'LOCK_RELEASED' },
        }),
      ).toBe(1);
    });

    it('descarte de una crianza y correcciones de la crianza con el candado', async () => {
      const bottling = {
        bottlingDate: daysAgo(2),
        packagingFormatCl: 75,
        totalBottlesPackaged: 1640,
        finalAlcoholAbv: 13.5,
      };
      // La crianza B (24 meses) sigue bloqueada: el lote no se embotella
      const locked = await checked(
        'post',
        'cinti',
        `/v1/lots/${lotId}/bottling`,
        422,
        bottling,
      );
      expect(details(locked)[0]).toMatchObject({
        code: 'TRC_LOCK_NOT_RELEASED',
        rule: 'trazabilidad.vino.crianzaMinimaMeses',
        meta: { sourceId: agingB, kind: 'AGING' },
      });

      const path = `/v1/wine-aging/${agingB}/discard`;
      const tooMuch = await checked('post', 'cinti', path, 422, {
        reason: 'Barrica picada',
        discardedLiters: 700,
      });
      expect(details(tooMuch)[0]).toMatchObject({
        code: 'TRC_VOLUME_EXCEEDS_AVAILABLE',
        expected: 650,
        actual: 700,
      });
      const operator = await checked('post', 'cintiOperator', path, 403, {
        reason: 'Barrica picada',
      });
      expect(operator.body.error.code).toBe('AUTH_INSUFFICIENT_PERMISSIONS');
      const discarded = await checked('post', 'cinti', path, 200, {
        reason: 'Barrica picada: acidez volátil fuera de control',
      });
      expect(discarded.body.data).toMatchObject({
        agingStatus: 'DISCARDED',
        availableLiters: 0,
      });
      const twice = await checked('post', 'cinti', path, 409, {
        reason: 'Barrica picada',
      });
      expect(twice.body.error.code).toBe('TRC_INVALID_STAGE');
      const event = await prisma.lotEvent.findFirstOrThrow({
        where: { lotId, resourceId: agingB, type: 'LOT_DISCARDED' },
      });
      expect(event).toMatchObject({ visibility: 'INTERNAL', stage: 'AGING' });
      expect(
        await prisma.auditEvent.count({
          where: { action: 'AGING_DISCARDED', resourceId: agingB },
        }),
      ).toBe(1);
      const amendDiscarded = await correct('cinti', lotId, 409, {
        target: { type: 'WINE_AGING', id: agingB },
        kind: 'AMEND',
        changes: { volumeLiters: 600 },
      });
      expect(amendDiscarded.body.error.code).toBe('TRC_INVALID_STAGE');

      // Una corrección no puede dejar la crianza bajo el mínimo del lote
      const short = await correct('cinti', lotId, 422, {
        target: { type: 'WINE_AGING', id: agingA },
        kind: 'AMEND',
        changes: { plannedMonths: 3 },
      });
      expect(short.body.error.code).toBe('TRC_CORRECTION_BREAKS_RULES');
      expect(details(short)[0]).toMatchObject({
        code: 'TRC_AGING_BELOW_MINIMUM',
        rule: 'trazabilidad.vino.crianzaMinimaMeses',
        expected: 6,
        actual: 3,
      });
      // Corregir el inicio recalcula el candado: vuelve a estar bloqueada
      const later = await correct('cinti', lotId, 201, {
        target: { type: 'WINE_AGING', id: agingA },
        kind: 'AMEND',
        changes: { startDate: daysAgo(30) },
        reason: 'El trasiego a barrica fue hace un mes, no hace catorce',
      });
      expect(
        later.body.data.changes.map((c: { field: string }) => c.field),
      ).toEqual(['startDate', 'unlockDate']);
      let aging = await checked(
        'get',
        'cinti',
        `/v1/wine-aging/${agingA}`,
        200,
      );
      expect(aging.body.data).toMatchObject({
        agingStatus: 'AGING',
        lock: { released: false },
      });
      const blocked = await checked(
        'post',
        'cinti',
        `/v1/lots/${lotId}/bottling`,
        422,
        bottling,
      );
      expect(blocked.body.error.code).toBe('TRC_LOCK_NOT_RELEASED');
      await correct('cinti', lotId, 201, {
        target: { type: 'WINE_AGING', id: agingA },
        kind: 'AMEND',
        changes: { startDate: daysAgo(425) },
        reason: 'Se confirmó con el cuaderno de bodega: hace catorce meses',
      });
      aging = await checked('get', 'cinti', `/v1/wine-aging/${agingA}`, 200);
      expect(aging.body.data).toMatchObject({
        agingStatus: 'READY',
        lock: { released: true },
      });

      const bottled = await checked(
        'post',
        'cinti',
        `/v1/lots/${lotId}/bottling`,
        201,
        bottling,
      );
      bottlingId = bottled.body.data.id;
    });

    it('volumen de una fuente ya embotellada: la corrección se registra y abre una incidencia', async () => {
      // 1.640 botellas × 75 cL = 1.230 L: con 1.200 L en barrica no cuadra
      await correct('cinti', lotId, 201, {
        target: { type: 'WINE_AGING', id: agingA },
        kind: 'AMEND',
        changes: { volumeLiters: 1200 },
        reason: 'El aforo de las barricas daba 1.200 L, no 1.250 L',
      });
      let lot = await checked('get', 'cinti', `/v1/lots/${lotId}`, 200);
      expect(lot.body.data.complianceIssues).toHaveLength(1);
      expect(lot.body.data.complianceIssues[0]).toMatchObject({
        code: 'TRC_BOTTLING_EXCEEDS_VOLUME',
        source: 'CORRECTION',
        resolvedAt: null,
      });
      const bottling = await checked(
        'get',
        'cinti',
        `/v1/bottling/${bottlingId}`,
        200,
      );
      expect(bottling.body.data.balance).toMatchObject({
        availableLiters: 1200,
        bottledLiters: 1230,
      });
      await correct('cinti', lotId, 201, {
        target: { type: 'WINE_AGING', id: agingA },
        kind: 'AMEND',
        changes: { volumeLiters: 1250 },
        reason: 'Segundo aforo con caña calibrada: 1.250 L',
      });
      lot = await checked('get', 'cinti', `/v1/lots/${lotId}`, 200);
      expect(lot.body.data.complianceIssuesOpen).toBe(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('descartes y tanques', () => {
    it('destilación: descarte con motivo, closeTank y merma de trasiego', async () => {
      const { lotId, tankId } = await lotWithTank({
        name: 'Singani descarte bloque A',
        productType: 'SINGANI',
        parcel: 'Cañón Viejo',
        netKg: 1000,
        intakeDaysAgo: 60,
        tankCode: `TK-A-D-${run}`,
        filledLiters: 700,
      });
      await checked(
        'post',
        'cinti',
        `/v1/fermentation-tanks/${tankId}/complete`,
        200,
        {
          endDate: daysAgo(50),
          finalVolumeLiters: 650,
          destination: 'SINGANI_DIST',
        },
      );
      const distill = (body: object, status = 201) =>
        checked(
          'post',
          'cinti',
          '/v1/production-batches/distillation',
          status,
          {
            fermentationTankId: tankId,
            equipmentIdentifier: 'Alambique AL-B',
            processStartDate: daysAgo(45),
            ...body,
          },
        );
      const first = await distill({ inputVolumeLiters: 300 });
      const path = `/v1/production-batches/${first.body.data.id}`;
      let tank = await checked(
        'get',
        'cinti',
        `/v1/fermentation-tanks/${tankId}`,
        200,
      );
      expect(tank.body.data).toMatchObject({
        status: 'COMPLETED',
        availableLiters: 350,
      });

      const short = await checked('post', 'cinti', `${path}/discard`, 422, {
        reason: 'no',
      });
      expect(short.body.error.code).toBe('VALIDATION_ERROR');
      const discarded = await checked('post', 'cinti', `${path}/discard`, 200, {
        reason: 'Corte contaminado por una junta del alambique',
      });
      expect(discarded.body.data).toMatchObject({
        restStatus: 'DISCARDED',
        availableLiters: 0,
      });
      const again = await checked('post', 'cinti', `${path}/discard`, 409, {
        reason: 'Corte contaminado',
      });
      expect(again.body.error.code).toBe('TRC_INVALID_STAGE');
      const closed = await checked('post', 'cinti', `${path}/close`, 409, {
        processEndDate: daysAgo(40),
        cuts: { headsLiters: 5, heartLiters: 40, tailsLiters: 8 },
        heartAbvPercent: 60,
      });
      expect(closed.body.error.code).toBe('TRC_INVALID_STAGE');
      expect(
        await prisma.auditEvent.count({
          where: {
            action: 'DISTILLATION_DISCARDED',
            resourceId: first.body.data.id,
          },
        }),
      ).toBe(1);
      const lot = await checked('get', 'cinti', `/v1/lots/${lotId}`, 200);
      expect(lot.body.data.stage).toBe('FERMENTING');

      // Última destilación del tanque: lo que sobra es merma de trasiego
      await distill({ inputVolumeLiters: 300, closeTank: true });
      tank = await checked(
        'get',
        'cinti',
        `/v1/fermentation-tanks/${tankId}`,
        200,
      );
      expect(tank.body.data).toMatchObject({
        status: 'TRANSFERRED',
        availableLiters: 0,
        transferLossLiters: 50,
      });
      const empty = await distill({ inputVolumeLiters: 10 }, 409);
      expect(empty.body.error.code).toBe('TRC_TANK_NOT_COMPLETED');
    });

    it('un tanque sin completar no es origen de una destilación ni de una crianza (H2: TRC_TANK_NOT_COMPLETED pleno)', async () => {
      const { tankId } = await lotWithTank({
        name: 'Singani sin completar bloque A',
        productType: 'SINGANI',
        parcel: 'Cañón Viejo',
        netKg: 500,
        intakeDaysAgo: 30,
        tankCode: `TK-A-L-${run}`,
        filledLiters: 400,
      });
      const distillation = {
        fermentationTankId: tankId,
        equipmentIdentifier: 'Alambique AL-C',
        processStartDate: daysAgo(25),
        inputVolumeLiters: 300,
      };
      const early = await checked(
        'post',
        'cinti',
        '/v1/production-batches/distillation',
        409,
        distillation,
      );
      expect(early.body.error.code).toBe('TRC_TANK_NOT_COMPLETED');
      expect(details(early)[0]).toMatchObject({
        field: 'fermentationTankId',
        meta: { status: 'FERMENTING', tankId },
      });
      const aging = await checked('post', 'cinti', '/v1/wine-aging', 409, {
        fermentationTankId: tankId,
        containerType: 'Barrica',
        volumeLiters: 300,
        plannedMonths: 6,
      });
      expect(aging.body.error.code).toBe('TRC_TANK_NOT_COMPLETED');
      // Nada se escribió: el tanque sigue fermentando con todo su volumen
      const path = `/v1/fermentation-tanks/${tankId}`;
      let tank = await checked('get', 'cinti', path, 200);
      expect(tank.body.data).toMatchObject({
        status: 'FERMENTING',
        availableLiters: 400,
        destinationType: null,
      });

      await checked('post', 'cinti', `${path}/complete`, 200, {
        endDate: daysAgo(26),
        finalVolumeLiters: 380,
        destination: 'SINGANI_DIST',
      });
      await checked(
        'post',
        'cinti',
        '/v1/production-batches/distillation',
        201,
        distillation,
      );
      tank = await checked('get', 'cinti', path, 200);
      expect(tank.body.data).toMatchObject({
        status: 'COMPLETED',
        availableLiters: 80,
        transferLossLiters: null,
      });
    });

    it('un tanque COMPLETED con remanente se cierra al limpiarlo: el remanente es merma de trasiego', async () => {
      const { lotId, tankId } = await lotWithTank({
        name: 'Singani con remanente bloque A',
        productType: 'SINGANI',
        parcel: 'Cañón Viejo',
        netKg: 900,
        intakeDaysAgo: 40,
        tankCode: `TK-A-R-${run}`,
        filledLiters: 600,
      });
      const path = `/v1/fermentation-tanks/${tankId}`;
      await checked('post', 'cinti', `${path}/complete`, 200, {
        endDate: daysAgo(30),
        finalVolumeLiters: 580,
        destination: 'SINGANI_DIST',
      });
      // Sin ninguna salida, el vino base del lote sigue dentro: no se limpia
      const full = await checked('post', 'cinti', `${path}/clean`, 409, {});
      expect(full.body.error.code).toBe('TRC_TANK_INVALID_TRANSITION');
      expect(details(full)[0].meta).toMatchObject({
        from: 'COMPLETED',
        to: 'CLEANED',
      });

      await checked(
        'post',
        'cinti',
        '/v1/production-batches/distillation',
        201,
        {
          fermentationTankId: tankId,
          equipmentIdentifier: 'Alambique AL-R',
          processStartDate: daysAgo(28),
          inputVolumeLiters: 500,
        },
      );
      let tank = await checked('get', 'cinti', path, 200);
      expect(tank.body.data).toMatchObject({
        status: 'COMPLETED',
        availableLiters: 80,
      });

      // Con el remanente dentro: limpiar lo cierra (TRANSFERRED) y lo limpia
      const cleaned = await checked('post', 'cinti', `${path}/clean`, 200, {
        cleanedAt: `${daysAgo(20)}T15:00:00Z`,
      });
      expect(cleaned.body.data).toMatchObject({
        status: 'CLEANED',
        availableLiters: 0,
        transferLossLiters: 80,
      });
      expect(
        (cleaned.body.data.transitions as { status: string }[]).map(
          (t) => t.status,
        ),
      ).toEqual(['FERMENTING', 'COMPLETED', 'TRANSFERRED', 'CLEANED']);
      // El código físico queda libre y el tanque ya no es origen de nada
      const more = await checked(
        'post',
        'cinti',
        '/v1/production-batches/distillation',
        409,
        {
          fermentationTankId: tankId,
          equipmentIdentifier: 'Alambique AL-R',
          processStartDate: daysAgo(19),
          inputVolumeLiters: 50,
        },
      );
      expect(more.body.error.code).toBe('TRC_TANK_NOT_COMPLETED');
      tank = await checked('get', 'cinti', path, 200);
      expect(tank.body.data.status).toBe('CLEANED');
      const lot = await checked('get', 'cinti', `/v1/lots/${lotId}`, 200);
      expect(lot.body.data.stage).toBe('DISTILLING');
      expect(
        await prisma.auditEvent.count({
          where: { action: 'TANK_TRANSITION', resourceId: tankId },
        }),
      ).toBe(2);
    });

    it('lote descartado: sus tanques no cambian de estado, pero se limpian para liberar el código', async () => {
      const { lotId, tankId } = await lotWithTank({
        name: 'Lote retirado bloque A',
        parcel: 'Cañón Viejo',
        netKg: 800,
        intakeDaysAgo: 20,
        tankCode: `TK-A-X-${run}`,
        filledLiters: 500,
      });
      await checked('post', 'cinti', `/v1/lots/${lotId}/discard`, 200, {
        reason: 'Fermentación detenida: mosto retirado',
      });
      const completed = await checked(
        'post',
        'cinti',
        `/v1/fermentation-tanks/${tankId}/complete`,
        409,
        {
          endDate: daysAgo(5),
          finalVolumeLiters: 450,
          destination: 'WINE_AGING',
        },
      );
      expect(completed.body.error.code).toBe('TRC_LOT_TERMINAL');
      const correction = await correct('cinti', lotId, 409, {
        target: { type: 'FERMENTATION_TANK', id: tankId },
        kind: 'AMEND',
        changes: { volumeFilledLiters: 480 },
      });
      expect(correction.body.error.code).toBe('TRC_LOT_TERMINAL');
      const cleaned = await checked(
        'post',
        'cinti',
        `/v1/fermentation-tanks/${tankId}/clean`,
        200,
        {},
      );
      expect(cleaned.body.data.status).toBe('CLEANED');
      expect(
        cleaned.body.data.transitions.map((t: { status: string }) => t.status),
      ).toEqual(['FERMENTING', 'CLEANED']);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('corrección de una parcela usada (§3.1, §9)', () => {
    it('reevalúa la D.O. de los lotes abiertos: incidencia RULES_REEVALUATION y su resolución', async () => {
      const molino = await terroirId('El Molino');
      const lot = await checked('post', 'cinti', '/v1/lots', 201, {
        name: 'Singani D.O. reevaluada bloque A',
        harvestYear: year,
        productType: 'SINGANI',
      });
      const lotId = lot.body.data.id as string;
      await checked('post', 'cintiOperator', '/v1/harvest-batches', 201, {
        lotId,
        terroirId: molino,
        intakeDate: daysAgo(20),
        grossWeightKg: 600,
        tareWeightKg: 100,
      });
      const path = `/v1/terroirs/${molino}/corrections`;

      // La parcela usada no cambia por PATCH sus campos normativos
      const patch = await checked(
        'patch',
        'cinti',
        `/v1/terroirs/${molino}`,
        409,
        {
          altitudeMasl: 1500,
        },
      );
      expect(patch.body.error.code).toBe('TRC_TERROIR_IN_USE');
      const operator = await checked('post', 'cintiOperator', path, 403, {
        changes: { altitudeMasl: 1500 },
        reason: 'El operario no edita parcelas',
      });
      expect(operator.body.error.code).toBe('AUTH_INSUFFICIENT_PERMISSIONS');
      const field = await checked('post', 'cintiAgronomist', path, 422, {
        changes: { surfaceHectares: 3 },
        reason: 'La superficie se edita con PATCH',
      });
      expect(field.body.error.code).toBe(
        'TRC_CORRECTION_FIELD_NOT_CORRECTABLE',
      );
      const invalid = await checked('post', 'cintiAgronomist', path, 422, {
        changes: { altitudeMasl: -5 },
        reason: 'Altitud imposible para la prueba',
      });
      expect(invalid.body.error.code).toBe('VALIDATION_ERROR');
      const other = await checked('post', 'altos', path, 404, {
        changes: { altitudeMasl: 1500 },
        reason: 'Parcela de otra bodega',
      });
      expect(other.body.error.code).toBe('NOT_FOUND');

      const lower = await checked('post', 'cintiAgronomist', path, 201, {
        changes: { altitudeMasl: 1500 },
        reason: 'Altitud medida de nuevo con GPS diferencial',
      });
      expect(lower.body.data).toMatchObject({
        lotId: null,
        kind: 'AMEND',
        target: { type: 'TERROIR', id: molino },
        changes: [{ field: 'altitudeMasl', before: 2320, after: 1500 }],
        createdBy: { role: 'AGRONOMIST' },
      });
      const terroir = await checked(
        'get',
        'cinti',
        `/v1/terroirs/${molino}`,
        200,
      );
      expect(terroir.body.data).toMatchObject({
        altitudeMasl: 1500,
        isDoEligible: false,
        correctedFields: ['altitudeMasl'],
        correctionIds: [lower.body.data.id],
      });
      let current = await checked('get', 'cinti', `/v1/lots/${lotId}`, 200);
      expect(current.body.data.denomination.status).toBe('NOT_ELIGIBLE');
      expect(current.body.data.complianceIssues).toHaveLength(1);
      expect(current.body.data.complianceIssues[0]).toMatchObject({
        code: 'TRC_DO_NOT_ELIGIBLE',
        source: 'RULES_REEVALUATION',
        resolvedAt: null,
      });
      expect(current.body.data.complianceIssues[0].details[0]).toMatchObject({
        rule: 'trazabilidad.singani.altitudMinimaMsnm',
        expected: 1600,
        actual: 1500,
      });
      const same = await checked('post', 'cintiAgronomist', path, 422, {
        changes: { altitudeMasl: 1500 },
        reason: 'La misma altitud otra vez',
      });
      expect(same.body.error.code).toBe('VALIDATION_ERROR');

      await checked('post', 'cinti', path, 201, {
        changes: { altitudeMasl: 2320 },
        reason: 'El GPS estaba mal configurado: vale la altitud del catastro',
      });
      current = await checked('get', 'cinti', `/v1/lots/${lotId}`, 200);
      expect(current.body.data).toMatchObject({
        complianceIssuesOpen: 0,
        denomination: { status: 'ELIGIBLE' },
      });
      expect(current.body.data.complianceIssues[0].resolvedAt).not.toBeNull();
    });
  });

  it('las rutas del bloque ya no responden 501 y sus respuestas cumplen el contrato', () => {
    const covered = [...openapi.covered];
    for (const operation of [
      'POST /v1/fermentation-tanks/{id}/start 200',
      'POST /v1/fermentation-tanks/{id}/complete 200',
      'POST /v1/fermentation-tanks/{id}/clean 200',
      'POST /v1/wine-aging/{id}/discard 200',
      'POST /v1/production-batches/{id}/close 200',
      'POST /v1/production-batches/{id}/discard 200',
      'POST /v1/lots/{id}/lab-analyses 201',
      'GET /v1/lots/{id}/lab-analyses 200',
      'POST /v1/lots/{id}/corrections 201',
      'GET /v1/lots/{id}/corrections 200',
      'POST /v1/terroirs/{id}/corrections 201',
    ]) {
      expect(covered).toContain(operation);
    }
    expect(covered.filter((c) => c.endsWith(' 501'))).toEqual([]);
  });

  /** Análisis de singani completo salvo el metanol y el informe (`key`). */
  function labBody() {
    return {
      certifiedLaboratoryName: 'Laboratorio e2e ISO 17025',
      accreditedLabCertificationCode: `LAB-A-${run}`,
      testPerformedAt: daysAgo(1),
      actualAlcoholAbv: 40.05,
      totalAcidityTartaricGl: 4.8,
      volatileAcidityAceticGl: 0.22,
      copperContentMgL: 0.02,
    };
  }

  /** `key` de un informe de laboratorio subido por la bodega (una vez). */
  let uploadedReport: string | undefined;
  async function reportKey(): Promise<string> {
    if (!uploadedReport) {
      const upload = await http()
        .post('/v1/uploads?folder=lab')
        .set('Authorization', `Bearer ${tokens.cinti}`)
        .set('X-Forwarded-For', nextIp())
        .attach('file', PDF, 'informe-laboratorio.pdf')
        .expect(201);
      uploadedReport = upload.body.data.key as string;
    }
    return uploadedReport;
  }
});
