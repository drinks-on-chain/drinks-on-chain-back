import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { loadMockFixtures } from '../src/seed/fixtures';
import { runSeed } from '../src/seed/run-seed';
import {
  DEFAULT_QUEUE_PREFIX,
  workerHeartbeatKey,
} from '../src/shared/queue/queue.constants';
import { loadOpenApiValidator } from './helpers/openapi-validator';

/**
 * Contrato de las respuestas del ERP contra `openapi.json` (tipos incluidos):
 * un recurso de cada módulo (parcelas, vendimias, tanques, crianzas,
 * destilaciones, embotellados, laboratorio, DAG y pasaporte público) sobre la
 * semilla de demostración, en un esquema propio de Postgres.
 *
 * Origen: los `Decimal` de Prisma salían como texto (`"5"`) aunque el
 * contrato dice `number`, y el ERP los rechazaba.
 */
const run = `${Date.now()}${randomBytes(3).toString('hex')}`;
const schema = `contract_e2e_${run}`;
const originalUrl = process.env.DATABASE_URL;

function urlWithSchema(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('schema', name);
  return parsed.toString();
}

const databaseUrl = urlWithSchema(process.env.DATABASE_URL ?? '', schema);
const DEMO_PASSWORD = `demo-${randomBytes(8).toString('hex')}`;

type Item = { id: string } & Record<string, unknown>;

describe('Contrato OpenAPI de las respuestas del ERP (e2e)', () => {
  const openapi = loadOpenApiValidator();
  let prisma: PrismaClient;
  let app: INestApplication;
  let ipSeq = 1;
  const nextIp = () =>
    `10.220.${Math.floor(Math.random() * 200)}.${(ipSeq++ % 250) + 1}`;
  const tokens: Record<'altos' | 'cintiviejo', string> = {
    altos: '',
    cintiviejo: '',
  };

  const http = () => request(app.getHttpServer());

  /** GET autenticado que además valida la respuesta contra el contrato. */
  async function get(
    who: keyof typeof tokens | null,
    path: string,
    status = 200,
  ): Promise<request.Response> {
    const req = http().get(path).set('X-Forwarded-For', nextIp());
    if (who) req.set('Authorization', `Bearer ${tokens[who]}`);
    const res = await req;
    expect({ path, status: res.status }).toEqual({ path, status });
    openapi.expectResponse('get', path, res);
    return res;
  }

  async function firstItem(
    who: keyof typeof tokens,
    path: string,
  ): Promise<Item> {
    const res = await get(who, path);
    const items = res.body.data.items as Item[];
    expect(items.length).toBeGreaterThan(0);
    return items[0];
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
    await runSeed(
      prisma,
      { superadmin: null, demo: { password: DEMO_PASSWORD }, bcryptRounds: 4 },
      undefined,
      loadMockFixtures(),
    );

    process.env.DATABASE_URL = databaseUrl;
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    for (const winery of ['altos', 'cintiviejo'] as const) {
      const login = await http()
        .post('/v1/auth/login')
        .set('X-Forwarded-For', nextIp())
        .send({ email: `admin@${winery}.test`, password: DEMO_PASSWORD })
        .expect(200);
      openapi.expectResponse('post', '/v1/auth/login', login);
      tokens[winery] = login.body.data.tokens.accessToken as string;
    }
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
  });

  it('el validador detecta un decimal servido como texto', () => {
    const errors = openapi.validate('get', '/v1/terroirs/abc', 200, {
      success: true,
      statusCode: 200,
      timestamp: new Date().toISOString(),
      path: '/v1/terroirs/abc',
      data: {
        id: 'abc',
        wineryId: 'w',
        parcelName: 'p',
        surfaceHectares: '5',
        altitudeMasl: 1850,
        rawMaterialType: 'uva',
        varietyName: 'Moscatel',
        isDoEligible: true,
        isActive: true,
        createdAt: new Date().toISOString(),
      },
    });
    expect(errors.join('\n')).toContain('/surfaceHectares: must be number');
    expect(
      openapi.resolvePath('post', '/v1/production-batches/distillation'),
    ).toBe('/v1/production-batches/distillation');
    expect(openapi.resolvePath('get', '/v1/production-batches/x')).toBe(
      '/v1/production-batches/{id}',
    );
  });

  it('parcelas: lista, detalle, alta y edición con decimales numéricos', async () => {
    const terroir = await firstItem('altos', '/v1/terroirs');
    expect(typeof terroir.surfaceHectares).toBe('number');
    expect(typeof terroir.altitudeMasl).toBe('number');
    await get('altos', `/v1/terroirs/${terroir.id}`);

    // Alta idempotente: la respuesta y su repetición, iguales y con números
    const key = randomUUID();
    const body = {
      parcelName: `Cuartel contrato ${run}`,
      surfaceHectares: 5.5,
      altitudeMasl: 1850.25,
      latitude: -21.48512,
      longitude: -64.78921,
      rawMaterialType: 'uva',
      varietyName: 'Moscatel de Alejandría',
    };
    const created = await http()
      .post('/v1/terroirs')
      .set('X-Forwarded-For', nextIp())
      .set('Authorization', `Bearer ${tokens.altos}`)
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    openapi.expectResponse('post', '/v1/terroirs', created);
    expect(created.body.data).toMatchObject({
      surfaceHectares: 5.5,
      altitudeMasl: 1850.25,
      latitude: -21.48512,
      longitude: -64.78921,
    });
    const replay = await http()
      .post('/v1/terroirs')
      .set('X-Forwarded-For', nextIp())
      .set('Authorization', `Bearer ${tokens.altos}`)
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    expect(replay.body.data).toEqual(created.body.data);

    const id = created.body.data.id as string;
    const patched = await http()
      .patch(`/v1/terroirs/${id}`)
      .set('X-Forwarded-For', nextIp())
      .set('Authorization', `Bearer ${tokens.altos}`)
      .send({ surfaceHectares: 6.75, latitude: null })
      .expect(200);
    openapi.expectResponse('patch', `/v1/terroirs/${id}`, patched);
    expect(patched.body.data).toMatchObject({
      surfaceHectares: 6.75,
      latitude: null,
    });

    // La bitácora conserva su formato: decimales como texto exacto en
    // before/after (lo que se guardó y se usó para el hash)
    const audit = await get(
      'altos',
      `/v1/organizations/current/audit?resourceId=${id}`,
    );
    const events = audit.body.data.items as {
      after: Record<string, unknown> | null;
    }[];
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(typeof event.after?.surfaceHectares).toBe('string');
    }
  });

  it('vendimias', async () => {
    const harvest = await firstItem('altos', '/v1/harvest-batches');
    expect(typeof harvest.grossWeightKg).toBe('number');
    expect(typeof harvest.netWeightKg).toBe('number');
    await get('altos', `/v1/harvest-batches/${harvest.id}`);
  });

  it('tanques de fermentación', async () => {
    const tank = await firstItem('altos', '/v1/fermentation-tanks');
    const detail = await get('altos', `/v1/fermentation-tanks/${tank.id}`);
    expect(Array.isArray(detail.body.data.logs)).toBe(true);

    const log = await http()
      .post(`/v1/fermentation-tanks/${tank.id}/logs`)
      .set('X-Forwarded-For', nextIp())
      .set('Authorization', `Bearer ${tokens.altos}`)
      .send({
        temperatureCelsius: 18.25,
        specificGravity: 1.0452,
        phValue: 3.45,
        recordedAt: new Date().toISOString(),
      })
      .expect(201);
    openapi.expectResponse(
      'post',
      `/v1/fermentation-tanks/${tank.id}/logs`,
      log,
    );
    expect(log.body.data).toMatchObject({
      temperatureCelsius: 18.25,
      specificGravity: 1.0452,
      phValue: 3.45,
    });
    const cvjTank = await firstItem('cintiviejo', '/v1/fermentation-tanks');
    await get('cintiviejo', `/v1/fermentation-tanks/${cvjTank.id}`);
  });

  it('crianzas', async () => {
    const aging = await firstItem('altos', '/v1/wine-aging');
    await get('altos', `/v1/wine-aging/${aging.id}`);
  });

  it('destilaciones (y su reposo)', async () => {
    const batch = await firstItem('cintiviejo', '/v1/production-batches');
    await get('cintiviejo', `/v1/production-batches/${batch.id}`);
    await get('cintiviejo', `/v1/production-batches/${batch.id}/rest-status`);
  });

  it('embotellados, laboratorio, DAG y pasaporte público', async () => {
    for (const who of ['altos', 'cintiviejo'] as const) {
      const list = await get(who, '/v1/bottling');
      const bottlings = list.body.data.items as Item[];
      expect(bottlings.length).toBeGreaterThan(0);
      for (const bottling of bottlings) {
        expect(typeof bottling.finalAlcoholAbv).toBe('number');
        await get(who, `/v1/bottling/${bottling.id}`);
        await get(who, `/v1/traceability/dag/${bottling.id}`);
        await get(
          null,
          `/v1/traceability/public/${encodeURIComponent(String(bottling.internationalLotCode))}`,
        );
      }
    }
    const lab = await prisma.batchLabAnalysis.findFirstOrThrow({
      include: { bottlingBatch: true },
    });
    const who =
      lab.bottlingBatch.wineryId === (await wineryOf('admin@altos.test'))
        ? 'altos'
        : 'cintiviejo';
    const res = await get(who, `/v1/lab-analyses/batch/${lab.bottlingBatchId}`);
    expect(typeof res.body.data.actualAlcoholAbv).toBe('number');
  });

  it('salud: /health/ready informa del worker sin fallar por él', async () => {
    const prefix =
      app.get(ConfigService).get<string>('QUEUE_PREFIX') ??
      DEFAULT_QUEUE_PREFIX;
    const key = workerHeartbeatKey(prefix);
    const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
    try {
      await redis.del(key);
      const down = await get(null, '/v1/health/ready');
      expect(down.body.data).toMatchObject({
        worker: 'down',
        status: 'degraded',
      });

      await redis.set(
        key,
        JSON.stringify({ at: new Date().toISOString() }),
        'PX',
        10_000,
      );
      const up = await get(null, '/v1/health/ready');
      expect(up.body.data).toMatchObject({ worker: 'up', status: 'ok' });

      // /health (healthcheck de la imagen) no depende del worker
      await redis.del(key);
      const health = await get(null, '/v1/health');
      expect(health.body.data).toMatchObject({ status: 'ok', worker: 'down' });
    } finally {
      await redis.del(key).catch(() => undefined);
      redis.disconnect();
    }
  });

  it('cubre al menos un recurso de cada módulo del ERP', () => {
    const templates = [...openapi.covered].map((c) => c.split(' ')[1]);
    for (const expected of [
      '/v1/terroirs/{id}',
      '/v1/harvest-batches/{id}',
      '/v1/fermentation-tanks/{id}',
      '/v1/wine-aging/{id}',
      '/v1/production-batches/{id}',
      '/v1/bottling/{id}',
      '/v1/lab-analyses/batch/{bottlingBatchId}',
      '/v1/traceability/dag/{bottlingBatchId}',
      '/v1/traceability/public/{lotCode}',
    ]) {
      expect(templates).toContain(expected);
    }
  });

  async function wineryOf(email: string): Promise<string | null> {
    const user = await prisma.user.findUniqueOrThrow({
      where: { email },
      include: { memberships: true },
    });
    return user.memberships[0]?.organizationId ?? null;
  }
});
