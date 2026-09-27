import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import * as bcrypt from 'bcrypt';
import { randomInt } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  MembershipRoleEnum,
  UserRoleEnum,
  WineryCategoryEnum,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { configureApp } from '../src/app.setup';
import { PLATFORM_ORGANIZATION_ID } from '../src/modules/organizations/organization.constants';
import { SettingsService } from '../src/modules/settings/settings.service';
import { WorkerModule } from '../src/worker/worker.module';
import { WORKER_SETTINGS, WorkerSettings } from '../src/worker/worker.config';
import { QueueRegistry } from '../src/worker/queue-registry.service';
import { OutboxRelayService } from '../src/worker/outbox-relay.service';
import { OutboxJobData } from '../src/shared/outbox/outbox.types';
import {
  createPlatformUser,
  deleteIdentityData,
  loginWithMfa,
} from './helpers/identity';

process.env.TRUST_PROXY = '1';

/**
 * Ola 1 · 1.3–1.6 (contrato O1 §3–§5, §11 bis; SE-05): formulario público →
 * verificación (correo en Mailpit) → tomar → reunión → aprobar → el dueño
 * acepta con una cuenta nueva → bodega ACTIVE con prefijo de lote → ERP;
 * alta directa; suspender (403 ORG_NOT_ACTIVE y sesión revocada), reactivar,
 * revocar; transferir la titularidad; equipo con todas sus reglas; permisos
 * por rol (403) y entre organizaciones (404); el operario lee parcelas.
 */
const PASSWORD = 'Password123!';
const NEW_PASSWORD = 'vendimia-de-altura-2026';
const MAILPIT_API_URL = process.env.MAILPIT_API_URL ?? 'http://localhost:8025';
const run = `o1org${Date.now()}`;
const email = (name: string) => `${name}_${run}@test.bo`;
const ipBase = `10.${randomInt(1, 250)}.${randomInt(1, 250)}`;
let ipSeq = 1;
const nextIp = () => `${ipBase}.${ipSeq++}`;
const taxId = () => `${randomInt(1000000000, 9999999999)}`;

type Res = request.Response;

async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs = 30000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Tiempo agotado esperando la condición');
}

describe('Solicitudes, bodegas y equipo · O1-BE-1 B (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let worker: TestingModule;
  let queues: QueueRegistry;
  const wineryIds: string[] = [];

  let adminToken: string;
  let operationsToken: string;
  let supportToken: string;

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const code = (res: Res) =>
    (res.body as { error?: { code?: string } }).error?.code;

  async function lastMail(to: string, template: string) {
    return waitFor(() =>
      prisma.emailMessage.findFirst({
        where: { toAddress: to, template },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  /** Token del enlace de un correo encolado (de sus variables). */
  async function linkToken(to: string, template: string): Promise<string> {
    const message = await lastMail(to, template);
    const vars = message.variables as { enlace?: string } | null;
    const match = /(?:token=|invitacion\/)([A-Za-z0-9_-]+)/.exec(
      vars?.enlace ?? '',
    );
    if (!match) throw new Error(`Sin token en el correo ${template} a ${to}`);
    return decodeURIComponent(match[1]);
  }

  async function mailpitText(to: string): Promise<string> {
    const found = await waitFor(async () => {
      const res = await fetch(
        `${MAILPIT_API_URL}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`,
      );
      if (!res.ok) return null;
      const body = (await res.json()) as { messages: { ID: string }[] };
      return body.messages.length > 0 ? body.messages : null;
    });
    const detail = (await (
      await fetch(`${MAILPIT_API_URL}/api/v1/message/${found[0].ID}`)
    ).json()) as { Text: string };
    return detail.Text;
  }

  /** Publica el evento del correo en la cola `email` (como el relay). */
  async function sendThroughWorker(emailMessageId: string): Promise<void> {
    const event = await prisma.outboxEvent.findFirstOrThrow({
      where: { aggregateType: 'email_message', aggregateId: emailMessageId },
    });
    const { count } = await prisma.outboxEvent.updateMany({
      where: { id: event.id, status: 'PENDING' },
      data: { status: 'DONE', processedAt: new Date() },
    });
    if (count === 0) return;
    const data: OutboxJobData = {
      outboxEventId: event.id,
      eventType: event.eventType,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      payload: event.payload as Record<string, unknown>,
      correlationId: event.correlationId,
      occurredAt: event.createdAt.toISOString(),
    };
    await queues.get('email').add(event.eventType, data, { jobId: event.id });
  }

  async function staffLogin(who: string): Promise<string> {
    const res = await loginWithMfa(
      http,
      prisma,
      { email: who, password: PASSWORD },
      { ip: nextIp() },
    );
    expect(res.status).toBe(200);
    return res.body.data.tokens.accessToken as string;
  }

  function login(who: string, password = PASSWORD): request.Test {
    return http()
      .post('/v1/auth/login')
      .set('X-Forwarded-For', nextIp())
      .send({ email: who, password });
  }

  /** Acepta una invitación con una cuenta nueva; devuelve el acceso. */
  async function acceptAsNewAccount(
    to: string,
    fullName: string,
  ): Promise<{ token: string; organizationId: string }> {
    const token = await linkToken(to, 'invitacion');
    const res = await http()
      .post(`/v1/invitations/${token}/accept`)
      .set('X-Forwarded-For', nextIp())
      .send({ fullName, password: NEW_PASSWORD })
      .expect(200);
    return {
      token: res.body.data.tokens.accessToken as string,
      organizationId: res.body.data.activeOrganizationId as string,
    };
  }

  /** Persona con membresía directa en una bodega (para las pruebas del equipo). */
  async function memberOf(
    wineryId: string,
    name: string,
    role: MembershipRoleEnum,
  ): Promise<{ userId: string; membershipId: string }> {
    const user = await prisma.user.create({
      data: {
        email: email(name),
        fullName: `Persona ${name}`,
        passwordHash: await bcrypt.hash(PASSWORD, 4),
        userRole: UserRoleEnum.ENOLOGIST,
      },
    });
    const membership = await prisma.membership.create({
      data: { userId: user.id, organizationId: wineryId, role },
    });
    return { userId: user.id, membershipId: membership.id };
  }

  function publicForm(overrides: Record<string, unknown> = {}) {
    return {
      legalName: `Viñas ${run} S.R.L.`,
      tradeName: `Viñas del Alto ${run}`,
      taxId: taxId(),
      category: WineryCategoryEnum.WINERY,
      region: 'Valle de Cinti · Camargo',
      contactName: 'Rodrigo Aguilar',
      contactEmail: email('contacto'),
      contactPhone: '+59172110022',
      message: 'Queremos registrar nuestros lotes.',
      captchaToken: 'XXXX.DUMMY.TOKEN.XXXX',
      website: '',
      ...overrides,
    };
  }

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    const settings: WorkerSettings = {
      redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
      queuePrefix: run,
      concurrency: 2,
      jobAttempts: 3,
      jobBackoffMs: 200,
      relay: {
        intervalMs: 100,
        batchSize: 20,
        maxAttempts: 3,
        retryBaseMs: 200,
        retryMaxMs: 2000,
        lockTimeoutMs: 60000,
      },
      retentionDays: 7,
      heartbeat: {
        file: join(tmpdir(), `${run}.heartbeat`),
        intervalMs: 1000,
      },
    };
    worker = await Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(WORKER_SETTINGS)
      .useValue(settings)
      .overrideProvider(OutboxRelayService)
      .useValue({
        onApplicationBootstrap: () => undefined,
        onModuleDestroy: async () => undefined,
        start: () => undefined,
        stop: async () => undefined,
        isRunning: () => true,
        msSinceLastTick: () => 0,
      })
      .compile();
    await worker.init();
    queues = worker.get(QueueRegistry);

    for (const [name, role] of [
      ['admin', 'ADMIN'],
      ['operations', 'OPERATIONS'],
      ['support', 'SUPPORT'],
    ] as const) {
      await createPlatformUser(prisma, {
        email: email(name),
        password: PASSWORD,
        fullName: `Personal ${name}`,
        role,
      });
    }
    adminToken = await staffLogin(email('admin'));
    operationsToken = await staffLogin(email('operations'));
    supportToken = await staffLogin(email('support'));
  }, 120_000);

  afterAll(async () => {
    if (prisma) {
      const created = await prisma.winery.findMany({
        where: {
          OR: [
            { id: { in: wineryIds } },
            { legalName: { contains: run } },
            { commercialName: { contains: run } },
          ],
        },
        select: { id: true },
      });
      const ids = [...new Set([...wineryIds, ...created.map((w) => w.id)])];
      const mails = await prisma.emailMessage.findMany({
        where: {
          OR: [
            { toAddress: { contains: run } },
            { organizationId: { in: ids } },
          ],
        },
        select: { id: true },
      });
      await prisma.outboxEvent.deleteMany({
        where: {
          aggregateId: { in: [...mails.map((m) => m.id), ...ids] },
        },
      });
      await prisma.emailMessage.deleteMany({
        where: { id: { in: mails.map((m) => m.id) } },
      });
      await prisma.wineryApplication.deleteMany({
        where: { contactEmail: { contains: run } },
      });
      await prisma.settingOverride.deleteMany({
        where: { wineryId: { in: ids } },
      });
      await deleteIdentityData(prisma, {
        emailContains: run,
        wineryIds: ids,
      });
      await prisma.wineryMember.deleteMany({
        where: { wineryId: { in: ids } },
      });
      await prisma.userWallet.deleteMany({
        where: {
          OR: [
            { wineryId: { in: ids } },
            { user: { email: { contains: run } } },
          ],
        },
      });
      await prisma.winery.deleteMany({ where: { id: { in: ids } } });
      await prisma.user.deleteMany({ where: { email: { contains: run } } });
    }
    if (queues) {
      await Promise.allSettled(
        queues.all().map((q) => q.obliterate({ force: true })),
      );
    }
    await worker?.close();
    await app?.close();
  });

  // ─── Solicitudes de alta (§3) ────────────────────────────────────────────

  describe('de la solicitud pública a la bodega activa (ORG-01…05)', () => {
    let applicationId: string;
    let wineryId: string;
    let ownerToken: string;
    let slug: string;

    it('formulario público: 202 UNVERIFIED y enlace de verificación en Mailpit', async () => {
      const form = publicForm({ contactEmail: email('camargo') });
      const res = await http()
        .post('/v1/public/winery-applications')
        .set('X-Forwarded-For', nextIp())
        .set('X-Client-App', 'PUBLIC')
        .send(form)
        .expect(202);
      expect(res.body.data).toEqual({
        id: expect.any(String),
        status: 'UNVERIFIED',
      });
      applicationId = res.body.data.id;

      // Sin verificar, operaciones no la ve en la bandeja por defecto
      const inbox = await http()
        .get(`/v1/platform/winery-applications?q=${encodeURIComponent(run)}`)
        .set(auth(supportToken))
        .expect(200);
      expect(
        inbox.body.data.items.map((a: { id: string }) => a.id),
      ).not.toContain(applicationId);

      // Reenviar la misma solicitud sin verificar: misma solicitud, enlace nuevo
      const again = await http()
        .post('/v1/public/winery-applications')
        .set('X-Forwarded-For', nextIp())
        .send(form)
        .expect(202);
      expect(again.body.data.id).toBe(applicationId);

      const message = await lastMail(email('camargo'), 'solicitud-verificar');
      await sendThroughWorker(message.id);
      const text = await mailpitText(email('camargo'));
      const link = /(http\S+\/unirse\/verificar\?token=\S+)/.exec(text);
      expect(link).not.toBeNull();
      const token = new URL(link![1]).searchParams.get('token')!;

      await http()
        .post('/v1/public/winery-applications/verify')
        .send({ token })
        .expect(204);
      const reused = await http()
        .post('/v1/public/winery-applications/verify')
        .send({ token })
        .expect(422);
      expect(code(reused)).toBe('APPLICATION_TOKEN_INVALID');

      // Aviso a operaciones y confirmación al contacto
      await lastMail(email('operations'), 'solicitud-nueva-operaciones');
      await lastMail(email('camargo'), 'solicitud-recibida');
    });

    it('bandeja y detalle; soporte solo lee (403) y las transiciones inválidas dan 409', async () => {
      const inbox = await http()
        .get(
          `/v1/platform/winery-applications?status=RECEIVED&q=${encodeURIComponent(run)}`,
        )
        .set(auth(supportToken))
        .expect(200);
      expect(inbox.body.data.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: applicationId, status: 'RECEIVED' }),
        ]),
      );
      expect(inbox.body.data.items[0]).not.toHaveProperty('notes');

      const forbidden = await http()
        .post(`/v1/platform/winery-applications/${applicationId}/take`)
        .set(auth(supportToken))
        .send({})
        .expect(403);
      expect(code(forbidden)).toBe('AUTH_INSUFFICIENT_PERMISSIONS');

      const early = await http()
        .post(`/v1/platform/winery-applications/${applicationId}/approve`)
        .set(auth(operationsToken))
        .send({})
        .expect(409);
      expect(code(early)).toBe('APPLICATION_INVALID_TRANSITION');
    });

    it('tomar, notas, reunión y reunión hecha', async () => {
      const taken = await http()
        .post(`/v1/platform/winery-applications/${applicationId}/take`)
        .set(auth(operationsToken))
        .send({})
        .expect(200);
      expect(taken.body.data).toMatchObject({
        status: 'IN_REVIEW',
        assignee: { fullName: 'Personal operations' },
      });
      const twice = await http()
        .post(`/v1/platform/winery-applications/${applicationId}/take`)
        .set(auth(operationsToken))
        .send({})
        .expect(409);
      expect(code(twice)).toBe('APPLICATION_INVALID_TRANSITION');

      await http()
        .post(`/v1/platform/winery-applications/${applicationId}/notes`)
        .set(auth(operationsToken))
        .send({ text: 'Documentación en orden' })
        .expect(200);
      const scheduled = await http()
        .post(
          `/v1/platform/winery-applications/${applicationId}/schedule-meeting`,
        )
        .set(auth(operationsToken))
        .send({ scheduledAt: '2026-10-01T15:00:00-04:00', channel: 'VIDEO' })
        .expect(200);
      expect(scheduled.body.data).toMatchObject({
        status: 'MEETING_SCHEDULED',
        meeting: {
          scheduledAt: '2026-10-01T19:00:00.000Z',
          channel: 'VIDEO',
          notes: null,
        },
      });
      const done = await http()
        .post(`/v1/platform/winery-applications/${applicationId}/meeting-done`)
        .set(auth(operationsToken))
        .send({ notes: 'Visita hecha: aprobar' })
        .expect(200);
      expect(done.body.data.status).toBe('IN_REVIEW');
      expect(done.body.data.meeting.notes).toBe('Visita hecha: aprobar');
      expect(done.body.data.notes.map((n: { text: string }) => n.text)).toEqual(
        ['Documentación en orden', 'Visita hecha: aprobar'],
      );
    });

    it('aprobar: bodega INVITED e invitación al dueño en la misma transacción', async () => {
      const res = await http()
        .post(`/v1/platform/winery-applications/${applicationId}/approve`)
        .set(auth(operationsToken))
        .send({ ownerFullName: 'Rodrigo Aguilar Titular' })
        .expect(200);
      const { application, winery, invitation } = res.body.data;
      wineryId = winery.id;
      wineryIds.push(wineryId);
      slug = winery.slug;
      expect(application).toMatchObject({
        status: 'APPROVED',
        wineryId,
        decision: { by: 'Personal operations', reason: null },
      });
      expect(winery).toMatchObject({
        status: 'INVITED',
        lotPrefix: null,
        activatedAt: null,
        owner: {
          userId: null,
          fullName: 'Rodrigo Aguilar Titular',
          email: email('camargo'),
        },
        statusHistory: [
          expect.objectContaining({
            status: 'INVITED',
            by: 'Personal operations',
          }),
        ],
      });
      expect(slug).toMatch(/^vinas-del-alto-/);
      expect(invitation).toMatchObject({
        role: 'OWNER',
        status: 'PENDING',
        organizationId: wineryId,
        email: email('camargo'),
      });
      await lastMail(email('camargo'), 'solicitud-aprobada');

      // Otra solicitud con el mismo NIT ya no se crea (202 silencioso)
      const dup = await http()
        .post('/v1/public/winery-applications')
        .set('X-Forwarded-For', nextIp())
        .send(publicForm({ taxId: winery.taxId, contactEmail: email('dup') }))
        .expect(202);
      expect(
        await prisma.wineryApplication.findUnique({
          where: { id: dup.body.data.id },
        }),
      ).toBeNull();
      await lastMail(email('operations'), 'solicitud-duplicada-operaciones');
    });

    it('el dueño acepta con una cuenta nueva: ACTIVE, prefijo de lote, winery.activated y ERP accesible', async () => {
      const accepted = await acceptAsNewAccount(
        email('camargo'),
        'Rodrigo Aguilar',
      );
      ownerToken = accepted.token;
      expect(accepted.organizationId).toBe(wineryId);

      const detail = await http()
        .get(`/v1/platform/wineries/${wineryId}`)
        .set(auth(supportToken))
        .expect(200);
      expect(detail.body.data).toMatchObject({
        status: 'ACTIVE',
        lotPrefix: expect.stringMatching(/^[A-Z]{3,5}$/),
        activatedAt: expect.any(String),
        owner: { userId: expect.any(String), fullName: 'Rodrigo Aguilar' },
        membersCount: 1,
      });
      expect(
        detail.body.data.statusHistory.map((h: { status: string }) => h.status),
      ).toEqual(['INVITED', 'ACTIVE']);
      expect(detail.body.data.statusHistory[1].by).toBe('Rodrigo Aguilar');

      const event = await prisma.outboxEvent.findFirst({
        where: { eventType: 'winery.activated', aggregateId: wineryId },
      });
      expect(event?.payload).toMatchObject({
        wineryId,
        lotPrefix: detail.body.data.lotPrefix,
      });
      const activated = await prisma.auditEvent.findFirst({
        where: { action: 'WINERY_ACTIVATED', resourceId: wineryId },
      });
      expect(activated?.actorFullName).toBe('Rodrigo Aguilar');

      await http().get('/v1/terroirs').set(auth(ownerToken)).expect(200);
      const current = await http()
        .get('/v1/organizations/current')
        .set(auth(ownerToken))
        .expect(200);
      expect(current.body.data).toMatchObject({ id: wineryId, slug });

      // El dueño edita el perfil (sin NIT ni razón social)
      const edited = await http()
        .patch('/v1/organizations/current')
        .set(auth(ownerToken))
        .send({
          publicStory: 'Cuatro familias en Camargo',
          website: 'https://camargo.test',
        })
        .expect(200);
      expect(edited.body.data.publicStory).toBe('Cuatro familias en Camargo');
      await http()
        .patch('/v1/organizations/current')
        .set(auth(ownerToken))
        .send({ taxId: '1234567' })
        .expect(422);

      const profile = await http()
        .get(`/v1/public/wineries/${slug}`)
        .expect(200);
      expect(profile.body.data).toEqual({
        slug,
        tradeName: expect.any(String),
        region: 'Valle de Cinti · Camargo',
        category: 'WINERY',
        logoUrl: null,
        publicStory: 'Cuatro familias en Camargo',
        website: 'https://camargo.test',
      });

      const actions = await prisma.auditEvent.findMany({
        where: {
          resourceType: 'winery_application',
          resourceId: applicationId,
        },
        select: { action: true },
      });
      expect(actions.map((a) => a.action)).toEqual(
        expect.arrayContaining([
          'WINERY_APPLICATION_SUBMITTED',
          'WINERY_APPLICATION_VERIFIED',
          'WINERY_APPLICATION_TAKEN',
          'WINERY_APPLICATION_NOTE_ADDED',
          'WINERY_APPLICATION_MEETING_SCHEDULED',
          'WINERY_APPLICATION_MEETING_DONE',
          'WINERY_APPLICATION_APPROVED',
        ]),
      );
    });

    it('rechazar exige motivo y lo envía al contacto', async () => {
      const res = await http()
        .post('/v1/public/winery-applications')
        .set('X-Forwarded-For', nextIp())
        .send(publicForm({ contactEmail: email('rechazo') }))
        .expect(202);
      const id = res.body.data.id as string;
      const token = await linkToken(email('rechazo'), 'solicitud-verificar');
      await http()
        .post('/v1/public/winery-applications/verify')
        .send({ token })
        .expect(204);
      await http()
        .post(`/v1/platform/winery-applications/${id}/take`)
        .set(auth(adminToken))
        .send({})
        .expect(200);
      const noReason = await http()
        .post(`/v1/platform/winery-applications/${id}/reject`)
        .set(auth(adminToken))
        .send({})
        .expect(422);
      expect(noReason.body.error.details[0].field).toBe('reason');
      const rejected = await http()
        .post(`/v1/platform/winery-applications/${id}/reject`)
        .set(auth(adminToken))
        .send({ reason: 'No elabora con materia prima propia' })
        .expect(200);
      expect(rejected.body.data).toMatchObject({
        status: 'REJECTED',
        decision: { reason: 'No elabora con materia prima propia' },
      });
      const mail = await lastMail(email('rechazo'), 'solicitud-rechazada');
      expect(mail.variables).toMatchObject({
        motivo: 'No elabora con materia prima propia',
      });
    });

    it('campo trampa relleno: 202 sin crear nada', async () => {
      const res = await http()
        .post('/v1/public/winery-applications')
        .set('X-Forwarded-For', nextIp())
        .send(
          publicForm({
            contactEmail: email('bot'),
            website: 'https://spam.test',
          }),
        )
        .expect(202);
      expect(
        await prisma.wineryApplication.count({
          where: { contactEmail: email('bot') },
        }),
      ).toBe(0);
      expect(res.body.data.status).toBe('UNVERIFIED');
    });

    it('tablero: cuenta las solicitudes con los modelos de la Ola 1', async () => {
      const dashboard = await http()
        .get('/v1/platform/dashboard')
        .set(auth(supportToken))
        .expect(200);
      expect(dashboard.body.data.applications).toEqual({
        unverified: expect.any(Number),
        received: expect.any(Number),
        inReview: expect.any(Number),
        meetingScheduled: expect.any(Number),
      });
      expect(dashboard.body.data.invitations.pending).toBeGreaterThanOrEqual(0);
    });
  });

  // ─── Bodegas (§4) ────────────────────────────────────────────────────────

  describe('alta directa, suspender, reactivar, revocar y transferir (ORG-03, 07…11, SE-05)', () => {
    let wineryId: string;
    let ownerToken: string;
    let ownerUserId: string;
    const nit = taxId();

    it('alta directa: 201 con la invitación; soporte → 403; NIT repetido → 409', async () => {
      const body = {
        legalName: `Angostura ${run} S.R.L.`,
        tradeName: `Angostura ${run}`,
        taxId: nit,
        category: 'WINERY',
        region: 'Valle Central de Tarija',
        contactEmail: email('angostura'),
        ownerEmail: email('angostura-duena'),
        ownerFullName: 'Lucía Vargas',
      };
      await http()
        .post('/v1/platform/wineries')
        .set(auth(supportToken))
        .send(body)
        .expect(403);
      const res = await http()
        .post('/v1/platform/wineries')
        .set(auth(operationsToken))
        .send(body)
        .expect(201);
      wineryId = res.body.data.winery.id;
      wineryIds.push(wineryId);
      expect(res.body.data.winery).toMatchObject({
        status: 'INVITED',
        owner: { userId: null, fullName: 'Lucía Vargas' },
      });
      expect(res.body.data.invitation.role).toBe('OWNER');
      const dup = await http()
        .post('/v1/platform/wineries')
        .set(auth(operationsToken))
        .send({ ...body, ownerEmail: email('otra') })
        .expect(409);
      expect(code(dup)).toBe('ORG_TAX_ID_TAKEN');

      // Directorio y filtros
      const list = await http()
        .get(
          `/v1/platform/wineries?status=INVITED&q=${encodeURIComponent(`Angostura ${run}`)}`,
        )
        .set(auth(supportToken))
        .expect(200);
      expect(list.body.data.items).toEqual([
        expect.objectContaining({ id: wineryId, status: 'INVITED' }),
      ]);
      expect(list.body.data.items[0]).not.toHaveProperty('statusHistory');

      // Bodega INVITED: el perfil público no existe
      await http()
        .get(`/v1/public/wineries/${res.body.data.winery.slug}`)
        .expect(404);

      const accepted = await acceptAsNewAccount(
        email('angostura-duena'),
        'Lucía Vargas',
      );
      ownerToken = accepted.token;
      ownerUserId = (
        await prisma.user.findUniqueOrThrow({
          where: { email: email('angostura-duena') },
        })
      ).id;
    });

    it('editar con motivo (PATCH del back office)', async () => {
      const noReason = await http()
        .patch(`/v1/platform/wineries/${wineryId}`)
        .set(auth(operationsToken))
        .send({ region: 'Valle de Uriondo' })
        .expect(422);
      expect(noReason.body.error.details[0].field).toBe('reason');
      const res = await http()
        .patch(`/v1/platform/wineries/${wineryId}`)
        .set(auth(operationsToken))
        .send({ region: 'Valle de Uriondo', reason: 'Dirección fiscal nueva' })
        .expect(200);
      expect(res.body.data.region).toBe('Valle de Uriondo');
      const audit = await prisma.auditEvent.findFirst({
        where: { action: 'WINERY_UPDATED', resourceId: wineryId },
        orderBy: { seq: 'desc' },
      });
      expect(audit?.reason).toBe('Dirección fiscal nueva');
    });

    it('suspender: sesión revocada, 403 ORG_NOT_ACTIVE en el ERP; perfil y bitácora propia legibles', async () => {
      await http().get('/v1/terroirs').set(auth(ownerToken)).expect(200);
      await http()
        .post(`/v1/platform/wineries/${wineryId}/suspend`)
        .set(auth(supportToken))
        .send({ reason: 'Registro vencido' })
        .expect(403);
      const suspended = await http()
        .post(`/v1/platform/wineries/${wineryId}/suspend`)
        .set(auth(operationsToken))
        .send({ reason: 'Registro SENASAG vencido' })
        .expect(200);
      expect(suspended.body.data.status).toBe('SUSPENDED');
      await lastMail(email('angostura-duena'), 'bodega-estado');

      const revoked = await http()
        .get('/v1/terroirs')
        .set(auth(ownerToken))
        .expect(401);
      expect(code(revoked)).toBe('AUTH_SESSION_REVOKED');

      const again = await login(email('angostura-duena'), NEW_PASSWORD).expect(
        200,
      );
      expect(again.body.data.activeOrganizationId).toBe(wineryId);
      const token = again.body.data.tokens.accessToken as string;
      const blocked = await http()
        .get('/v1/terroirs')
        .set(auth(token))
        .expect(403);
      expect(blocked.body.error).toMatchObject({
        code: 'ORG_NOT_ACTIVE',
        details: [{ field: null, message: 'SUSPENDED' }],
      });
      await http()
        .get('/v1/organizations/current')
        .set(auth(token))
        .expect(200);
      await http()
        .get('/v1/organizations/current/audit')
        .set(auth(token))
        .expect(200);
      await http()
        .patch('/v1/organizations/current')
        .set(auth(token))
        .send({ address: 'Calle 1' })
        .expect(403);

      const twice = await http()
        .post(`/v1/platform/wineries/${wineryId}/suspend`)
        .set(auth(operationsToken))
        .send({ reason: 'Otra vez' })
        .expect(409);
      expect(code(twice)).toBe('ORG_INVALID_TRANSITION');

      const reactivated = await http()
        .post(`/v1/platform/wineries/${wineryId}/reactivate`)
        .set(auth(operationsToken))
        .send({ reason: 'Registro renovado' })
        .expect(200);
      expect(reactivated.body.data.status).toBe('ACTIVE');
      expect(
        reactivated.body.data.statusHistory.map(
          (h: { status: string }) => h.status,
        ),
      ).toEqual(['INVITED', 'ACTIVE', 'SUSPENDED', 'ACTIVE']);
      await http().get('/v1/terroirs').set(auth(token)).expect(200);
      ownerToken = token;
    });

    it('transferir la titularidad (solo administración): el anterior queda como enólogo', async () => {
      await http()
        .post(`/v1/platform/wineries/${wineryId}/transfer-ownership`)
        .set(auth(operationsToken))
        .send({ newOwnerEmail: email('nueva-duena'), reason: 'Venta' })
        .expect(403);
      const res = await http()
        .post(`/v1/platform/wineries/${wineryId}/transfer-ownership`)
        .set(auth(adminToken))
        .send({
          newOwnerEmail: email('nueva-duena'),
          reason: 'Venta de la bodega',
          keepPreviousOwnerAs: 'ENOLOGIST',
        })
        .expect(200);
      expect(res.body.data.invitation).toMatchObject({
        role: 'OWNER',
        email: email('nueva-duena'),
      });
      // Hasta que acepte, el dueño sigue siendo el anterior
      expect(res.body.data.winery.owner.userId).toBe(ownerUserId);

      const accepted = await acceptAsNewAccount(
        email('nueva-duena'),
        'Sofía Nueva',
      );
      const previous = await prisma.membership.findUniqueOrThrow({
        where: {
          userId_organizationId: {
            userId: ownerUserId,
            organizationId: wineryId,
          },
        },
      });
      expect(previous).toMatchObject({ role: 'ENOLOGIST', status: 'ACTIVE' });
      await waitFor(async () => {
        const r = await http().get('/v1/terroirs').set(auth(ownerToken));
        return r.status === 401;
      });
      const detail = await http()
        .get(`/v1/platform/wineries/${wineryId}`)
        .set(auth(supportToken))
        .expect(200);
      expect(detail.body.data.owner).toMatchObject({ fullName: 'Sofía Nueva' });
      await http().get('/v1/terroirs').set(auth(accepted.token)).expect(200);

      // Otra transferencia con el valor por defecto: la anterior queda bloqueada
      await http()
        .post(`/v1/platform/wineries/${wineryId}/transfer-ownership`)
        .set(auth(adminToken))
        .send({ newOwnerEmail: email('tercera-duena'), reason: 'Nueva venta' })
        .expect(200);
      await acceptAsNewAccount(email('tercera-duena'), 'Tercera Dueña');
      const second = await prisma.membership.findFirstOrThrow({
        where: {
          organizationId: wineryId,
          user: { email: email('nueva-duena') },
        },
      });
      expect(second).toMatchObject({
        role: 'ENOLOGIST',
        status: 'BLOCKED',
        blockedBy: 'PLATFORM',
      });
    });

    it('revocar: solo administración; anula invitaciones; 409 al repetir', async () => {
      const other = await http()
        .post('/v1/platform/wineries')
        .set(auth(operationsToken))
        .send({
          legalName: `Revocada ${run} S.R.L.`,
          tradeName: `Revocada ${run}`,
          taxId: taxId(),
          category: 'DISTILLERY',
          region: 'Cinti',
          contactEmail: email('revocada'),
          ownerEmail: email('revocada-dueno'),
          ownerFullName: 'Dueño Revocado',
        })
        .expect(201);
      const id = other.body.data.winery.id as string;
      wineryIds.push(id);
      await http()
        .post(`/v1/platform/wineries/${id}/revoke`)
        .set(auth(operationsToken))
        .send({ reason: 'No sigue' })
        .expect(403);
      const revoked = await http()
        .post(`/v1/platform/wineries/${id}/revoke`)
        .set(auth(adminToken))
        .send({ reason: 'Desistió del alta' })
        .expect(200);
      expect(revoked.body.data.status).toBe('REVOKED');
      const invitation = await prisma.invitation.findUniqueOrThrow({
        where: { id: other.body.data.invitation.id },
      });
      expect(invitation.status).toBe('REVOKED');
      const again = await http()
        .post(`/v1/platform/wineries/${id}/reactivate`)
        .set(auth(operationsToken))
        .send({ reason: 'Error' })
        .expect(409);
      expect(code(again)).toBe('ORG_INVALID_TRANSITION');
      await http()
        .get('/v1/platform/wineries/00000000-0000-4000-8000-00000000abcd')
        .set(auth(supportToken))
        .expect(404);
    });
  });

  // ─── Equipo (§5) ─────────────────────────────────────────────────────────

  describe('equipo de la bodega (EQP-04…08, EQP-10)', () => {
    let wineryId: string;
    let otherWineryId: string;
    let ownerToken: string;
    let ownerMembershipId: string;
    let enologist: { userId: string; membershipId: string };
    let operator: { userId: string; membershipId: string };
    let foreign: { userId: string; membershipId: string };
    let operatorToken: string;
    let enologistToken: string;

    beforeAll(async () => {
      const create = async (name: string) => {
        const res = await http()
          .post('/v1/platform/wineries')
          .set(auth(operationsToken))
          .send({
            legalName: `${name} ${run} S.R.L.`,
            tradeName: `${name} ${run}`,
            taxId: taxId(),
            category: 'WINERY',
            region: 'Tarija',
            contactEmail: email(`${name}-contacto`.toLowerCase()),
            ownerEmail: email(`${name}-dueno`.toLowerCase()),
            ownerFullName: `Dueño ${name}`,
          })
          .expect(201);
        wineryIds.push(res.body.data.winery.id);
        const accepted = await acceptAsNewAccount(
          email(`${name}-dueno`.toLowerCase()),
          `Dueño ${name}`,
        );
        return { id: res.body.data.winery.id as string, token: accepted.token };
      };
      const main = await create('Equipo');
      wineryId = main.id;
      ownerToken = main.token;
      ownerMembershipId = (
        await prisma.membership.findFirstOrThrow({
          where: { organizationId: wineryId, role: 'OWNER' },
        })
      ).id;
      otherWineryId = (await create('Ajena')).id;
      enologist = await memberOf(wineryId, 'enologa', 'ENOLOGIST');
      operator = await memberOf(wineryId, 'operario', 'OPERATOR');
      foreign = await memberOf(otherWineryId, 'ajeno', 'ENOLOGIST');
      operatorToken = (await login(email('operario')).expect(200)).body.data
        .tokens.accessToken;
      enologistToken = (await login(email('enologa')).expect(200)).body.data
        .tokens.accessToken;
    }, 120_000);

    it('el dueño ve todo; los demás roles solo nombres y roles de los activos', async () => {
      const full = await http()
        .get('/v1/organizations/current/members')
        .set(auth(ownerToken))
        .expect(200);
      expect(full.body.data.total).toBe(3);
      expect(full.body.data.items[0]).not.toHaveProperty('accountStatus');
      const basic = await http()
        .get('/v1/organizations/current/members')
        .set(auth(operatorToken))
        .expect(200);
      expect(
        basic.body.data.items.every(
          (m: { lastLoginAt: unknown }) => m.lastLoginAt === null,
        ),
      ).toBe(true);
      await http()
        .patch(`/v1/organizations/current/members/${enologist.membershipId}`)
        .set(auth(operatorToken))
        .send({ role: 'AGRONOMIST' })
        .expect(403);
    });

    it('cambiar el rol: reglas del dueño y sesión de la persona cerrada', async () => {
      const self = await http()
        .patch(`/v1/organizations/current/members/${ownerMembershipId}`)
        .set(auth(ownerToken))
        .send({ role: 'ENOLOGIST' })
        .expect(403);
      expect(code(self)).toBe('ORG_CANNOT_MODIFY_SELF');
      const owner = await http()
        .patch(`/v1/organizations/current/members/${enologist.membershipId}`)
        .set(auth(ownerToken))
        .send({ role: 'OWNER' })
        .expect(403);
      expect(code(owner)).toBe('ORG_OWNER_ROLE_RESERVED');
      await http()
        .patch(`/v1/organizations/current/members/${foreign.membershipId}`)
        .set(auth(ownerToken))
        .send({ role: 'AGRONOMIST' })
        .expect(404);
      const changed = await http()
        .patch(`/v1/organizations/current/members/${enologist.membershipId}`)
        .set(auth(ownerToken))
        .send({ role: 'AGRONOMIST' })
        .expect(200);
      expect(changed.body.data).toMatchObject({
        membershipId: enologist.membershipId,
        role: 'AGRONOMIST',
      });
      await http().get('/v1/terroirs').set(auth(enologistToken)).expect(401);
    });

    it('el operario lee las parcelas pero no las crea', async () => {
      await http().get('/v1/terroirs').set(auth(operatorToken)).expect(200);
      await http()
        .post('/v1/terroirs')
        .set(auth(operatorToken))
        .send({
          parcelName: 'Parcela',
          surfaceHectares: 1,
          altitudeMasl: 1800,
          rawMaterialType: 'Uva',
          varietyName: 'Moscatel',
        })
        .expect(403);
    });

    it('bloquear y desbloquear (dueño): sesiones cerradas y límite de colaboradores', async () => {
      const blocked = await http()
        .post(
          `/v1/organizations/current/members/${operator.membershipId}/block`,
        )
        .set(auth(ownerToken))
        .send({ reason: 'Dejó la bodega' })
        .expect(200);
      expect(blocked.body.data).toMatchObject({
        status: 'BLOCKED',
        blockedBy: 'OWNER',
      });
      await http().get('/v1/terroirs').set(auth(operatorToken)).expect(401);
      await http()
        .post(
          `/v1/organizations/current/members/${operator.membershipId}/block`,
        )
        .set(auth(ownerToken))
        .send({})
        .expect(409);

      // Con el cupo lleno no se puede reactivar a nadie
      const active = await prisma.membership.count({
        where: { organizationId: wineryId, status: 'ACTIVE' },
      });
      await app
        .get(SettingsService)
        .setOverrides('equipo.maxColaboradoresPorBodega', [wineryId], active, {
          reason: 'Prueba del límite',
        });
      const full = await http()
        .post(
          `/v1/organizations/current/members/${operator.membershipId}/unblock`,
        )
        .set(auth(ownerToken))
        .send({})
        .expect(422);
      expect(code(full)).toBe('ORG_MEMBER_LIMIT_REACHED');
      await app
        .get(SettingsService)
        .resetOverrides('equipo.maxColaboradoresPorBodega', [wineryId], {
          reason: 'Fin de la prueba',
        });
      await http()
        .post(
          `/v1/organizations/current/members/${operator.membershipId}/unblock`,
        )
        .set(auth(ownerToken))
        .send({})
        .expect(200);
    });

    it('back office: motivo obligatorio, bloqueo de la plataforma que el dueño no levanta y aviso al dueño', async () => {
      const base = `/v1/platform/organizations/${wineryId}/members`;
      const list = await http().get(base).set(auth(supportToken)).expect(200);
      expect(list.body.data.items[0]).toHaveProperty('accountStatus', 'ACTIVE');

      const noReason = await http()
        .post(`${base}/${operator.membershipId}/block`)
        .set(auth(supportToken))
        .send({})
        .expect(422);
      expect(noReason.body.error.details[0].field).toBe('reason');
      const blocked = await http()
        .post(`${base}/${operator.membershipId}/block`)
        .set(auth(supportToken))
        .send({ reason: 'Uso indebido reportado' })
        .expect(200);
      expect(blocked.body.data.blockedBy).toBe('PLATFORM');
      const notice = await lastMail(email('equipo-dueno'), 'aviso-equipo');
      expect(notice.variables).toMatchObject({
        motivo: 'Uso indebido reportado',
      });

      const ownerTry = await http()
        .post(
          `/v1/organizations/current/members/${operator.membershipId}/unblock`,
        )
        .set(auth(ownerToken))
        .send({})
        .expect(403);
      expect(code(ownerTry)).toBe('ORG_BLOCKED_BY_PLATFORM');
      await http()
        .post(`${base}/${operator.membershipId}/unblock`)
        .set(auth(supportToken))
        .send({ reason: 'Aclarado con la bodega' })
        .expect(200);

      const role = await http()
        .patch(`${base}/${operator.membershipId}`)
        .set(auth(operationsToken))
        .send({ role: 'ACCOUNTANT', reason: 'Pedido por el dueño' })
        .expect(200);
      expect(role.body.data.role).toBe('ACCOUNTANT');
      const ownerRole = await http()
        .patch(`${base}/${ownerMembershipId}`)
        .set(auth(operationsToken))
        .send({ role: 'ENOLOGIST', reason: 'Prueba' })
        .expect(403);
      expect(code(ownerRole)).toBe('ORG_OWNER_ROLE_RESERVED');

      // Entre organizaciones: 404
      await http()
        .post(`${base}/${foreign.membershipId}/block`)
        .set(auth(supportToken))
        .send({ reason: 'Prueba cruzada' })
        .expect(404);
      await http()
        .get(`/v1/platform/organizations/${PLATFORM_ORGANIZATION_ID}/members`)
        .set(auth(supportToken))
        .expect(404);
      // Una bodega no usa las rutas del back office
      await http().get(base).set(auth(ownerToken)).expect(403);

      const actions = await prisma.auditEvent.findMany({
        where: {
          resourceType: 'membership',
          resourceId: operator.membershipId,
        },
        select: { action: true, reason: true, actorViaPlatform: true },
      });
      expect(actions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: 'MEMBER_BLOCKED',
            reason: 'Uso indebido reportado',
            actorViaPlatform: true,
          }),
          expect.objectContaining({ action: 'MEMBER_UNBLOCKED' }),
          expect.objectContaining({ action: 'MEMBER_ROLE_CHANGED' }),
        ]),
      );
    });
  });

  // ─── SE-05 y rutas obsoletas ─────────────────────────────────────────────

  describe('bodega INVITED en el ERP y rutas que se retiran en H1', () => {
    it('INVITED → 403 ORG_NOT_ACTIVE; la ruta obsoleta avisa con Deprecation', async () => {
      const ip = nextIp();
      const signup = await http()
        .post('/v1/auth/signup')
        .set('X-Forwarded-For', ip)
        .send({
          email: email('legado'),
          password: PASSWORD,
          fullName: 'Dueño legado',
          userRole: UserRoleEnum.WINERY_ADMIN,
        })
        .expect(201);
      const winery = await http()
        .post('/v1/wineries')
        .set(auth(signup.body.data.tokens.accessToken))
        .send({
          legalName: `Legado ${run} S.A.`,
          commercialName: `Legado ${run}`,
          beverageCategory: WineryCategoryEnum.WINERY,
          taxIdNit: taxId(),
          geographicRegion: 'Tarija',
          contactEmail: email('legado'),
        })
        .expect(201);
      expect(winery.headers['deprecation']).toBe('true');
      wineryIds.push(winery.body.data.id);
      const session = await login(email('legado')).expect(200);
      expect(session.body.data.activeOrganizationId).toBe(winery.body.data.id);
      const res = await http()
        .get('/v1/terroirs')
        .set(auth(session.body.data.tokens.accessToken))
        .expect(403);
      expect(res.body.error).toMatchObject({
        code: 'ORG_NOT_ACTIVE',
        details: [{ field: null, message: 'INVITED' }],
      });

      // La aprobación antigua sigue funcionando y asigna el prefijo de lote
      const approved = await http()
        .post(`/v1/wineries/${winery.body.data.id}/approve`)
        .set(auth(adminToken))
        .send({})
        .expect(200);
      expect(approved.headers['deprecation']).toBe('true');
      const row = await prisma.winery.findUniqueOrThrow({
        where: { id: winery.body.data.id },
      });
      expect(row.lotPrefix).toMatch(/^[A-Z]{3,5}$/);
      expect(row.slug).toMatch(/^legado-/);
    });
  });
});
