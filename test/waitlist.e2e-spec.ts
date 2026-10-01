import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { randomInt } from 'crypto';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { WAITLIST_CSV_COLUMNS } from '../src/modules/waitlist/waitlist-csv';
import { WaitlistService } from '../src/modules/waitlist/waitlist.service';
import { deleteIdentityData } from './helpers/identity';
import { loadOpenApiValidator } from './helpers/openapi-validator';
import {
  createActiveWinery,
  createMember,
  platformStaff,
  staffToken,
} from './helpers/staff-session';

// Detrás de un proxy (como nginx): la IP del cliente llega en X-Forwarded-For
process.env.TRUST_PROXY = '1';

/**
 * Lista de espera (contrato O1b) con Postgres y Redis reales: alta de
 * consumidor y de bodega, validaciones por campo, duplicado, campo trampa,
 * límites (429 con Retry-After), captcha opcional, totales públicos, back
 * office (lista, orígenes, estado y notas, exportación CSV) con sus permisos,
 * bitácora y tablero. Las respuestas se validan contra `openapi.json`.
 */
const run = `wl${Date.now()}`;
const emailTag = `_${run}@test.bo`;
const email = (name: string) => `${name}${emailTag}`;
/** Origen único de esta ejecución (las suites e2e comparten la base). */
const SOURCE = `e2e-${run}`;
const ipBase = `10.${randomInt(1, 250)}.${randomInt(1, 250)}`;
let ipSeq = 1;
const nextIp = () => `${ipBase}.${ipSeq++}`;

const LIMIT_ENV = [
  'WAITLIST_LIMIT_IP_MINUTE',
  'WAITLIST_LIMIT_IP_HOUR',
  'WAITLIST_LIMIT_EMAIL_HOUR',
  'WAITLIST_CAPTCHA_REQUIRED',
] as const;

type Res = request.Response;
type Entry = Record<string, unknown> & {
  id: string;
  email: string;
  position: number;
};

describe('Lista de espera · contrato O1b (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const openapi = loadOpenApiValidator();
  const tokens: Record<string, string> = {};
  let opsName: string;
  let wineryId: string;
  const savedEnv = Object.fromEntries(
    [...LIMIT_ENV, 'TRUST_PROXY'].map((key) => [key, process.env[key]]),
  );

  const http = () => request(app.getHttpServer());
  const as = (who: string) => ({
    Authorization: `Bearer ${tokens[who]}`,
    'X-Client-App': 'BACKOFFICE',
  });
  const consumer = (name: string, extra: Record<string, unknown> = {}) => ({
    type: 'CONSUMER',
    fullName: `Persona ${name}`,
    email: email(name),
    isAdult: true,
    consent: true,
    source: SOURCE,
    ...extra,
  });
  const winery = (name: string, extra: Record<string, unknown> = {}) => ({
    type: 'WINERY',
    fullName: `Contacto ${name}`,
    email: email(name),
    wineryName: `Bodega ${name} ${run}`,
    consent: true,
    source: SOURCE,
    ...extra,
  });
  const join = (body: Record<string, unknown>, ip = nextIp()) =>
    http()
      .post('/v1/public/waitlist')
      .set('X-Forwarded-For', ip)
      .set('X-Client-App', 'PUBLIC')
      .set('User-Agent', 'e2e-waitlist/1.0')
      .send(body);
  const fieldsOf = (res: Res) => [
    ...new Set(
      (res.body.error.details as { field: string }[]).map((d) => d.field),
    ),
  ];
  const lastPosition = async (type: 'CONSUMER' | 'WINERY') =>
    (await prisma.waitlistCounter.findUnique({ where: { type } }))
      ?.lastPosition ?? 0;
  const auditOf = (action: string, resourceId?: string) =>
    prisma.auditEvent.findFirst({
      where: {
        action,
        resourceType: 'waitlist_entry',
        ...(resourceId ? { resourceId } : {}),
      },
      orderBy: { seq: 'desc' },
    });

  beforeAll(async () => {
    for (const key of LIMIT_ENV) delete process.env[key];
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    for (const [key, role] of [
      ['admin', 'ADMIN'],
      ['ops', 'OPERATIONS'],
      ['support', 'SUPPORT'],
    ] as const) {
      const staff = await platformStaff(app, prisma, {
        email: email(`staff-${key}`),
        fullName: `Personal ${key} ${run}`,
        role,
      });
      tokens[key] = staff.token;
      if (key === 'ops') opsName = staff.user.fullName;
    }
    wineryId = await createActiveWinery(prisma, {
      name: `Bodega WL ${run}`,
      taxId: `WL${Date.now().toString().slice(-9)}`,
    });
    const owner = await createMember(prisma, {
      email: email('owner'),
      fullName: `Dueña ${run}`,
      organizationId: wineryId,
      role: 'OWNER',
    });
    tokens.owner = await staffToken(app, {
      userId: owner.user.id,
      email: owner.user.email,
      organizationId: wineryId,
      organizationType: 'WINERY',
      role: 'OWNER',
    });
  });

  afterAll(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (prisma) {
      await prisma.waitlistEntry.deleteMany({
        where: { email: { endsWith: emailTag } },
      });
      await deleteIdentityData(prisma, {
        emailContains: emailTag,
        wineryIds: wineryId ? [wineryId] : [],
      });
      await prisma.user.deleteMany({
        where: { email: { endsWith: emailTag } },
      });
      if (wineryId) {
        await prisma.winery.deleteMany({ where: { id: wineryId } });
      }
    }
    await app?.close();
  });

  // ─── Inscripción pública (§1) ────────────────────────────────────────────

  describe('inscripción pública', () => {
    it('consumidor: 201 con su posición; guarda lo declarado, la IP real y la bitácora sin datos personales', async () => {
      const before = await lastPosition('CONSUMER');
      const ip = nextIp();
      const res = await join(
        consumer('lucia', {
          email: `  Lucia${emailTag.toUpperCase()} `,
          phone: '+591 72110022',
          city: 'Tarija',
          interest: 'BOTH',
          locale: 'en',
          source: SOURCE.toUpperCase(),
        }),
        ip,
      ).expect(201);
      openapi.expectResponse('post', '/v1/public/waitlist', res);
      expect(res.body.data).toEqual({ type: 'CONSUMER', position: before + 1 });

      const row = await prisma.waitlistEntry.findUniqueOrThrow({
        where: { type_email: { type: 'CONSUMER', email: email('lucia') } },
      });
      expect(row).toMatchObject({
        position: before + 1,
        status: 'NEW',
        fullName: 'Persona lucia',
        phone: '+591 72110022',
        city: 'Tarija',
        interest: 'BOTH',
        isAdult: true,
        locale: 'en',
        source: SOURCE,
        ip,
        userAgent: 'e2e-waitlist/1.0',
      });
      expect(row.consentAt.getTime()).toBeGreaterThan(Date.now() - 60_000);

      const audit = await auditOf('WAITLIST_JOINED', row.id);
      expect(audit).toMatchObject({
        sourceApp: 'PUBLIC',
        sourceIp: ip,
        actorUserId: null,
        organizationId: null,
        before: null,
        after: { type: 'CONSUMER', source: SOURCE },
      });
      expect(
        JSON.stringify([audit?.before, audit?.after, audit?.reason]),
      ).not.toContain('lucia');
    });

    it('bodega: 201 con la posición de su propio tipo', async () => {
      const before = await lastPosition('WINERY');
      const consumersBefore = await lastPosition('CONSUMER');
      const res = await join(
        winery('camargo', {
          region: 'Valle de Cinti',
          produces: 'SINGANI',
          message: 'Nos interesa la trazabilidad',
        }),
      ).expect(201);
      openapi.expectResponse('post', '/v1/public/waitlist', res);
      expect(res.body.data).toEqual({ type: 'WINERY', position: before + 1 });
      expect(await lastPosition('CONSUMER')).toBe(consumersBefore);

      // El mismo correo puede estar además en la lista de consumidores
      const also = await join(consumer('camargo')).expect(201);
      expect(also.body.data).toEqual({
        type: 'CONSUMER',
        position: consumersBefore + 1,
      });
    });

    it('validación → 422 con el campo: isAdult, consent, wineryName y correo', async () => {
      const cases: [Record<string, unknown>, string][] = [
        [consumer('v1', { isAdult: false }), 'isAdult'],
        [consumer('v2', { isAdult: undefined }), 'isAdult'],
        [consumer('v3', { consent: false }), 'consent'],
        [winery('v4', { consent: undefined }), 'consent'],
        [winery('v5', { wineryName: undefined }), 'wineryName'],
        [winery('v6', { wineryName: ' ' }), 'wineryName'],
        [consumer('v7', { email: 'no-es-correo' }), 'email'],
        [consumer('v8', { phone: 'abc' }), 'phone'],
        [consumer('v9', { source: 'con espacios' }), 'source'],
      ];
      const before = await prisma.waitlistEntry.count();
      for (const [body, field] of cases) {
        const res = await join(body).expect(422);
        openapi.expectResponse('post', '/v1/public/waitlist', res);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(fieldsOf(res)).toEqual([field]);
      }
      const several = await join({ type: 'CONSUMER' }).expect(422);
      expect(fieldsOf(several).sort()).toEqual([
        'consent',
        'email',
        'fullName',
        'isAdult',
      ]);
      expect(several.body.error.details[0].message).toMatch(/[a-záéíóúñ]/);
      expect(await prisma.waitlistEntry.count()).toBe(before);
    });

    it('correo ya inscrito: mismo 201 con su posición; no se duplica ni se pisan sus datos', async () => {
      const first = await join(consumer('dup', { city: 'Tarija' })).expect(201);
      const counter = await lastPosition('CONSUMER');
      const again = await join(
        consumer('dup', {
          email: ` DUP${emailTag} `,
          fullName: 'Otro Nombre',
          city: 'Sucre',
          phone: '70012345',
          source: 'otro-origen',
        }),
      ).expect(201);
      openapi.expectResponse('post', '/v1/public/waitlist', again);
      expect(again.body.data).toEqual(first.body.data);
      expect(await lastPosition('CONSUMER')).toBe(counter);

      const rows = await prisma.waitlistEntry.findMany({
        where: { email: email('dup') },
      });
      expect(rows).toHaveLength(1);
      // Solo se completa lo que estaba vacío (el teléfono)
      expect(rows[0]).toMatchObject({
        fullName: 'Persona dup',
        city: 'Tarija',
        phone: '70012345',
        source: SOURCE,
      });
      expect(
        await prisma.auditEvent.count({
          where: { action: 'WAITLIST_JOINED', resourceId: rows[0].id },
        }),
      ).toBe(1);
    });

    it('a la vez: posiciones consecutivas sin repetir, y un solo registro por correo', async () => {
      const before = await lastPosition('WINERY');
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => join(winery(`par${i}`))),
      );
      expect(results.map((r) => r.status)).toEqual(Array(8).fill(201));
      expect(
        results
          .map((r) => r.body.data.position as number)
          .sort((a, b) => a - b),
      ).toEqual(Array.from({ length: 8 }, (_, i) => before + 1 + i));

      const same = await Promise.all(
        Array.from({ length: 3 }, () => join(winery('mismo'))),
      );
      expect(same.map((r) => r.status)).toEqual([201, 201, 201]);
      expect(new Set(same.map((r) => r.body.data.position)).size).toBe(1);
      expect(
        await prisma.waitlistEntry.count({ where: { email: email('mismo') } }),
      ).toBe(1);
      expect(await lastPosition('WINERY')).toBe(before + 9);
    });

    it('campo trampa relleno: 201 verosímil sin guardar nada', async () => {
      const counter = await lastPosition('CONSUMER');
      const res = await join(
        consumer('bot', { website: 'https://spam.example' }),
      ).expect(201);
      openapi.expectResponse('post', '/v1/public/waitlist', res);
      expect(res.body.data).toEqual({
        type: 'CONSUMER',
        position: counter + 1,
      });
      expect(
        await prisma.waitlistEntry.count({ where: { email: email('bot') } }),
      ).toBe(0);
      expect(await lastPosition('CONSUMER')).toBe(counter);
    });

    it('captcha: solo se exige con WAITLIST_CAPTCHA_REQUIRED=true', async () => {
      process.env.WAITLIST_CAPTCHA_REQUIRED = 'true';
      try {
        const missing = await join(consumer('captcha')).expect(422);
        openapi.expectResponse('post', '/v1/public/waitlist', missing);
        expect(missing.body.error.code).toBe('CAPTCHA_INVALID');
        expect(fieldsOf(missing)).toEqual(['captchaToken']);
        expect(
          await prisma.waitlistEntry.count({
            where: { email: email('captcha') },
          }),
        ).toBe(0);
        // Con la clave de prueba de Turnstile cualquier token vale
        await join(
          consumer('captcha', { captchaToken: 'XXXX.DUMMY.TOKEN.XXXX' }),
        ).expect(201);
      } finally {
        delete process.env.WAITLIST_CAPTCHA_REQUIRED;
      }
    });
  });

  // ─── Límites (§1) ────────────────────────────────────────────────────────

  describe('límites → 429 con Retry-After', () => {
    const expect429 = (res: Res) => {
      expect(res.status).toBe(429);
      openapi.expectResponse('post', '/v1/public/waitlist', res);
      expect(res.body.error.code).toBe('TOO_MANY_REQUESTS');
      return Number(res.headers['retry-after']);
    };

    it('3 por hora por correo (desde cualquier IP)', async () => {
      const statuses: number[] = [];
      let last: Res | undefined;
      for (let i = 0; i < 4; i++) {
        last = await join(consumer('insistente'));
        statuses.push(last.status);
      }
      expect(statuses).toEqual([201, 201, 201, 429]);
      const retryAfter = expect429(last!);
      expect(retryAfter).toBeGreaterThan(3500);
      expect(retryAfter).toBeLessThanOrEqual(3600);
      // Otro correo no está limitado
      await join(consumer('paciente')).expect(201);
    });

    it('20 por minuto por IP real', async () => {
      const ip = nextIp();
      const statuses: number[] = [];
      let last: Res | undefined;
      for (let i = 0; i < 21; i++) {
        // Inválidas a propósito: el límite cuenta peticiones, no altas
        last = await join({ type: 'CONSUMER' }, ip);
        statuses.push(last.status);
      }
      expect(statuses).toEqual([...Array(20).fill(422), 429]);
      const retryAfter = expect429(last!);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(60);
      // Otra IP detrás del mismo proxy no está limitada
      await join(consumer('otra-red')).expect(201);
    });

    it('por hora por IP real, configurable por entorno', async () => {
      process.env.WAITLIST_LIMIT_IP_HOUR = '2';
      try {
        const ip = nextIp();
        await join(consumer('hora1'), ip).expect(201);
        await join(consumer('hora2'), ip).expect(201);
        const blocked = await join(consumer('hora3'), ip);
        const retryAfter = expect429(blocked);
        expect(retryAfter).toBeGreaterThan(3500);
        expect(
          await prisma.waitlistEntry.count({
            where: { email: email('hora3') },
          }),
        ).toBe(0);
        await join(consumer('hora3')).expect(201);
      } finally {
        delete process.env.WAITLIST_LIMIT_IP_HOUR;
      }
    });
  });

  // ─── Totales públicos (§1) ───────────────────────────────────────────────

  it('totales públicos: `{ consumers, wineries }`, sin sesión y con caché', async () => {
    const [consumers, wineries] = await Promise.all([
      prisma.waitlistEntry.count({ where: { type: 'CONSUMER' } }),
      prisma.waitlistEntry.count({ where: { type: 'WINERY' } }),
    ]);
    const res = await http().get('/v1/public/waitlist/stats').expect(200);
    openapi.expectResponse('get', '/v1/public/waitlist/stats', res);
    expect(res.body.data).toEqual({ consumers, wineries });
    expect(res.headers['cache-control']).toBe('public, max-age=60');

    // Un alta nueva se refleja al momento (la caché se vacía)
    await join(winery('stats')).expect(201);
    const after = await http().get('/v1/public/waitlist/stats').expect(200);
    expect(after.body.data).toEqual({ consumers, wineries: wineries + 1 });
  });

  // ─── Back office (§2) ────────────────────────────────────────────────────

  describe('back office', () => {
    const list = (query: string, who = 'support') =>
      http().get(`/v1/platform/waitlist?${query}`).set(as(who));

    it('lista: soporte lee; filtros, búsqueda y página; sin IP ni agente de usuario', async () => {
      const all = await list(`source=${SOURCE}&limit=100`).expect(200);
      openapi.expectResponse('get', '/v1/platform/waitlist', all);
      const items = all.body.data.items as Entry[];
      const mine = await prisma.waitlistEntry.count({
        where: { source: SOURCE },
      });
      expect(all.body.data).toMatchObject({
        total: mine,
        limit: 100,
        offset: 0,
      });
      expect(items).toHaveLength(mine);
      // Más reciente primero
      const dates = items.map((e) => e.createdAt as string);
      expect(dates).toEqual([...dates].sort().reverse());
      for (const item of items) {
        expect(item).not.toHaveProperty('ip');
        expect(item).not.toHaveProperty('userAgent');
      }
      expect(items.find((e) => e.email === email('lucia'))).toMatchObject({
        type: 'CONSUMER',
        status: 'NEW',
        fullName: 'Persona lucia',
        phone: '+591 72110022',
        city: 'Tarija',
        interest: 'BOTH',
        wineryName: null,
        locale: 'en',
        source: SOURCE,
        contactedAt: null,
        contactedBy: null,
        notes: null,
      });

      const wineries = await list(`source=${SOURCE}&type=WINERY&limit=100`);
      expect(
        (wineries.body.data.items as Entry[]).every((e) => e.type === 'WINERY'),
      ).toBe(true);
      expect(wineries.body.data.total).toBe(
        await prisma.waitlistEntry.count({
          where: { source: SOURCE, type: 'WINERY' },
        }),
      );

      // Búsqueda: por bodega, por correo y por teléfono
      const byWinery = await list(
        `q=${encodeURIComponent(`bodega camargo ${run}`)}`,
      ).expect(200);
      expect((byWinery.body.data.items as Entry[]).map((e) => e.email)).toEqual(
        [email('camargo')],
      );
      const byEmail = await list(
        `q=${encodeURIComponent(email('LUCIA'))}&type=CONSUMER`,
      ).expect(200);
      expect(byEmail.body.data.total).toBe(1);
      const byPhone = await list(
        `source=${SOURCE}&q=${encodeURIComponent('72110022')}`,
      ).expect(200);
      expect((byPhone.body.data.items as Entry[]).map((e) => e.email)).toEqual([
        email('lucia'),
      ]);

      // Fechas y página
      const today = new Date().toISOString().slice(0, 10);
      const inRange = await list(
        `source=${SOURCE}&from=${today}&to=${today}&limit=2&offset=1`,
      ).expect(200);
      openapi.expectResponse('get', '/v1/platform/waitlist', inRange);
      expect(inRange.body.data).toMatchObject({
        total: mine,
        limit: 2,
        offset: 1,
      });
      expect((inRange.body.data.items as Entry[]).map((e) => e.id)).toEqual(
        items.slice(1, 3).map((e) => e.id),
      );
      const past = await list(`source=${SOURCE}&to=2020-01-01`).expect(200);
      expect(past.body.data.total).toBe(0);

      const invalid = await list('status=DONE&from=ayer&limit=500').expect(422);
      openapi.expectResponse('get', '/v1/platform/waitlist', invalid);
      expect(fieldsOf(invalid).sort()).toEqual(['from', 'limit', 'status']);
    });

    it('orígenes: cada origen con su número de inscritos', async () => {
      await join(consumer('sin-origen', { source: undefined })).expect(201);
      const res = await http()
        .get('/v1/platform/waitlist/sources')
        .set(as('support'))
        .expect(200);
      openapi.expectResponse('get', '/v1/platform/waitlist/sources', res);
      const sources = res.body.data as {
        source: string | null;
        count: number;
      }[];
      expect(sources.find((s) => s.source === SOURCE)?.count).toBe(
        await prisma.waitlistEntry.count({ where: { source: SOURCE } }),
      );
      expect(
        sources.find((s) => s.source === null)?.count,
      ).toBeGreaterThanOrEqual(1);
      expect(sources.find((s) => s.source === 'otro-origen')).toBeUndefined();

      const onlyWineries = await http()
        .get('/v1/platform/waitlist/sources?type=WINERY')
        .set(as('ops'))
        .expect(200);
      expect(
        (onlyWineries.body.data as { source: string; count: number }[]).find(
          (s) => s.source === SOURCE,
        )?.count,
      ).toBe(
        await prisma.waitlistEntry.count({
          where: { source: SOURCE, type: 'WINERY' },
        }),
      );
    });

    it('estado y notas: operaciones marca contactado; soporte no edita', async () => {
      const entry = await prisma.waitlistEntry.findUniqueOrThrow({
        where: { type_email: { type: 'WINERY', email: email('camargo') } },
      });
      const path = `/v1/platform/waitlist/${entry.id}`;

      const forbidden = await http()
        .patch(path)
        .set(as('support'))
        .send({ status: 'CONTACTED' })
        .expect(403);
      openapi.expectResponse('patch', path, forbidden);

      const contacted = await http()
        .patch(path)
        .set(as('ops'))
        .send({ status: 'CONTACTED', notes: '  Le escribimos por WhatsApp ' })
        .expect(200);
      openapi.expectResponse('patch', path, contacted);
      expect(contacted.body.data).toMatchObject({
        id: entry.id,
        status: 'CONTACTED',
        contactedBy: opsName,
        notes: 'Le escribimos por WhatsApp',
      });
      expect(
        new Date(contacted.body.data.contactedAt as string).getTime(),
      ).toBeGreaterThan(Date.now() - 60_000);

      const audit = await auditOf('WAITLIST_STATUS_CHANGED', entry.id);
      expect(audit).toMatchObject({
        sourceApp: 'BACKOFFICE',
        actorFullName: opsName,
        actorRole: 'OPERATIONS',
        actorViaPlatform: true,
        before: { status: 'NEW' },
        after: { status: 'CONTACTED', notesChanged: true },
      });

      // Filtro por estado
      const onlyContacted = await http()
        .get(`/v1/platform/waitlist?source=${SOURCE}&status=CONTACTED`)
        .set(as('support'))
        .expect(200);
      expect(
        (onlyContacted.body.data.items as Entry[]).map((e) => e.id),
      ).toEqual([entry.id]);

      // Sin cambios: ni escritura ni bitácora
      const events = () =>
        prisma.auditEvent.count({
          where: { action: 'WAITLIST_STATUS_CHANGED', resourceId: entry.id },
        });
      const before = await events();
      await http()
        .patch(path)
        .set(as('admin'))
        .send({ status: 'CONTACTED' })
        .expect(200);
      expect(await events()).toBe(before);

      // Borrar las notas y descartar; volver a NEW borra el contacto
      const discarded = await http()
        .patch(path)
        .set(as('admin'))
        .send({ status: 'DISCARDED', notes: null })
        .expect(200);
      expect(discarded.body.data).toMatchObject({
        status: 'DISCARDED',
        notes: null,
        contactedBy: opsName,
      });
      const reset = await http()
        .patch(path)
        .set(as('admin'))
        .send({ status: 'NEW' })
        .expect(200);
      openapi.expectResponse('patch', path, reset);
      expect(reset.body.data).toMatchObject({
        status: 'NEW',
        contactedAt: null,
        contactedBy: null,
      });

      const tooLong = await http()
        .patch(path)
        .set(as('ops'))
        .send({ notes: 'x'.repeat(1001) })
        .expect(422);
      openapi.expectResponse('patch', path, tooLong);
      expect(fieldsOf(tooLong)).toEqual(['notes']);
      await http()
        .patch(path)
        .set(as('ops'))
        .send({ status: 'ARCHIVED' })
        .expect(422);
      const missing = await http()
        .patch('/v1/platform/waitlist/00000000-0000-4000-8000-00000000dead')
        .set(as('ops'))
        .send({ status: 'CONTACTED' })
        .expect(404);
      openapi.expectResponse('patch', path, missing);
      expect(missing.body.error.code).toBe('NOT_FOUND');
    });

    it('exportación CSV: administración y operaciones; soporte no; queda en la bitácora', async () => {
      await prisma.waitlistEntry.update({
        where: { type_email: { type: 'CONSUMER', email: email('dup') } },
        data: { fullName: '=HYPERLINK("http://malo")', notes: 'uno, dos' },
      });
      const path = `/v1/platform/waitlist/export?source=${SOURCE}&type=CONSUMER`;
      const forbidden = await http().get(path).set(as('support')).expect(403);
      openapi.expectResponse('get', path, forbidden);

      const expected = await prisma.waitlistEntry.findMany({
        where: { source: SOURCE, type: 'CONSUMER' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const res = await http()
        .get(path)
        .set(as('ops'))
        .buffer(true)
        .parse((response, callback) => {
          let data = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => (data += chunk));
          response.on('end', () => callback(null, data));
        })
        .expect(200);
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(res.headers['content-disposition']).toMatch(
        /^attachment; filename="lista-de-espera-\d{8}-\d{4}\.csv"$/,
      );
      expect(res.headers['x-export-rows']).toBe(String(expected.length));
      const body = res.body as string;
      expect(body.startsWith('﻿')).toBe(true);
      const lines = body.slice(1).split('\r\n').filter(Boolean);
      expect(lines[0]).toBe(WAITLIST_CSV_COLUMNS.join(','));
      expect(lines).toHaveLength(expected.length + 1);
      // En orden de llegada, con el correo de cada fila
      expect(lines.slice(1).map((l) => l.includes('CONSUMER'))).toEqual(
        Array(expected.length).fill(true),
      );
      expected.forEach((row, i) => {
        expect(lines[i + 1]).toContain(row.email);
        expect(lines[i + 1].startsWith(`${row.position},CONSUMER,`)).toBe(true);
      });
      // La fórmula queda neutralizada; comas entrecomilladas
      const dup = lines.find((l) => l.includes(email('dup')))!;
      expect(dup).toContain(`"'=HYPERLINK(""http://malo"")"`);
      expect(dup).toContain('"uno, dos"');
      // Sin IP ni agente de usuario
      expect(lines[0]).not.toMatch(/ip|userAgent/);
      expect(body).not.toContain(ipBase);
      expect(body).not.toContain('e2e-waitlist');

      const audit = await auditOf('WAITLIST_EXPORTED');
      expect(audit).toMatchObject({
        resourceId: null,
        actorFullName: opsName,
        sourceApp: 'BACKOFFICE',
        after: {
          rows: expected.length,
          filters: {
            type: 'CONSUMER',
            status: null,
            source: SOURCE,
            from: null,
            to: null,
            searched: false,
          },
        },
      });

      await http()
        .get('/v1/platform/waitlist/export?from=ayer')
        .set(as('admin'))
        .expect(422);
      const count = jest
        .spyOn(app.get(WaitlistService), 'count')
        .mockResolvedValueOnce(50_001);
      const tooLarge = await http()
        .get('/v1/platform/waitlist/export')
        .set(as('admin'))
        .expect(422);
      count.mockRestore();
      openapi.expectResponse('get', path, tooLarge);
      expect(tooLarge.body.error.code).toBe('WAITLIST_EXPORT_TOO_LARGE');
    });

    it('permisos: sin sesión 401; una bodega 403 en todas las rutas', async () => {
      const id = '00000000-0000-4000-8000-00000000dead';
      const routes: ['get' | 'patch', string][] = [
        ['get', '/v1/platform/waitlist'],
        ['get', '/v1/platform/waitlist/sources'],
        ['get', '/v1/platform/waitlist/export'],
        ['patch', `/v1/platform/waitlist/${id}`],
      ];
      for (const [method, path] of routes) {
        const anonymous = await http()[method](path).expect(401);
        openapi.expectResponse(method, path, anonymous);
        await http()[method](path).set(as('owner')).expect(403);
      }
      // Soporte lee la lista y los orígenes, pero no exporta ni edita
      await http().get(routes[0][1]).set(as('support')).expect(200);
      await http().get(routes[1][1]).set(as('support')).expect(200);
      await http().get(routes[2][1]).set(as('support')).expect(403);
      await http()
        .patch(routes[3][1])
        .set(as('support'))
        .send({ status: 'CONTACTED' })
        .expect(403);

      const matrix = await http()
        .get('/v1/platform/permissions')
        .set(as('support'))
        .expect(200);
      expect(
        matrix.body.data.capabilities.find(
          (c: { key: string }) => c.key === 'waitlist',
        ),
      ).toMatchObject({
        label: 'Lista de espera',
        roles: {
          SUPERADMIN: 'FULL',
          ADMIN: 'FULL',
          OPERATIONS: 'FULL',
          SUPPORT: 'READ',
          OWNER: 'NONE',
        },
      });
    });

    it('tablero: bloque `waitlist` con los totales y las altas de las últimas 24 h', async () => {
      const [consumers, wineries, last24h] = await Promise.all([
        prisma.waitlistEntry.count({ where: { type: 'CONSUMER' } }),
        prisma.waitlistEntry.count({ where: { type: 'WINERY' } }),
        prisma.waitlistEntry.count({
          where: { createdAt: { gte: new Date(Date.now() - 86_400_000) } },
        }),
      ]);
      const res = await http()
        .get('/v1/platform/dashboard')
        .set(as('support'))
        .expect(200);
      openapi.expectResponse('get', '/v1/platform/dashboard', res);
      expect(res.body.data.waitlist).toEqual({ consumers, wineries, last24h });
      expect(res.body.data.waitlist.last24h).toBeGreaterThanOrEqual(10);
    });
  });
});
