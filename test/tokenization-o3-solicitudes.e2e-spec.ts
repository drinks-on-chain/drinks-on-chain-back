import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  MembershipRoleEnum,
  PrismaClient,
  WineryStatusEnum,
} from '@prisma/client';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PLATFORM_ORGANIZATION_ID } from '../src/modules/organizations/organization.constants';
import {
  confirmMintInDatabase,
  seedChainIdentity,
  type SeededChainIdentity,
} from './helpers/chain-identity';
import { createPlatformUser } from './helpers/identity';
import { loadOpenApiValidator } from './helpers/openapi-validator';
import {
  addWineryMember,
  staffToken,
  wineryWithOwner,
} from './helpers/staff-session';
import { sha256Of, uploadTraceFile } from './helpers/trace-files';

/**
 * Ola 3 · paso 3.3 (O3-BE-1; contrato O3 §5, §6.2, §6.4, §6.5, §8.5 y §14):
 * solicitud de tokenización, bandeja, aprobación (colección + emisión
 * `PENDING` + evento del outbox) y colecciones, **sin red**. La identidad de
 * la bodega y la confirmación de la emisión se siembran en la base como las
 * dejarán los pasos 3.2 y 3.4. En un esquema propio, con todas las
 * migraciones.
 */
process.env.TRUST_PROXY = '1';

const run = `${Date.now()}${randomBytes(3).toString('hex')}`;
const schema = `o3tok_e2e_${run}`;
const originalUrl = process.env.DATABASE_URL;

function urlWithSchema(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('schema', name);
  return parsed.toString();
}
const databaseUrl = urlWithSchema(process.env.DATABASE_URL ?? '', schema);
const prismaCli = require.resolve('prisma/build/index.js');

type Who =
  | 'admin'
  | 'operations'
  | 'support'
  | 'owner'
  | 'enologist'
  | 'accountant'
  | 'operator'
  | 'otherOwner'
  | 'nobody';

/** PNG mínimo: lo que la subida reconoce por su firma de bytes. */
const png = (label: string) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(`imagen de prueba ${label} ${run}`),
  ]);

const DESCRIPTION =
  'Singani de altura del Valle de Cinti, destilado en alambique de cobre y reposado.';
const REASON = { reason: 'Prueba del paso 3.3 de la Ola 3' };

describe('Ola 3 · solicitudes de tokenización y colecciones sin red (e2e)', () => {
  const openapi = loadOpenApiValidator();
  let prisma: PrismaClient;
  let app: INestApplication;
  let ipSeq = 1;
  const nextIp = () => `10.241.${ipSeq % 250}.${(ipSeq++ % 250) + 1}`;
  const tokens: Record<Who, string> = {
    admin: '',
    operations: '',
    support: '',
    owner: '',
    enologist: '',
    accountant: '',
    operator: '',
    otherOwner: '',
    nobody: '',
  };
  const emails: Partial<Record<Who, string>> = {};
  let WINERY = '';
  let OWNER_ID = '';
  let OTHER_WINERY = '';
  let identity: SeededChainIdentity;
  const SLUG = `cinti-e2e-${run}`;
  const COLLECTION_NAME = `Singani Preventa ${run}`;

  // Ids que se van encadenando entre pruebas
  let LOT = '';
  let REQUEST = '';
  let COLLECTION = '';
  let MINT = '';
  let COVER_KEY = '';
  let COVER_IMAGE_ID = '';
  const COVER = png('portada');

  const http = () => request(app.getHttpServer());

  function call(
    method: 'get' | 'post' | 'patch',
    path: string,
    who: Who,
    options: { body?: object; key?: string | null } = {},
  ) {
    const req = http()[method](path).set('X-Forwarded-For', nextIp());
    if (tokens[who]) req.set('Authorization', `Bearer ${tokens[who]}`);
    if (options.key) req.set('Idempotency-Key', options.key);
    return method === 'get' ? req : req.send(options.body ?? {});
  }
  /** `POST` con una `Idempotency-Key` nueva. */
  const post = (path: string, who: Who, body: object = {}) =>
    call('post', path, who, { body, key: randomUUID() });
  const error = (res: request.Response) => ({
    status: res.status,
    code: res.body.error?.code,
  });

  async function newLot(
    who: Who,
    name: string,
    estimatedBottles: number | null = 3000,
  ): Promise<string> {
    const res = await call('post', '/v1/lots', who, {
      body: {
        name,
        harvestYear: new Date().getUTCFullYear(),
        productType: 'SINGANI',
        ...(estimatedBottles !== null && { estimatedBottles }),
        plannedFormatCl: 75,
        targetAbvPercent: 40,
      },
    }).expect(201);
    return res.body.data.id as string;
  }

  const commercial = (name: string, key: string | null = COVER_KEY) => ({
    name,
    description: DESCRIPTION,
    ...(key && {
      imageKeys: [{ key, alt: 'Botella sobre una barrica', isCover: true }],
    }),
  });

  /** Solicitud enviada por la dueña y tomada por operaciones. */
  async function requestInReview(
    lotId: string,
    body: object,
    who: Who = 'owner',
  ): Promise<string> {
    const created = await post(
      `/v1/lots/${lotId}/tokenization-requests`,
      who,
      body,
    ).expect(201);
    const id = created.body.data.id as string;
    await post(
      `/v1/platform/tokenization-requests/${id}/take`,
      'operations',
    ).expect(200);
    return id;
  }

  const mails = (template: string, to: string) =>
    prisma.emailMessage.findMany({
      where: { template, toAddress: to },
      orderBy: { createdAt: 'asc' },
    });
  const audits = (action: string, resourceId: string) =>
    prisma.auditEvent.findMany({ where: { action, resourceId } });
  const outbox = (eventType: string, aggregateId: string) =>
    prisma.outboxEvent.findMany({ where: { eventType, aggregateId } });

  async function relogin(who: Who, userId: string, wineryId: string) {
    tokens[who] = await staffToken(app, {
      userId,
      email: emails[who] as string,
      organizationId: wineryId,
      organizationType: 'WINERY',
      role: MembershipRoleEnum.OWNER,
    });
  }

  beforeAll(async () => {
    const migrated = spawnSync(
      process.execPath,
      [prismaCli, 'migrate', 'deploy'],
      {
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK: '1',
        },
        encoding: 'utf8',
      },
    );
    expect({
      status: migrated.status,
      output: migrated.status === 0 ? '' : migrated.stderr,
    }).toEqual({ status: 0, output: '' });

    process.env.DATABASE_URL = databaseUrl;
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    const staff = async (who: Who, role: MembershipRoleEnum) => {
      emails[who] = `${who}-o3tok-${run}@drinksonchain.test`;
      const user = await createPlatformUser(prisma, {
        email: emails[who],
        password: 'Plataforma-o3tok-123',
        fullName: `Personal ${who}`,
        role,
      });
      tokens[who] = await staffToken(app, {
        userId: user.id,
        email: user.email,
        organizationId: PLATFORM_ORGANIZATION_ID,
        organizationType: 'PLATFORM',
        role,
      });
    };
    await staff('admin', MembershipRoleEnum.ADMIN);
    await staff('operations', MembershipRoleEnum.OPERATIONS);
    await staff('support', MembershipRoleEnum.SUPPORT);

    const winery = async (who: Who, label: string) => {
      emails[who] = `${who}-o3tok-${run}@e2e.test`;
      const { wineryId, ownerId } = await wineryWithOwner(app, {
        name: `${label} ${run}`,
        email: emails[who],
        password: 'Solicitudes-o3-123!',
      });
      await relogin(who, ownerId, wineryId);
      return { wineryId, ownerId };
    };
    ({ wineryId: WINERY, ownerId: OWNER_ID } = await winery(
      'owner',
      'Destilería de las Solicitudes',
    ));
    ({ wineryId: OTHER_WINERY } = await winery(
      'otherOwner',
      'Bodega Vecina de las Solicitudes',
    ));
    await prisma.winery.update({ where: { id: WINERY }, data: { slug: SLUG } });
    for (const [who, role] of [
      ['enologist', 'ENOLOGIST'],
      ['accountant', 'ACCOUNTANT'],
      ['operator', 'OPERATOR'],
    ] as const) {
      emails[who] = `${who}-o3tok-${run}@e2e.test`;
      const { userId } = await addWineryMember(app, {
        wineryId: WINERY,
        role,
        email: emails[who],
        fullName: `Miembro ${role}`,
      });
      tokens[who] = await staffToken(app, {
        userId,
        email: emails[who],
        organizationId: WINERY,
        organizationType: 'WINERY',
        role: MembershipRoleEnum[role],
      });
    }
    // Identidad en la red lista (lo que deja el paso 3.2); la bodega vecina no la tiene
    identity = await seedChainIdentity(prisma, {
      wineryId: WINERY,
      winerySlug: SLUG,
    });
    COVER_KEY = await uploadTraceFile(app, tokens.owner, {
      folder: 'labels',
      file: COVER,
      name: 'portada.png',
      ip: nextIp(),
    });
    LOT = await newLot('owner', 'Singani Preventa de las solicitudes');
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

  // ───────────────────────────────────────────────────────────────────────────
  describe('estado de tokenización del lote y envío (§5.2, §5.3)', () => {
    it('GET /v1/lots/{id}/tokenization: tokenizable, con el límite de la estimación', async () => {
      const res = await call('get', `/v1/lots/${LOT}/tokenization`, 'owner');
      expect(res.status).toBe(200);
      openapi.expectResponse('get', `/v1/lots/${LOT}/tokenization`, res);
      expect(res.body.data).toMatchObject({
        lotId: LOT,
        tokenizable: true,
        blockers: [],
        limits: {
          basis: 'ESTIMATE',
          estimatedBottles: 3000,
          bottles: null,
          authorizedQuota: 0,
          pendingQuantity: 0,
          maxQuantity: 3000,
        },
        approvalRequired: true,
        chainIdentity: { status: 'ACTIVE' },
        openRequest: null,
        collection: null,
        requests: [],
      });
      // Enología y contabilidad leen; operación de bodega, no (§10)
      expect(
        (await call('get', `/v1/lots/${LOT}/tokenization`, 'enologist')).status,
      ).toBe(200);
      expect(
        (await call('get', `/v1/lots/${LOT}/tokenization`, 'operator')).status,
      ).toBe(403);
    });

    it('cuota mayor que la estimación → 422 TOK_QUOTA_EXCEEDS_ESTIMATE con expected, actual y maxQuantity', async () => {
      const res = await post(`/v1/lots/${LOT}/tokenization-requests`, 'owner', {
        quantity: 3001,
        confirm: true,
      });
      expect(error(res)).toEqual({
        status: 422,
        code: 'TOK_QUOTA_EXCEEDS_ESTIMATE',
      });
      openapi.expectResponse(
        'post',
        `/v1/lots/${LOT}/tokenization-requests`,
        res,
      );
      expect(res.body.error.details[0]).toMatchObject({
        field: 'quantity',
        code: 'TOK_QUOTA_EXCEEDS_ESTIMATE',
        expected: 3000,
        actual: 3001,
        meta: { maxQuantity: 3000 },
      });
      expect(res.body.error.details[0].message).toContain('3.000');
    });

    it('la enóloga intenta autorizar → 403', async () => {
      const res = await post(
        `/v1/lots/${LOT}/tokenization-requests`,
        'enologist',
        { quantity: 100, confirm: true },
      );
      expect(res.status).toBe(403);
    });

    it('una imagen que no es de la bodega o no existe → 422 en su campo', async () => {
      const res = await post(`/v1/lots/${LOT}/tokenization-requests`, 'owner', {
        quantity: 100,
        confirm: true,
        commercial: commercial(
          COLLECTION_NAME,
          `org/${OTHER_WINERY}/labels/2026/10/${randomUUID()}.png`,
        ),
      });
      expect(error(res)).toEqual({ status: 422, code: 'VALIDATION_ERROR' });
      expect(res.body.error.details[0].field).toBe(
        'commercial.imageKeys.0.key',
      );
    });

    it('la dueña autoriza 100 botellas → 201 SUBMITTED, con correo, bitácora, línea de tiempo y outbox', async () => {
      const key = randomUUID();
      const body = {
        quantity: 100,
        commercial: commercial(COLLECTION_NAME),
        notes: 'Primera preventa de la bodega',
        confirm: true,
      };
      const res = await call(
        'post',
        `/v1/lots/${LOT}/tokenization-requests`,
        'owner',
        { body, key },
      );
      expect(res.status).toBe(201);
      openapi.expectResponse(
        'post',
        `/v1/lots/${LOT}/tokenization-requests`,
        res,
      );
      REQUEST = res.body.data.id;
      expect(res.body.data).toMatchObject({
        wineryId: WINERY,
        lotId: LOT,
        kind: 'INITIAL',
        status: 'SUBMITTED',
        quantity: 100,
        resultingQuota: 100,
        requiresApproval: true,
        assignee: null,
        collectionId: null,
        price: null,
        wineryNotes: 'Primera preventa de la bodega',
        decision: null,
        withdrawn: null,
        limitsAtSubmission: { basis: 'ESTIMATE', maxQuantity: 3000 },
        commercialDraft: { name: COLLECTION_NAME, tastingNotes: null },
      });
      expect(res.body.data.history).toHaveLength(1);
      expect(res.body.data).not.toHaveProperty('internalNotes');
      expect(res.body.data).not.toHaveProperty('priceSuggestion');

      // Misma clave y mismo cuerpo: la misma respuesta; otro cuerpo: 409
      const replay = await call(
        'post',
        `/v1/lots/${LOT}/tokenization-requests`,
        'owner',
        { body, key },
      );
      expect(replay.status).toBe(201);
      expect(replay.body.data.id).toBe(REQUEST);
      const reused = await call(
        'post',
        `/v1/lots/${LOT}/tokenization-requests`,
        'owner',
        { body: { ...body, quantity: 101 }, key },
      );
      expect(error(reused)).toEqual({
        status: 409,
        code: 'IDEMPOTENCY_KEY_REUSED',
      });

      expect(
        await mails('tokenizacion-recibida', emails.owner as string),
      ).toHaveLength(1);
      expect(
        await mails(
          'tokenizacion-nueva-operaciones',
          emails.operations as string,
        ),
      ).toHaveLength(1);
      expect(await audits('TOKENIZATION_REQUESTED', REQUEST)).toHaveLength(1);
      expect(
        await outbox('tokenization.request_submitted', REQUEST),
      ).toHaveLength(1);
      const events = await prisma.lotEvent.findMany({
        where: { lotId: LOT, type: 'TOKENIZATION_AUTHORIZED' },
      });
      expect(events).toHaveLength(1);
      expect(events[0].visibility).toBe('INTERNAL');
    });

    it('segunda solicitud abierta del lote → 409 TOK_REQUEST_ALREADY_OPEN con el id de la abierta', async () => {
      const res = await post(`/v1/lots/${LOT}/tokenization-requests`, 'owner', {
        quantity: 10,
        confirm: true,
      });
      expect(error(res)).toEqual({
        status: 409,
        code: 'TOK_REQUEST_ALREADY_OPEN',
      });
      expect(res.body.error.details[0].meta).toEqual({ requestId: REQUEST });

      const status = await call('get', `/v1/lots/${LOT}/tokenization`, 'owner');
      openapi.expectResponse('get', `/v1/lots/${LOT}/tokenization`, status);
      expect(status.body.data).toMatchObject({
        tokenizable: false,
        limits: { pendingQuantity: 100, maxQuantity: 2900 },
        openRequest: { id: REQUEST, status: 'SUBMITTED' },
      });
      expect(status.body.data.blockers[0]).toMatchObject({
        code: 'TOK_REQUEST_ALREADY_OPEN',
      });
      expect(status.body.data.requests).toHaveLength(1);
    });

    it('LotSummary.tokenization pasa a REQUESTED', async () => {
      const lot = await call('get', `/v1/lots/${LOT}`, 'owner');
      openapi.expectResponse('get', `/v1/lots/${LOT}`, lot);
      expect(lot.body.data.tokenization).toEqual({
        state: 'REQUESTED',
        quota: 0,
        minted: 0,
        collectionId: null,
      });
    });

    it('solicitud de otra bodega → 404 en lectura y en escritura', async () => {
      for (const [method, path, body] of [
        ['get', `/v1/tokenization-requests/${REQUEST}`, undefined],
        ['patch', `/v1/tokenization-requests/${REQUEST}`, { quantity: 5 }],
        ['post', `/v1/tokenization-requests/${REQUEST}/withdraw`, REASON],
        ['post', `/v1/tokenization-requests/${REQUEST}/resubmit`, {}],
      ] as const) {
        const res = await call(method, path, 'otherOwner', {
          body,
          key: randomUUID(),
        });
        expect({ path, ...error(res) }).toEqual({
          path,
          status: 404,
          code: 'TOK_REQUEST_NOT_FOUND',
        });
        openapi.expectResponse(method, path, res);
      }
      const lot = await call(
        'get',
        `/v1/lots/${LOT}/tokenization`,
        'otherOwner',
      );
      expect(error(lot)).toEqual({ status: 404, code: 'TRC_LOT_NOT_FOUND' });
      const list = await call('get', '/v1/tokenization-requests', 'otherOwner');
      expect(list.body.data).toMatchObject({ items: [], total: 0 });
    });

    it('la bodega lista y lee su solicitud; la plataforma la lee con ?wineryId=', async () => {
      const list = await call(
        'get',
        `/v1/tokenization-requests?status=SUBMITTED&lotId=${LOT}&kind=INITIAL`,
        'accountant',
      );
      expect(list.status).toBe(200);
      openapi.expectResponse('get', '/v1/tokenization-requests', list);
      expect(list.body.data.items.map((i: { id: string }) => i.id)).toEqual([
        REQUEST,
      ]);
      const one = await call(
        'get',
        `/v1/tokenization-requests/${REQUEST}`,
        'enologist',
      );
      openapi.expectResponse(
        'get',
        `/v1/tokenization-requests/${REQUEST}`,
        one,
      );
      expect(one.body.data.submittedBy.role).toBe('OWNER');
      const platform = await call(
        'get',
        `/v1/tokenization-requests?wineryId=${WINERY}`,
        'support',
      );
      expect(platform.body.data.total).toBe(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('bandeja del back office (§5.4)', () => {
    it('la bandeja lista las abiertas por antigüedad; soporte lee pero no toma', async () => {
      const list = await call(
        'get',
        `/v1/platform/tokenization-requests?wineryId=${WINERY}&q=preventa`,
        'support',
      );
      expect(list.status).toBe(200);
      openapi.expectResponse('get', '/v1/platform/tokenization-requests', list);
      expect(list.body.data.items.map((i: { id: string }) => i.id)).toEqual([
        REQUEST,
      ]);
      const take = await post(
        `/v1/platform/tokenization-requests/${REQUEST}/take`,
        'support',
      );
      expect(take.status).toBe(403);
    });

    it('aprobar, pedir cambios o completar sin tomarla → 409 TOK_REQUEST_INVALID_TRANSITION', async () => {
      for (const [method, action, body] of [
        ['post', '/approve', {}],
        ['post', '/request-changes', { message: 'Falta la nota de cata' }],
        ['patch', '', { price: null }],
      ] as const) {
        const res = await call(
          method,
          `/v1/platform/tokenization-requests/${REQUEST}${action}`,
          'operations',
          { body, key: randomUUID() },
        );
        expect({ action, ...error(res) }).toEqual({
          action,
          status: 409,
          code: 'TOK_REQUEST_INVALID_TRANSITION',
        });
        expect(res.body.error.details[0].meta).toMatchObject({
          from: 'SUBMITTED',
        });
      }
    });

    it('operaciones la toma → IN_REVIEW asignada; tomarla otra vez → 409', async () => {
      const path = `/v1/platform/tokenization-requests/${REQUEST}/take`;
      const res = await post(path, 'operations');
      expect(res.status).toBe(200);
      openapi.expectResponse('post', path, res);
      expect(res.body.data).toMatchObject({
        status: 'IN_REVIEW',
        assignee: { fullName: 'Personal operations' },
        internalNotes: [],
        priceSuggestion: { available: false, reason: 'POLICY_UNDEFINED' },
      });
      expect(res.body.data.review).toMatchObject({
        lot: { id: LOT, estimatedBottles: 3000 },
        limits: { maxQuantity: 3000, pendingQuantity: 0, authorizedQuota: 0 },
        chainIdentity: {
          status: 'ACTIVE',
          account: { address: identity.accountAddress },
          contract: { address: identity.contractAddress, paused: false },
        },
        priceSuggestion: { available: false, reason: 'POLICY_UNDEFINED' },
        otherCollectionsOfWinery: [],
        traceability: { dossierStatus: 'OPEN', complianceIssuesOpen: 0 },
      });
      const again = await post(path, 'admin');
      expect(error(again)).toEqual({
        status: 409,
        code: 'TOK_REQUEST_INVALID_TRANSITION',
      });
      expect(again.body.error.details[0].meta).toMatchObject({
        from: 'IN_REVIEW',
        to: 'IN_REVIEW',
      });
      expect(await audits('TOKENIZATION_TAKEN', REQUEST)).toHaveLength(1);
    });

    it('la bodega ya no la edita mientras está en revisión → 409', async () => {
      const res = await call(
        'patch',
        `/v1/tokenization-requests/${REQUEST}`,
        'owner',
        { body: { quantity: 120 } },
      );
      expect(error(res)).toEqual({
        status: 409,
        code: 'TOK_REQUEST_INVALID_TRANSITION',
      });
    });

    it('nota interna: la ve el back office, no la bodega', async () => {
      const path = `/v1/platform/tokenization-requests/${REQUEST}/notes`;
      const res = await post(path, 'operations', {
        text: 'Revisar la fecha estimada de canje',
      });
      expect(res.status).toBe(201);
      openapi.expectResponse('post', path, res);
      expect(res.body.data.internalNotes).toEqual([
        expect.objectContaining({
          text: 'Revisar la fecha estimada de canje',
          by: 'Personal operations',
        }),
      ]);
      const erp = await call(
        'get',
        `/v1/tokenization-requests/${REQUEST}`,
        'owner',
      );
      expect(JSON.stringify(erp.body.data)).not.toContain(
        'fecha estimada de canje',
      );
    });

    it('pedir cambios → CHANGES_REQUESTED, correo al dueño con el mensaje y marca del lote', async () => {
      const path = `/v1/platform/tokenization-requests/${REQUEST}/request-changes`;
      const res = await post(path, 'operations', {
        message: 'Falta la nota de cata',
        fields: ['commercial.tastingNotes'],
      });
      expect(res.status).toBe(200);
      openapi.expectResponse('post', path, res);
      expect(res.body.data.status).toBe('CHANGES_REQUESTED');
      expect(res.body.data.changeRequests).toEqual([
        expect.objectContaining({
          message: 'Falta la nota de cata',
          fields: ['commercial.tastingNotes'],
          resolvedAt: null,
        }),
      ]);
      const [mail] = await mails(
        'tokenizacion-cambios',
        emails.owner as string,
      );
      expect(mail.variables).toMatchObject({
        mensaje: 'Falta la nota de cata',
      });
      const lot = await call('get', `/v1/lots/${LOT}`, 'owner');
      expect(lot.body.data.tokenization.state).toBe('CHANGES_REQUESTED');
      expect(
        await outbox('tokenization.request_changes_requested', REQUEST),
      ).toHaveLength(1);
    });

    it('la dueña edita (cuota y nota de cata) y reenvía → SUBMITTED, cambios resueltos y aviso a operaciones', async () => {
      const tooMany = await call(
        'patch',
        `/v1/tokenization-requests/${REQUEST}`,
        'owner',
        { body: { quantity: 3001 } },
      );
      expect(error(tooMany)).toEqual({
        status: 422,
        code: 'TOK_QUOTA_EXCEEDS_ESTIMATE',
      });
      const edited = await call(
        'patch',
        `/v1/tokenization-requests/${REQUEST}`,
        'owner',
        {
          body: {
            quantity: 120,
            commercial: { tastingNotes: 'Flores blancas y durazno' },
          },
        },
      );
      expect(edited.status).toBe(200);
      openapi.expectResponse(
        'patch',
        `/v1/tokenization-requests/${REQUEST}`,
        edited,
      );
      expect(edited.body.data).toMatchObject({
        quantity: 120,
        resultingQuota: 120,
        commercialDraft: {
          name: COLLECTION_NAME,
          tastingNotes: 'Flores blancas y durazno',
        },
      });
      // La portada enviada al principio sigue en el borrador
      expect(edited.body.data.commercialDraft.imageKeys).toHaveLength(1);

      const path = `/v1/tokenization-requests/${REQUEST}/resubmit`;
      const res = await post(path, 'owner', {
        message: 'Añadida la nota de cata',
      });
      expect(res.status).toBe(200);
      openapi.expectResponse('post', path, res);
      expect(res.body.data.status).toBe('SUBMITTED');
      expect(res.body.data.changeRequests[0].resolvedAt).not.toBeNull();
      const notices = await mails(
        'tokenizacion-nueva-operaciones',
        emails.operations as string,
      );
      expect(notices).toHaveLength(2);
      expect(notices[1].variables).toMatchObject({ tipo: 'reenviada' });
      expect(await audits('TOKENIZATION_RESUBMITTED', REQUEST)).toHaveLength(1);
      // Reenviar otra vez no es una transición válida
      expect(error(await post(path, 'owner'))).toEqual({
        status: 409,
        code: 'TOK_REQUEST_INVALID_TRANSITION',
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('aprobación (§5.4, §6.1)', () => {
    it('soporte intenta aprobar → 403', async () => {
      const res = await post(
        `/v1/platform/tokenization-requests/${REQUEST}/approve`,
        'support',
      );
      expect(res.status).toBe(403);
    });

    it('aprobar sin portada → 422 TOK_COMMERCIAL_DATA_INCOMPLETE, un detalle por campo; después se rechaza con motivo', async () => {
      const lot = await newLot('owner', 'Lote sin datos comerciales');
      const id = await requestInReview(lot, { quantity: 50, confirm: true });
      const path = `/v1/platform/tokenization-requests/${id}/approve`;
      const res = await post(path, 'operations', {
        commercial: { name: `Colección sin portada ${run}` },
      });
      expect(error(res)).toEqual({
        status: 422,
        code: 'TOK_COMMERCIAL_DATA_INCOMPLETE',
      });
      openapi.expectResponse('post', path, res);
      expect(
        res.body.error.details.map((d: { field: string }) => d.field),
      ).toEqual(['commercial.description', 'commercial.imageKeys']);
      expect(await prisma.collection.count({ where: { lotId: lot } })).toBe(0);

      const rejectPath = `/v1/platform/tokenization-requests/${id}/reject`;
      const rejected = await post(rejectPath, 'admin', {
        reason: 'La bodega prefiere esperar al embotellado',
      });
      expect(rejected.status).toBe(200);
      openapi.expectResponse('post', rejectPath, rejected);
      expect(rejected.body.data).toMatchObject({
        status: 'REJECTED',
        decision: {
          outcome: 'REJECTED',
          reason: 'La bodega prefiere esperar al embotellado',
          by: { fullName: 'Personal admin', system: false },
        },
      });
      const [mail] = (
        await mails('tokenizacion-rechazada', emails.owner as string)
      ).slice(-1);
      expect(mail.variables).toMatchObject({
        motivo: 'La bodega prefiere esperar al embotellado',
      });
      expect(await outbox('tokenization.request_rejected', id)).toHaveLength(1);
      // Rechazada: ya no bloquea al lote y no admite más acciones
      expect(error(await post(rejectPath, 'admin', REASON))).toEqual({
        status: 409,
        code: 'TOK_REQUEST_INVALID_TRANSITION',
      });
      const status = await call('get', `/v1/lots/${lot}/tokenization`, 'owner');
      expect(status.body.data).toMatchObject({
        tokenizable: true,
        openRequest: null,
      });
    });

    it('aprobar sin identidad en la red → 409 TOK_WINERY_CHAIN_NOT_READY', async () => {
      const key = await uploadTraceFile(app, tokens.otherOwner, {
        folder: 'labels',
        file: png('vecina'),
        name: 'vecina.png',
        ip: nextIp(),
      });
      const lot = await newLot('otherOwner', 'Lote de la bodega vecina');
      const id = await requestInReview(
        lot,
        {
          quantity: 10,
          confirm: true,
          commercial: commercial(`Colección vecina ${run}`, key),
        },
        'otherOwner',
      );
      const path = `/v1/platform/tokenization-requests/${id}/approve`;
      const res = await post(path, 'operations');
      expect(error(res)).toEqual({
        status: 409,
        code: 'TOK_WINERY_CHAIN_NOT_READY',
      });
      openapi.expectResponse('post', path, res);
      expect(res.body.error.details[0].meta).toEqual({
        status: 'NOT_PROVISIONED',
      });
      expect(await prisma.collection.count({ where: { lotId: lot } })).toBe(0);
      const detail = await call(
        'get',
        `/v1/platform/tokenization-requests/${id}`,
        'support',
      );
      openapi.expectResponse(
        'get',
        `/v1/platform/tokenization-requests/${id}`,
        detail,
      );
      expect(detail.body.data.review.chainIdentity).toMatchObject({
        status: 'NOT_PROVISIONED',
        account: null,
        contract: null,
      });
    });

    it('la cuota se revalida al aprobar con los datos de ese momento', async () => {
      await post(
        `/v1/platform/tokenization-requests/${REQUEST}/take`,
        'operations',
      ).expect(200);
      // La bodega baja la estimación por debajo de lo pedido (120)
      await call('patch', `/v1/lots/${LOT}`, 'owner', {
        body: { estimatedBottles: 100, reason: 'Merma en la destilación' },
      }).expect(200);
      const res = await post(
        `/v1/platform/tokenization-requests/${REQUEST}/approve`,
        'operations',
      );
      expect(error(res)).toEqual({
        status: 422,
        code: 'TOK_QUOTA_EXCEEDS_ESTIMATE',
      });
      expect(res.body.error.details[0]).toMatchObject({
        expected: 100,
        actual: 120,
      });
      await call('patch', `/v1/lots/${LOT}`, 'owner', {
        body: { estimatedBottles: 3000, reason: 'Corrección de la merma' },
      }).expect(200);
    });

    it('completar datos comerciales y precio en revisión; un precio no entero → 422', async () => {
      const path = `/v1/platform/tokenization-requests/${REQUEST}`;
      const bad = await call('patch', path, 'operations', {
        body: { price: { amountMinor: 10.5, currency: 'BOB' } },
      });
      expect(bad.status).toBe(422);
      const res = await call('patch', path, 'operations', {
        body: {
          commercial: { pairing: 'Quesos de cabra y frutos secos' },
          price: { amountMinor: 18000, currency: 'BOB' },
        },
      });
      expect(res.status).toBe(200);
      openapi.expectResponse('patch', path, res);
      expect(res.body.data).toMatchObject({
        commercialDraft: { pairing: 'Quesos de cabra y frutos secos' },
        price: {
          amountMinor: 18000,
          currency: 'BOB',
          source: 'MANUAL',
          setBy: { fullName: 'Personal operations' },
        },
      });
      // La bodega no ve el precio hasta que se aprueba
      const erp = await call(
        'get',
        `/v1/tokenization-requests/${REQUEST}`,
        'owner',
      );
      expect(erp.body.data.price).toBeNull();
      // Y se puede dejar vacío (A-32)
      const cleared = await call('patch', path, 'operations', {
        body: { price: null },
      });
      expect(cleared.body.data.price).toBeNull();
    });

    it('aprobar dos veces en paralelo → una sola colección, una sola emisión y un solo evento', async () => {
      const path = `/v1/platform/tokenization-requests/${REQUEST}/approve`;
      const body = {
        price: { amountMinor: 18000, currency: 'BOB' },
        publishOnMint: false,
      };
      const [a, b] = await Promise.all([
        post(path, 'operations', body),
        post(path, 'admin', body),
      ]);
      const ok = [a, b].filter((r) => r.status === 201);
      const conflict = [a, b].filter((r) => r.status !== 201);
      expect(ok).toHaveLength(1);
      expect(error(conflict[0])).toEqual({
        status: 409,
        code: 'TOK_REQUEST_INVALID_TRANSITION',
      });
      const res = ok[0];
      openapi.expectResponse('post', path, res);
      COLLECTION = res.body.data.collection.id;
      MINT = res.body.data.mint.id;
      COVER_IMAGE_ID = res.body.data.collection.commercial.images[0].id;

      expect(res.body.data.request).toMatchObject({
        id: REQUEST,
        status: 'APPROVED',
        collectionId: COLLECTION,
        decision: { outcome: 'APPROVED', by: { system: false } },
      });
      expect(res.body.data.collection).toMatchObject({
        wineryId: WINERY,
        lotId: LOT,
        status: 'MINTING',
        mintStatus: 'PENDING',
        saleState: null,
        quota: 120,
        pendingMintQuantity: 120,
        counts: { minted: 0, available: 0, burned: 0 },
        name: COLLECTION_NAME,
        price: { amountMinor: 18000, source: 'MANUAL' },
        contract: { address: identity.contractAddress },
        redeemable: false,
        publishedAt: null,
        pricePolicySnapshot: null,
        commercial: {
          description: DESCRIPTION,
          tastingNotes: 'Flores blancas y durazno',
          pairing: 'Quesos de cabra y frutos secos',
        },
        anchor: null,
        closure: null,
      });
      expect(res.body.data.collection.slug).toMatch(/^singani-preventa-/);
      expect(res.body.data.collection.commercial.images[0]).toMatchObject({
        key: COVER_KEY,
        sha256: sha256Of(COVER),
        isCover: true,
      });
      // Sin publicar, la imagen se lee con una URL firmada, no por la ruta pública
      expect(res.body.data.collection.coverImageUrl).not.toContain(
        '/v1/public/collections/images/',
      );
      expect(res.body.data.collection.priceHistory).toHaveLength(1);
      expect(res.body.data.collection.quotaHistory).toEqual([
        expect.objectContaining({
          requestId: REQUEST,
          kind: 'INITIAL',
          quantity: 120,
          resultingQuota: 120,
        }),
      ]);
      expect(res.body.data.mint).toMatchObject({
        collectionId: COLLECTION,
        requestId: REQUEST,
        sequence: 1,
        quantity: 120,
        status: 'PENDING',
        ranges: [],
        transactions: [],
        confirmedAt: null,
      });
      const lotRow = await prisma.lot.findUniqueOrThrow({ where: { id: LOT } });
      expect(res.body.data.mint.lotArg).toBe(lotRow.reference);

      expect(await prisma.collection.count({ where: { lotId: LOT } })).toBe(1);
      expect(
        await prisma.mint.count({ where: { collectionId: COLLECTION } }),
      ).toBe(1);
      const events = await outbox('tokenization.request_approved', REQUEST);
      expect(events).toHaveLength(1);
      expect(events[0].queue).toBe('chain');
      expect(events[0].payload).toMatchObject({
        requestId: REQUEST,
        collectionId: COLLECTION,
        mintId: MINT,
        kind: 'INITIAL',
        quantity: 120,
        resultingQuota: 120,
        mintSequence: 1,
        contractId: identity.contractId,
        contractAddress: identity.contractAddress,
        toAddress: identity.accountAddress,
        lotArg: lotRow.reference,
        publishOnMint: false,
        approvedBySystem: false,
        chunks: [
          {
            index: 1,
            amount: 120,
            firstBottleNumber: 1,
            lastBottleNumber: 120,
            intentKey: `mint:${MINT}:1`,
          },
        ],
      });
      // Nada salió a la red: no hay ninguna transacción de emisión
      expect(
        await prisma.chainTransaction.count({ where: { kind: 'MINT_BATCH' } }),
      ).toBe(0);
      expect(await audits('TOKENIZATION_APPROVED', REQUEST)).toHaveLength(1);
      expect(await audits('NFT_MINT_REQUESTED', MINT)).toHaveLength(1);
      expect(
        await mails('tokenizacion-aprobada', emails.owner as string),
      ).toHaveLength(1);
    });

    it('la bodega ve su solicitud aprobada con el precio y el lote con la marca MINTING', async () => {
      const erp = await call(
        'get',
        `/v1/tokenization-requests/${REQUEST}`,
        'owner',
      );
      openapi.expectResponse(
        'get',
        `/v1/tokenization-requests/${REQUEST}`,
        erp,
      );
      expect(erp.body.data.price).toMatchObject({ amountMinor: 18000 });
      expect(
        erp.body.data.history.map((h: { status: string }) => h.status),
      ).toEqual([
        'SUBMITTED',
        'IN_REVIEW',
        'CHANGES_REQUESTED',
        'SUBMITTED',
        'IN_REVIEW',
        'APPROVED',
      ]);
      const lot = await call('get', `/v1/lots/${LOT}`, 'owner');
      expect(lot.body.data.tokenization).toEqual({
        state: 'MINTING',
        quota: 120,
        minted: 0,
        collectionId: COLLECTION,
      });
    });

    it('un nombre que genera un slug ya usado → 409 TOK_SLUG_TAKEN', async () => {
      const lot = await newLot('owner', 'Lote con nombre repetido');
      const id = await requestInReview(lot, {
        quantity: 10,
        confirm: true,
        commercial: commercial(COLLECTION_NAME),
      });
      const res = await post(
        `/v1/platform/tokenization-requests/${id}/approve`,
        'operations',
      );
      expect(error(res)).toEqual({ status: 409, code: 'TOK_SLUG_TAKEN' });
      // La bodega la retira con motivo
      const path = `/v1/tokenization-requests/${id}/withdraw`;
      const withdrawn = await call('post', path, 'owner', { body: REASON });
      expect(withdrawn.status).toBe(200);
      openapi.expectResponse('post', path, withdrawn);
      expect(withdrawn.body.data).toMatchObject({
        status: 'WITHDRAWN',
        withdrawn: { reason: REASON.reason, by: { role: 'OWNER' } },
      });
      expect(await audits('TOKENIZATION_WITHDRAWN', id)).toHaveLength(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('colecciones (§6.2, §6.4, §8.5)', () => {
    it('publicar antes de confirmar la emisión → 409 TOK_MINT_NOT_CONFIRMED', async () => {
      const path = `/v1/platform/collections/${COLLECTION}/publish`;
      const res = await post(path, 'operations');
      expect(error(res)).toEqual({
        status: 409,
        code: 'TOK_MINT_NOT_CONFIRMED',
      });
      openapi.expectResponse('post', path, res);
      expect(res.body.error.details[0].meta).toEqual({ mintStatus: 'PENDING' });
    });

    it('sin publicar, ni la imagen ni los metadatos son públicos', async () => {
      const image = await call(
        'get',
        `/v1/public/collections/images/${COVER_IMAGE_ID}`,
        'nobody',
      );
      expect(error(image)).toEqual({ status: 404, code: 'FILE_NOT_FOUND' });
      const nft = await call('get', `/v1/public/nft/${SLUG}/0`, 'nobody');
      expect(error(nft)).toEqual({ status: 404, code: 'PUB_TOKEN_NOT_FOUND' });
      expect(nft.headers['cache-control']).toBe('public, max-age=30');
    });

    it('con la emisión confirmada (paso 3.4), la colección queda READY con sus 120 NFT', async () => {
      await confirmMintInDatabase(prisma, {
        mintId: MINT,
        firstTokenId: 0,
        ownerAddress: identity.accountAddress,
      });
      const path = `/v1/platform/collections/${COLLECTION}`;
      const res = await call('get', path, 'support');
      expect(res.status).toBe(200);
      openapi.expectResponse('get', path, res);
      expect(res.body.data).toMatchObject({
        status: 'READY',
        mintStatus: 'CONFIRMED',
        saleState: null,
        quota: 120,
        pendingMintQuantity: 0,
        counts: { minted: 120, available: 120, sold: 0, burned: 0 },
        metrics: {
          quota: 120,
          authorizedVsEstimatePercent: 4,
          publishedAt: null,
          firstSaleAt: null,
          chainCosts: { feesChargedXlm: '0.1389000', transactions: 1 },
          byMint: [{ sequence: 1, quantity: 120 }],
        },
      });
      expect(res.body.data.mints[0]).toMatchObject({
        status: 'CONFIRMED',
        ranges: [
          {
            firstTokenId: 0,
            lastTokenId: 119,
            firstBottleNumber: 1,
            lastBottleNumber: 120,
          },
        ],
      });
      expect(res.body.data.mints[0].transactions).toEqual([
        expect.objectContaining({ kind: 'MINT_BATCH', status: 'CONFIRMED' }),
      ]);
      expect(res.body.data.statusHistory[0]).toMatchObject({
        status: 'MINTING',
      });

      const erpPath = `/v1/collections/${COLLECTION}`;
      const erp = await call('get', erpPath, 'enologist');
      openapi.expectResponse('get', erpPath, erp);
      expect(erp.body.data.id).toBe(COLLECTION);
      const other = await call('get', erpPath, 'otherOwner');
      expect(error(other)).toEqual({
        status: 404,
        code: 'TOK_COLLECTION_NOT_FOUND',
      });
      const list = await call('get', `/v1/collections?lotId=${LOT}`, 'owner');
      openapi.expectResponse('get', '/v1/collections', list);
      expect(list.body.data.total).toBe(1);
      const lot = await call('get', `/v1/lots/${LOT}`, 'owner');
      expect(lot.body.data.tokenization).toMatchObject({
        state: 'READY',
        minted: 120,
      });
    });

    it('bajar la estimación por debajo de lo emitido → 422 TOK_ESTIMATE_BELOW_MINTED; por debajo de la cuota no', async () => {
      const res = await call('patch', `/v1/lots/${LOT}`, 'owner', {
        body: { estimatedBottles: 119, reason: 'Merma' },
      });
      expect(error(res)).toEqual({
        status: 422,
        code: 'TOK_ESTIMATE_BELOW_MINTED',
      });
      openapi.expectResponse('patch', `/v1/lots/${LOT}`, res);
      expect(res.body.error.details[0]).toMatchObject({
        field: 'estimatedBottles',
        expected: 120,
        actual: 119,
      });
      await call('patch', `/v1/lots/${LOT}`, 'owner', {
        body: { estimatedBottles: 120, reason: 'Merma' },
      }).expect(200);
      const status = await call('get', `/v1/lots/${LOT}/tokenization`, 'owner');
      expect(status.body.data).toMatchObject({
        tokenizable: false,
        limits: { authorizedQuota: 120, maxQuantity: 0 },
        collection: { id: COLLECTION, status: 'READY' },
      });
      expect(status.body.data.blockers[0].code).toBe(
        'TOK_QUOTA_EXCEEDS_ESTIMATE',
      );
      await call('patch', `/v1/lots/${LOT}`, 'owner', {
        body: { estimatedBottles: 3000, reason: 'Corrección' },
      }).expect(200);
    });

    it('editar datos comerciales y precio con motivo: historial de precio y bitácora', async () => {
      const path = `/v1/platform/collections/${COLLECTION}`;
      const forbidden = await call('patch', path, 'support', {
        body: { ...REASON, price: { amountMinor: 20000, currency: 'BOB' } },
      });
      expect(forbidden.status).toBe(403);
      const res = await call('patch', path, 'operations', {
        body: {
          ...REASON,
          price: { amountMinor: 20000, currency: 'BOB' },
          commercial: { pairing: 'Empanadas tarijeñas' },
          estimatedRedeemDate: '2027-03-15',
        },
      });
      expect(res.status).toBe(200);
      openapi.expectResponse('patch', path, res);
      expect(res.body.data).toMatchObject({
        price: {
          amountMinor: 20000,
          setBy: { fullName: 'Personal operations' },
        },
        estimatedRedeemDate: '2027-03-15',
        commercial: { pairing: 'Empanadas tarijeñas' },
      });
      expect(
        res.body.data.priceHistory.map(
          (p: { amountMinor: number }) => p.amountMinor,
        ),
      ).toEqual([18000, 20000]);
      const [priceAudit] = await audits('COLLECTION_PRICE_SET', COLLECTION);
      expect(priceAudit.reason).toBe(REASON.reason);
      expect(priceAudit.after).toMatchObject({ priceAmountMinor: 20000 });
      expect(await audits('COLLECTION_UPDATED', COLLECTION)).toHaveLength(1);
    });

    it('publicar → PUBLISHED en preventa; soporte no puede; el lote lo cuenta en su línea de tiempo', async () => {
      const path = `/v1/platform/collections/${COLLECTION}/publish`;
      expect((await post(path, 'support')).status).toBe(403);
      const res = await post(path, 'operations');
      expect(res.status).toBe(200);
      openapi.expectResponse('post', path, res);
      expect(res.body.data).toMatchObject({
        status: 'PUBLISHED',
        saleState: 'PRESALE',
      });
      expect(res.body.data.publishedAt).not.toBeNull();
      expect(res.body.data.coverImageUrl).toContain(
        `/v1/public/collections/images/${COVER_IMAGE_ID}`,
      );
      expect(error(await post(path, 'operations'))).toEqual({
        status: 409,
        code: 'TOK_COLLECTION_INVALID_TRANSITION',
      });
      const events = await prisma.lotEvent.findMany({
        where: { lotId: LOT, type: 'COLLECTION_PUBLISHED' },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        visibility: 'PUBLIC',
        summary: '120 botellas en preventa',
      });
      expect(await outbox('collection.published', COLLECTION)).toHaveLength(1);
      expect(await audits('COLLECTION_PUBLISHED', COLLECTION)).toHaveLength(1);
      const [mail] = await mails('coleccion-estado', emails.owner as string);
      expect(mail.variables).toMatchObject({ estado: 'publicada' });
      const filtered = await call(
        'get',
        `/v1/platform/collections?saleState=PRESALE&mintStatus=CONFIRMED&wineryId=${WINERY}`,
        'support',
      );
      openapi.expectResponse('get', '/v1/platform/collections', filtered);
      expect(filtered.body.data.items.map((c: { id: string }) => c.id)).toEqual(
        [COLLECTION],
      );
      const soldOut = await call(
        'get',
        `/v1/platform/collections?saleState=SOLD_OUT&wineryId=${WINERY}`,
        'support',
      );
      expect(soldOut.body.data.total).toBe(0);
    });

    it('el slug ya no cambia al renombrar una colección publicada', async () => {
      const path = `/v1/platform/collections/${COLLECTION}`;
      const before = await call('get', path, 'admin');
      const res = await call('patch', path, 'admin', {
        body: { ...REASON, commercial: { name: `${COLLECTION_NAME} bis` } },
      });
      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe(`${COLLECTION_NAME} bis`);
      expect(res.body.data.slug).toBe(before.body.data.slug);
    });

    it('NFT paginados: dueña y contabilidad los ven; enología no', async () => {
      const path = `/v1/collections/${COLLECTION}/tokens`;
      const res = await call(
        'get',
        `${path}?status=MINTED&fromNumber=57&toNumber=60&limit=2`,
        'accountant',
      );
      expect(res.status).toBe(200);
      openapi.expectResponse('get', path, res);
      expect(res.body.data).toMatchObject({ total: 4, limit: 2 });
      expect(res.body.data.items[0]).toMatchObject({
        collectionId: COLLECTION,
        contractAddress: identity.contractAddress,
        tokenId: 56,
        bottleNumber: 57,
        status: 'MINTED',
        owner: { kind: 'WINERY', address: identity.accountAddress },
        mintId: MINT,
        mintTx: { kind: 'MINT_BATCH', status: 'CONFIRMED' },
        burnTx: null,
        metadataUrl: `${identity.baseUri}56`,
      });
      expect((await call('get', path, 'enologist')).status).toBe(403);
      expect(error(await call('get', path, 'otherOwner'))).toEqual({
        status: 404,
        code: 'TOK_COLLECTION_NOT_FOUND',
      });
      const platformPath = `/v1/platform/collections/${COLLECTION}/tokens`;
      const platform = await call('get', platformPath, 'support');
      openapi.expectResponse('get', platformPath, platform);
      expect(platform.body.data.total).toBe(120);
    });

    it('transacciones y métricas de la colección', async () => {
      const txPath = `/v1/platform/collections/${COLLECTION}/transactions`;
      const txs = await call('get', txPath, 'support');
      expect(txs.status).toBe(200);
      openapi.expectResponse('get', txPath, txs);
      expect(txs.body.data).toMatchObject({ total: 1 });
      expect(txs.body.data.items[0]).toMatchObject({
        kind: 'MINT_BATCH',
        status: 'CONFIRMED',
      });
      const metricsPath = `/v1/platform/collections/${COLLECTION}/metrics`;
      const metrics = await call('get', metricsPath, 'operations');
      expect(metrics.status).toBe(200);
      openapi.expectResponse('get', metricsPath, metrics);
      expect(metrics.body.data).toMatchObject({
        counts: { minted: 120, available: 120 },
        quota: 120,
        authorizedVsEstimatePercent: 4,
        chainCosts: { feesChargedXlm: '0.1389000', transactions: 1 },
      });
      expect(metrics.body.data.firstMintedAt).not.toBeNull();
      expect(metrics.body.data.publishedAt).not.toBeNull();
      expect((await call('get', metricsPath, 'owner')).status).toBe(403);
    });

    it('pausar con motivo y reanudar; transición repetida → 409', async () => {
      const pausePath = `/v1/platform/collections/${COLLECTION}/pause`;
      const paused = await post(pausePath, 'operations', REASON);
      expect(paused.status).toBe(200);
      openapi.expectResponse('post', pausePath, paused);
      expect(paused.body.data).toMatchObject({
        status: 'PAUSED',
        saleState: null,
      });
      const again = await post(pausePath, 'operations', REASON);
      expect(error(again)).toEqual({
        status: 409,
        code: 'TOK_COLLECTION_INVALID_TRANSITION',
      });
      expect(again.body.error.details[0].meta).toMatchObject({
        from: 'PAUSED',
        to: 'PAUSED',
      });
      const resumePath = `/v1/platform/collections/${COLLECTION}/resume`;
      const resumed = await post(resumePath, 'admin');
      expect(resumed.status).toBe(200);
      openapi.expectResponse('post', resumePath, resumed);
      expect(resumed.body.data).toMatchObject({
        status: 'PUBLISHED',
        saleState: 'PRESALE',
      });
      expect(
        resumed.body.data.statusHistory.map(
          (h: { status: string }) => h.status,
        ),
      ).toEqual(['MINTING', 'PUBLISHED', 'PAUSED', 'PUBLISHED']);
      expect(await outbox('collection.paused', COLLECTION)).toHaveLength(1);
      expect(await outbox('collection.resumed', COLLECTION)).toHaveLength(1);
    });

    it('cerrar con el cierre del lote sin resolver → 409 TOK_CLOSURE_PENDING', async () => {
      const path = `/v1/platform/collections/${COLLECTION}/close`;
      const res = await call('post', path, 'operations', { body: REASON });
      expect(error(res)).toEqual({ status: 409, code: 'TOK_CLOSURE_PENDING' });
      openapi.expectResponse('post', path, res);
      expect(res.body.error.details[0].meta).toMatchObject({
        closureStatus: null,
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('público: metadatos del NFT e imágenes (§6.5, §5.5)', () => {
    it('GET /v1/public/nft/{winerySlug}/{tokenId}: sin envoltorio, con caché y sin datos privados', async () => {
      const path = `/v1/public/nft/${SLUG}/56`;
      const res = await call('get', path, 'nobody');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('public, max-age=300');
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.body).not.toHaveProperty('data');
      // El validador espera el envoltorio común: se valida el objeto como `data`
      expect(
        openapi.validate('get', path, 200, {
          success: true,
          statusCode: 200,
          timestamp: new Date().toISOString(),
          path,
          data: res.body,
        }),
      ).toEqual([]);
      const lot = await prisma.lot.findUniqueOrThrow({ where: { id: LOT } });
      expect(res.body).toMatchObject({
        name: `${COLLECTION_NAME} bis · Botella 57 de 120`,
        description: DESCRIPTION,
        properties: {
          winery: { slug: SLUG },
          lotReference: lot.reference,
          lotCode: null,
          bottleNumber: 57,
          collectionSize: 120,
          tokenId: 56,
          contract: identity.contractAddress,
          status: 'MINTED',
          passportUrl: null,
        },
      });
      expect(res.body.image).toContain(
        `/v1/public/collections/images/${COVER_IMAGE_ID}`,
      );
      expect(res.body.attributes).toEqual(
        expect.arrayContaining([
          { trait_type: 'Lote', value: lot.reference },
          { trait_type: 'Bebida', value: 'Singani' },
          { trait_type: 'Botella n.º', value: 57 },
          { trait_type: 'Estado', value: 'Emitido' },
        ]),
      );
      const text = JSON.stringify(res.body);
      expect(text).not.toContain(identity.accountAddress);
      expect(text).not.toContain(emails.owner);
    });

    it('token inexistente, de otra bodega o con id no entero → 404 PUB_TOKEN_NOT_FOUND o 400', async () => {
      for (const path of [
        `/v1/public/nft/${SLUG}/120`,
        `/v1/public/nft/bodega-que-no-existe/0`,
      ]) {
        const res = await call('get', path, 'nobody');
        expect({ path, ...error(res) }).toEqual({
          path,
          status: 404,
          code: 'PUB_TOKEN_NOT_FOUND',
        });
        openapi.expectResponse('get', path, res);
      }
      const bad = await call('get', `/v1/public/nft/${SLUG}/abc`, 'nobody');
      expect(bad.status).toBeGreaterThanOrEqual(400);
      expect(bad.status).toBeLessThan(500);
    });

    it('un token quemado sigue respondiendo con status BURNED', async () => {
      await prisma.token.updateMany({
        where: { collectionId: COLLECTION, tokenId: 119 },
        data: {
          status: 'BURNED',
          burnedAt: new Date(),
          burnReason: 'SHORTFALL',
        },
      });
      const res = await call('get', `/v1/public/nft/${SLUG}/119`, 'nobody');
      expect(res.status).toBe(200);
      expect(res.body.properties.status).toBe('BURNED');
      const collection = await call(
        'get',
        `/v1/platform/collections/${COLLECTION}`,
        'support',
      );
      expect(collection.body.data.counts).toMatchObject({
        minted: 120,
        available: 119,
        burned: 1,
      });
    });

    it('la imagen de una colección publicada se sirve con sus bytes, caché y ETag', async () => {
      const path = `/v1/public/collections/images/${COVER_IMAGE_ID}`;
      const res = await call('get', path, 'nobody').buffer(true);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['cache-control']).toBe(
        'public, max-age=86400, immutable',
      );
      expect(res.headers.etag).toBe(`"${sha256Of(COVER)}"`);
      expect(Buffer.compare(res.body as Buffer, COVER)).toBe(0);
      const cached = await call('get', path, 'nobody').set(
        'If-None-Match',
        res.headers.etag,
      );
      expect(cached.status).toBe(304);
    });

    it('nada privado se alcanza adivinando: id inexistente, clave de archivo o id que no es UUID → 404/422', async () => {
      const missing = await call(
        'get',
        `/v1/public/collections/images/${randomUUID()}`,
        'nobody',
      );
      expect(error(missing)).toEqual({ status: 404, code: 'FILE_NOT_FOUND' });
      const byKey = await call(
        'get',
        `/v1/public/collections/images/${encodeURIComponent(COVER_KEY)}`,
        'nobody',
      );
      expect(byKey.status).toBeGreaterThanOrEqual(400);
      expect(byKey.status).toBeLessThan(500);
      // Una imagen de una solicitud sin aprobar no figura en ninguna colección
      const privateKey = await uploadTraceFile(app, tokens.owner, {
        folder: 'labels',
        file: png('privada'),
        name: 'privada.png',
        ip: nextIp(),
      });
      expect(
        await prisma.collectionImage.count({ where: { key: privateKey } }),
      ).toBe(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('ampliación de cuota (TOK-08, §5.2.4)', () => {
    let increase = '';

    it('con colección, la solicitud es QUOTA_INCREASE y suma a la cuota', async () => {
      const res = await post(`/v1/lots/${LOT}/tokenization-requests`, 'owner', {
        quantity: 30,
        confirm: true,
      });
      expect(res.status).toBe(201);
      increase = res.body.data.id;
      expect(res.body.data).toMatchObject({
        kind: 'QUOTA_INCREASE',
        quantity: 30,
        resultingQuota: 150,
        collectionId: COLLECTION,
        limitsAtSubmission: { authorizedQuota: 120, maxQuantity: 2880 },
      });
      const lot = await call('get', `/v1/lots/${LOT}`, 'owner');
      // La solicitud abierta manda sobre el estado de la colección
      expect(lot.body.data.tokenization).toMatchObject({
        state: 'REQUESTED',
        quota: 120,
        minted: 120,
      });
    });

    it('aprobarla no cambia el estado de la colección: amplía la cuota y crea la segunda emisión', async () => {
      await post(
        `/v1/platform/tokenization-requests/${increase}/take`,
        'operations',
      ).expect(200);
      const path = `/v1/platform/tokenization-requests/${increase}/approve`;
      const res = await post(path, 'operations');
      expect(res.status).toBe(201);
      openapi.expectResponse('post', path, res);
      expect(res.body.data.collection).toMatchObject({
        id: COLLECTION,
        status: 'PUBLISHED',
        mintStatus: 'PENDING',
        quota: 150,
        pendingMintQuantity: 30,
        counts: { minted: 120 },
      });
      expect(res.body.data.collection.quotaHistory).toHaveLength(2);
      expect(res.body.data.mint).toMatchObject({
        sequence: 2,
        quantity: 30,
        status: 'PENDING',
      });
      const [event] = await outbox('tokenization.request_approved', increase);
      expect(event.payload).toMatchObject({
        kind: 'QUOTA_INCREASE',
        mintSequence: 2,
        resultingQuota: 150,
        chunks: [
          {
            index: 1,
            amount: 30,
            firstBottleNumber: 121,
            lastBottleNumber: 150,
          },
        ],
      });
      expect(await prisma.collection.count({ where: { lotId: LOT } })).toBe(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('estado de la bodega (§3.5, parte de base de datos)', () => {
    let pending = '';

    it('bodega suspendida: su colección publicada pasa a PAUSED por el sistema y no se aprueban sus solicitudes', async () => {
      pending = await requestInReview(LOT, { quantity: 5, confirm: true });
      await call('post', `/v1/platform/wineries/${WINERY}/suspend`, 'admin', {
        body: { reason: 'Documentación vencida' },
      }).expect(200);

      const collection = await call(
        'get',
        `/v1/platform/collections/${COLLECTION}`,
        'support',
      );
      expect(collection.body.data.status).toBe('PAUSED');
      expect(collection.body.data.statusHistory.slice(-1)[0]).toMatchObject({
        status: 'PAUSED',
        by: 'Sistema',
        reason: 'Bodega suspendida: Documentación vencida',
      });
      const [audit] = (await audits('COLLECTION_PAUSED', COLLECTION)).filter(
        (a) => a.actorUserId === null,
      );
      expect(audit.reason).toBe('Bodega suspendida: Documentación vencida');

      const approve = await post(
        `/v1/platform/tokenization-requests/${pending}/approve`,
        'operations',
      );
      expect(error(approve)).toEqual({
        status: 409,
        code: 'TOK_WINERY_NOT_ACTIVE',
      });
      expect(approve.body.error.details[0].meta).toEqual({
        status: 'SUSPENDED',
      });
      const resume = await post(
        `/v1/platform/collections/${COLLECTION}/resume`,
        'operations',
      );
      // La segunda emisión sigue sin confirmar: es lo primero que se comprueba
      expect(error(resume)).toEqual({
        status: 409,
        code: 'TOK_MINT_NOT_CONFIRMED',
      });
      // La solicitud abierta sigue abierta: suspender no la rechaza
      const request = await call(
        'get',
        `/v1/platform/tokenization-requests/${pending}`,
        'support',
      );
      expect(request.body.data.status).toBe('IN_REVIEW');
    });

    it('al reactivarla, la colección sigue PAUSED hasta que operaciones la reanude', async () => {
      await call(
        'post',
        `/v1/platform/wineries/${WINERY}/reactivate`,
        'admin',
        { body: { reason: 'Documentación al día' } },
      ).expect(200);
      await relogin('owner', OWNER_ID, WINERY);
      const collection = await call(
        'get',
        `/v1/collections/${COLLECTION}`,
        'owner',
      );
      expect(collection.body.data.status).toBe('PAUSED');
      // Con la emisión confirmada y la bodega activa, se puede reanudar
      const second = await prisma.mint.findFirstOrThrow({
        where: { collectionId: COLLECTION, sequence: 2 },
      });
      await confirmMintInDatabase(prisma, {
        mintId: second.id,
        firstTokenId: 120,
        ownerAddress: identity.accountAddress,
      });
      const resumed = await post(
        `/v1/platform/collections/${COLLECTION}/resume`,
        'operations',
      );
      expect(resumed.status).toBe(200);
      expect(resumed.body.data).toMatchObject({
        status: 'PUBLISHED',
        quota: 150,
        counts: { minted: 150 },
      });
      expect(
        resumed.body.data.mints.map(
          (m: { ranges: { firstBottleNumber: number }[] }) =>
            m.ranges[0].firstBottleNumber,
        ),
      ).toEqual([1, 121]);
    });

    it('contrato pausado en la red → 409 CHN_CONTRACT_PAUSED al aprobar', async () => {
      await prisma.nftContract.update({
        where: { id: identity.contractId },
        data: { paused: true },
      });
      const res = await post(
        `/v1/platform/tokenization-requests/${pending}/approve`,
        'operations',
      );
      expect(error(res)).toEqual({ status: 409, code: 'CHN_CONTRACT_PAUSED' });
      await prisma.nftContract.update({
        where: { id: identity.contractId },
        data: { paused: false },
      });
    });

    it('bodega revocada: colecciones a PAUSED y solicitudes abiertas rechazadas por el sistema', async () => {
      const email = `revocada-o3tok-${run}@e2e.test`;
      const { wineryId, ownerId } = await wineryWithOwner(app, {
        name: `Bodega Revocada ${run}`,
        email,
        password: 'Solicitudes-o3-123!',
      });
      emails.nobody = email;
      const token = await staffToken(app, {
        userId: ownerId,
        email,
        organizationId: wineryId,
        organizationType: 'WINERY',
        role: MembershipRoleEnum.OWNER,
      });
      const lot = await http()
        .post('/v1/lots')
        .set('X-Forwarded-For', nextIp())
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'Lote de la bodega revocada',
          harvestYear: new Date().getUTCFullYear(),
          productType: 'SINGANI',
          estimatedBottles: 500,
        })
        .expect(201);
      const created = await http()
        .post(`/v1/lots/${lot.body.data.id}/tokenization-requests`)
        .set('X-Forwarded-For', nextIp())
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', randomUUID())
        .send({ quantity: 50, confirm: true })
        .expect(201);
      await call('post', `/v1/platform/wineries/${wineryId}/revoke`, 'admin', {
        body: { reason: 'Incumplimiento del acuerdo' },
      }).expect(200);
      const request = await call(
        'get',
        `/v1/platform/tokenization-requests/${created.body.data.id}`,
        'support',
      );
      expect(request.body.data).toMatchObject({
        status: 'REJECTED',
        decision: {
          outcome: 'REJECTED',
          reason: 'Bodega revocada: Incumplimiento del acuerdo',
          by: { userId: null, fullName: null, system: true },
        },
      });
      expect(request.body.data.history.slice(-1)[0]).toMatchObject({
        status: 'REJECTED',
        by: 'Sistema',
      });
      expect(await mails('tokenizacion-rechazada', email)).toHaveLength(1);
      expect(
        (await prisma.winery.findUniqueOrThrow({ where: { id: wineryId } }))
          .certificationStatus,
      ).toBe(WineryStatusEnum.REVOKED);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('lote no tokenizable y tokenizacion.requiereAprobacion (§5.2.2, §5.6)', () => {
    it('lote descartado o certificado → 409 TOK_LOT_NOT_TOKENIZABLE con su etapa', async () => {
      const discarded = await newLot('owner', 'Lote que se descarta');
      await call('post', `/v1/lots/${discarded}/discard`, 'owner', {
        body: { reason: 'Contaminación en el tanque' },
      }).expect((res) => expect([200, 201]).toContain(res.status));
      const certified = await newLot('owner', 'Lote ya certificado');
      await prisma.lot.update({
        where: { id: certified },
        data: { stage: 'CERTIFIED' },
      });
      for (const [lot, stage] of [
        [discarded, 'DISCARDED'],
        [certified, 'CERTIFIED'],
      ]) {
        const res = await post(
          `/v1/lots/${lot}/tokenization-requests`,
          'owner',
          { quantity: 10, confirm: true },
        );
        expect({ stage, ...error(res) }).toEqual({
          stage,
          status: 409,
          code: 'TOK_LOT_NOT_TOKENIZABLE',
        });
        expect(res.body.error.details[0].meta).toMatchObject({ stage });
        const status = await call(
          'get',
          `/v1/lots/${lot}/tokenization`,
          'owner',
        );
        expect(status.body.data.tokenizable).toBe(false);
        expect(status.body.data.blockers[0]).toMatchObject({
          code: 'TOK_LOT_NOT_TOKENIZABLE',
        });
      }
    });

    it('lote sin estimación → 422 TOK_LOT_ESTIMATE_MISSING', async () => {
      const lot = await newLot('owner', 'Lote sin estimación', null);
      const res = await post(`/v1/lots/${lot}/tokenization-requests`, 'owner', {
        quantity: 10,
        confirm: true,
      });
      expect(error(res)).toEqual({
        status: 422,
        code: 'TOK_LOT_ESTIMATE_MISSING',
      });
    });

    it('con requiereAprobacion = false se aprueba sola si los datos están completos (S-11); si no, queda para operaciones', async () => {
      await prisma.settingOverride.create({
        data: {
          key: 'tokenizacion.requiereAprobacion',
          wineryId: WINERY,
          value: false,
          reason: 'Prueba de S-11',
        },
      });
      const status = await call('get', `/v1/lots/${LOT}/tokenization`, 'owner');
      expect(status.body.data.approvalRequired).toBe(false);

      const complete = await newLot('owner', 'Lote que se aprueba solo');
      const auto = await post(
        `/v1/lots/${complete}/tokenization-requests`,
        'owner',
        {
          quantity: 40,
          confirm: true,
          commercial: commercial(`Autoaprobada ${run}`),
        },
      );
      expect(auto.status).toBe(201);
      openapi.expectResponse(
        'post',
        `/v1/lots/${complete}/tokenization-requests`,
        auto,
      );
      expect(auto.body.data).toMatchObject({
        status: 'APPROVED',
        requiresApproval: false,
        decision: {
          outcome: 'APPROVED',
          by: { userId: null, fullName: null, system: true },
        },
      });
      const collection = await prisma.collection.findUniqueOrThrow({
        where: { lotId: complete },
      });
      // Emitida igual; publicar sigue siendo del back office
      expect(collection).toMatchObject({
        status: 'MINTING',
        quota: 40,
        priceAmountMinor: null,
      });
      const [audit] = await audits('TOKENIZATION_APPROVED', auto.body.data.id);
      expect(audit.actorUserId).toBeNull();
      const [event] = await outbox(
        'tokenization.request_approved',
        auto.body.data.id,
      );
      expect(event.payload).toMatchObject({
        approvedBySystem: true,
        approvedByUserId: null,
      });

      const incomplete = await newLot('owner', 'Lote sin portada');
      const manual = await post(
        `/v1/lots/${incomplete}/tokenization-requests`,
        'owner',
        { quantity: 40, confirm: true },
      );
      expect(manual.body.data).toMatchObject({
        status: 'SUBMITTED',
        requiresApproval: false,
        decision: null,
      });
      expect(
        await prisma.collection.count({ where: { lotId: incomplete } }),
      ).toBe(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('tablero, panel y cierre (§11, §6.4)', () => {
    it('el tablero del back office y el panel del ERP cuentan lo real', async () => {
      const board = await call('get', '/v1/platform/dashboard', 'admin');
      expect(board.status).toBe(200);
      openapi.expectResponse('get', '/v1/platform/dashboard', board);
      const open = await prisma.tokenizationRequest.groupBy({
        by: ['status'],
        where: {
          status: { in: ['SUBMITTED', 'IN_REVIEW', 'CHANGES_REQUESTED'] },
        },
        _count: { _all: true },
      });
      const count = (s: string) =>
        open.find((g) => g.status === s)?._count._all ?? 0;
      expect(board.body.data.tokenization).toMatchObject({
        submitted: count('SUBMITTED'),
        inReview: count('IN_REVIEW'),
        changesRequested: 0,
        collectionsMinting: 1,
        mintFailures: 0,
        collectionsPublished: 1,
        shortfallsOpen: 0,
      });
      expect(count('SUBMITTED')).toBeGreaterThan(0);
      expect(count('IN_REVIEW')).toBeGreaterThan(0);

      const panel = await call('get', '/v1/traceability/dashboard', 'owner');
      expect(panel.status).toBe(200);
      openapi.expectResponse('get', '/v1/traceability/dashboard', panel);
      expect(panel.body.data.tokenization).toEqual({
        openRequests: await prisma.tokenizationRequest.count({
          where: {
            wineryId: WINERY,
            status: { in: ['SUBMITTED', 'IN_REVIEW', 'CHANGES_REQUESTED'] },
          },
        }),
        changesRequested: 0,
        collectionsPublished: 1,
      });
    });

    it('con el cierre del lote resuelto, la colección se cierra y deja de admitir cambios', async () => {
      await prisma.lotClosure.create({
        data: {
          lotId: LOT,
          collectionId: COLLECTION,
          status: 'NO_SHORTFALL',
          bottles: 2950,
          minted: 150,
        },
      });
      const path = `/v1/platform/collections/${COLLECTION}/close`;
      const res = await call('post', path, 'operations', { body: REASON });
      expect(res.status).toBe(200);
      openapi.expectResponse('post', path, res);
      expect(res.body.data.status).toBe('CLOSED');
      expect(res.body.data.closedAt).not.toBeNull();
      expect(await outbox('collection.closed', COLLECTION)).toHaveLength(1);
      const lot = await call('get', `/v1/lots/${LOT}`, 'owner');
      // La solicitud de 5 botellas sigue abierta: manda sobre la colección
      expect(lot.body.data.tokenization.state).toBe('REQUESTED');
      const edit = await call(
        'patch',
        `/v1/platform/collections/${COLLECTION}`,
        'operations',
        { body: { ...REASON, price: { amountMinor: 1, currency: 'BOB' } } },
      );
      expect(error(edit)).toEqual({
        status: 409,
        code: 'TOK_COLLECTION_INVALID_TRANSITION',
      });
      const status = await call('get', `/v1/lots/${LOT}/tokenization`, 'owner');
      expect(status.body.data.blockers[0]).toMatchObject({
        code: 'TOK_LOT_NOT_TOKENIZABLE',
        meta: { collectionStatus: 'CLOSED' },
      });
    });
  });
});
