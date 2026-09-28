import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { randomInt } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { configureApp } from '../src/app.setup';
import { PLATFORM_ORGANIZATION_ID } from '../src/modules/organizations/organization.constants';
import { currentTotp } from '../src/modules/auth/mfa/totp';
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
import { wineryWithOwner } from './helpers/staff-session';

process.env.TRUST_PROXY = '1';

/**
 * Ola 1 · 1.1 y 1.2 (contrato O1 §1, §2 y §5): recuperación de contraseña de
 * punta a punta hasta Mailpit, verificación del correo, cambio de contraseña,
 * preferencias, segundo factor (inscripción, verificación, códigos de
 * recuperación y límite), invitaciones (cuenta nueva y existente, correo
 * distinto, caducada, reenviada, anulada, límite de colaboradores) y usuarios
 * internos, con los permisos por rol (403) y entre organizaciones (404).
 */
const PASSWORD = 'Password123!';
const NEW_PASSWORD = 'vendimia-de-altura-2026';
const MAILPIT_API_URL = process.env.MAILPIT_API_URL ?? 'http://localhost:8025';
const run = `o1id${Date.now()}`;
const email = (name: string) => `${name}_${run}@test.bo`;
const ipBase = `10.${randomInt(1, 250)}.${randomInt(1, 250)}`;
let ipSeq = 1;
const nextIp = () => `${ipBase}.${ipSeq++}`;

type Res = request.Response;

function cookieOf(res: Res): string {
  const header = res.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = (header ?? []).find((c) => c.startsWith('doc_rt='));
  if (!cookie) throw new Error(`Sin Set-Cookie doc_rt (status ${res.status})`);
  return cookie.split(';')[0];
}

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

describe('Cuenta, segundo factor, invitaciones y usuarios internos · O1-BE-1 A (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let worker: TestingModule;
  let queues: QueueRegistry;
  const wineryIds: string[] = [];

  let adminToken: string;
  let supportToken: string;
  let ownerToken: string;
  let ownerCookie: string;
  let wineryId: string;
  let otherOwnerToken: string;
  let otherWineryId: string;
  let superadminMembershipId: string;
  let supportMembershipId: string;

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  /** Último correo encolado a `to` con esa plantilla (enlace incluido). */
  async function lastMail(to: string, template: string) {
    return waitFor(() =>
      prisma.emailMessage.findFirst({
        where: { toAddress: to, template },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  /** Token del enlace de un correo (de sus variables o, si ya salió, de Mailpit). */
  async function linkToken(to: string, template: string): Promise<string> {
    const message = await lastMail(to, template);
    const vars = message.variables as { enlace?: string } | null;
    const link = vars?.enlace ?? (await mailpitLink(to));
    const match = /(?:token=|invitacion\/)([A-Za-z0-9_-]+)/.exec(link);
    if (!match) throw new Error(`Sin token en ${link}`);
    return decodeURIComponent(match[1]);
  }

  async function mailpitLink(to: string): Promise<string> {
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
    const link = /(http\S+)/.exec(detail.Text);
    if (!link) throw new Error('Correo sin enlace');
    return link[1];
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

  async function staffLogin(who: string) {
    const res = await loginWithMfa(
      http,
      prisma,
      { email: who, password: PASSWORD },
      { ip: nextIp() },
    );
    expect(res.status).toBe(200);
    return res;
  }

  async function ownerWithWinery(name: string) {
    const ip = nextIp();
    const { wineryId } = await wineryWithOwner(app, {
      name: `${name} ${run}`,
      taxId: `${randomInt(100000000, 999999999)}`,
      email: email(name),
      password: PASSWORD,
      fullName: `Dueña ${name}`,
    });
    wineryIds.push(wineryId);
    const login = await http()
      .post('/v1/auth/login')
      .set('X-Forwarded-For', ip)
      .send({ email: email(name), password: PASSWORD })
      .expect(200);
    expect(login.body.data.activeOrganizationId).toBe(wineryId);
    return {
      token: login.body.data.tokens.accessToken as string,
      cookie: cookieOf(login),
      wineryId,
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

    await createPlatformUser(prisma, {
      email: email('superadmin'),
      password: PASSWORD,
      role: 'SUPERADMIN',
    });
    await createPlatformUser(prisma, {
      email: email('admin'),
      password: PASSWORD,
      role: 'ADMIN',
    });
    const support = await createPlatformUser(prisma, {
      email: email('support'),
      password: PASSWORD,
      role: 'SUPPORT',
    });
    adminToken = (await staffLogin(email('admin'))).body.data.tokens
      .accessToken;
    supportToken = (await staffLogin(email('support'))).body.data.tokens
      .accessToken;
    superadminMembershipId = (
      await prisma.membership.findFirstOrThrow({
        where: {
          user: { email: email('superadmin') },
          organizationId: PLATFORM_ORGANIZATION_ID,
        },
      })
    ).id;
    supportMembershipId = (
      await prisma.membership.findFirstOrThrow({
        where: { userId: support.id, organizationId: PLATFORM_ORGANIZATION_ID },
      })
    ).id;

    const owner = await ownerWithWinery('owner');
    ownerToken = owner.token;
    ownerCookie = owner.cookie;
    wineryId = owner.wineryId;
    const other = await ownerWithWinery('other');
    otherOwnerToken = other.token;
    otherWineryId = other.wineryId;
  }, 120_000);

  afterAll(async () => {
    if (prisma) {
      const mails = await prisma.emailMessage.findMany({
        where: { toAddress: { contains: run } },
        select: { id: true },
      });
      await prisma.outboxEvent.deleteMany({
        where: { aggregateId: { in: mails.map((m) => m.id) } },
      });
      await prisma.emailMessage.deleteMany({
        where: { id: { in: mails.map((m) => m.id) } },
      });
      await deleteIdentityData(prisma, { emailContains: run, wineryIds });
      await prisma.wineryMember.deleteMany({
        where: { wineryId: { in: wineryIds } },
      });
      await prisma.settingOverride.deleteMany({
        where: { wineryId: { in: wineryIds } },
      });
      await prisma.userWallet.deleteMany({
        where: {
          OR: [
            { wineryId: { in: wineryIds } },
            { user: { email: { contains: run } } },
          ],
        },
      });
      await prisma.winery.deleteMany({ where: { id: { in: wineryIds } } });
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

  // ─── Cuenta (§1) ────────────────────────────────────────────────────────

  describe('recuperación de contraseña (IAM-05)', () => {
    it('de punta a punta: correo en Mailpit, contraseña nueva y todas las sesiones cerradas', async () => {
      const who = email('reset');
      const ip = nextIp();
      await http()
        .post('/v1/auth/signup')
        .set('X-Forwarded-For', ip)
        .send({ email: who, password: PASSWORD, fullName: 'Reinicio' })
        .expect(201);
      const before = await http()
        .post('/v1/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ email: who, password: PASSWORD })
        .expect(200);

      // Campo trampa o correo sin cuenta: 202 y ningún correo
      await http()
        .post('/v1/auth/forgot-password')
        .send({ email: who, captchaToken: 'ok', website: 'http://spam' })
        .expect(202);
      await http()
        .post('/v1/auth/forgot-password')
        .send({ email: email('nadie'), captchaToken: 'ok' })
        .expect(202);
      await expect(
        prisma.emailMessage.count({
          where: { toAddress: { in: [who, email('nadie')] } },
        }),
      ).resolves.toBe(0);
      // Sin captcha: 422
      await http()
        .post('/v1/auth/forgot-password')
        .send({ email: who })
        .expect(422);

      await http()
        .post('/v1/auth/forgot-password')
        .set('X-Client-App', 'ERP')
        .send({ email: who, captchaToken: 'XXXX.DUMMY.TOKEN.XXXX' })
        .expect(202);
      const message = await lastMail(who, 'recuperar-contrasena');
      await sendThroughWorker(message.id);
      const link = await mailpitLink(who);
      expect(link).toMatch(
        /^http:\/\/localhost:3002\/restablecer-contrasena\?token=/,
      );
      const token = decodeURIComponent(link.split('token=')[1]);

      const weak = await http()
        .post('/v1/auth/reset-password')
        .send({ token, password: 'password123' })
        .expect(422);
      expect(weak.body.error.code).toBe('AUTH_WEAK_PASSWORD');
      expect(weak.body.error.details[0].field).toBe('password');

      await http()
        .post('/v1/auth/reset-password')
        .send({ token, password: NEW_PASSWORD })
        .expect(204);
      const reused = await http()
        .post('/v1/auth/reset-password')
        .send({ token, password: NEW_PASSWORD })
        .expect(422);
      expect(reused.body.error.code).toBe('AUTH_RESET_TOKEN_INVALID');

      // La sesión anterior quedó revocada
      await http()
        .get('/v1/users/me')
        .set(auth(before.body.data.tokens.accessToken))
        .expect(401);
      await http()
        .post('/v1/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ email: who, password: NEW_PASSWORD })
        .expect(200);
      await lastMail(who, 'contrasena-cambiada');
    }, 60_000);
  });

  describe('verificación del correo, contraseña y preferencias (IAM-06, IAM-09)', () => {
    let token: string;
    let cookie: string;
    const who = email('prefs');

    beforeAll(async () => {
      const ip = nextIp();
      await http()
        .post('/v1/auth/signup')
        .set('X-Forwarded-For', ip)
        .send({ email: who, password: PASSWORD, fullName: 'Preferencias' })
        .expect(201);
      const login = await http()
        .post('/v1/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ email: who, password: PASSWORD })
        .expect(200);
      token = login.body.data.tokens.accessToken;
      cookie = cookieOf(login);
    });

    it('resend-verification y verify-email (un solo uso)', async () => {
      await http()
        .post('/v1/auth/resend-verification')
        .send({ email: who, captchaToken: 'ok' })
        .expect(202);
      const verifyToken = await linkToken(who, 'verificar-correo');
      await http()
        .post('/v1/auth/verify-email')
        .send({ token: verifyToken })
        .expect(204);
      const again = await http()
        .post('/v1/auth/verify-email')
        .send({ token: verifyToken })
        .expect(422);
      expect(again.body.error.code).toBe('AUTH_EMAIL_TOKEN_INVALID');
      const user = await prisma.user.findUniqueOrThrow({
        where: { email: who },
      });
      expect(user.emailVerifiedAt).not.toBeNull();
    });

    it('PATCH /users/me: preferencias parciales y consentimiento con fecha', async () => {
      const res = await http()
        .patch('/v1/users/me')
        .set(auth(token))
        .send({
          notificationPrefs: { redemptionReminders: false },
          promotionsConsent: true,
          preferredLocale: 'en',
        })
        .expect(200);
      expect(res.body.data).toMatchObject({
        user: {
          preferredLocale: 'en',
          notificationPrefs: { lotProgress: true, redemptionReminders: false },
          promotionsConsent: true,
        },
        memberships: [],
        activeOrganizationId: null,
      });
      const user = await prisma.user.findUniqueOrThrow({
        where: { email: who },
      });
      expect(user.promotionsConsentAt).toBeInstanceOf(Date);
      await http()
        .patch('/v1/users/me')
        .set(auth(token))
        .send({ preferredLocale: 'fr' })
        .expect(422);
    });

    it('POST /users/me/password: 422 si la actual no es; cierra las demás sesiones', async () => {
      const other = await http()
        .post('/v1/auth/login')
        .set('X-Forwarded-For', nextIp())
        .send({ email: who, password: PASSWORD })
        .expect(200);
      const wrong = await http()
        .post('/v1/users/me/password')
        .set(auth(token))
        .send({ currentPassword: 'otra-cosa-123', newPassword: NEW_PASSWORD })
        .expect(422);
      expect(wrong.body.error.code).toBe('AUTH_INVALID_CURRENT_PASSWORD');
      await http()
        .post('/v1/users/me/password')
        .set(auth(token))
        .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })
        .expect(204);
      await http().get('/v1/users/me').set(auth(token)).expect(200);
      await http()
        .get('/v1/users/me')
        .set(auth(other.body.data.tokens.accessToken))
        .expect(401);
      expect(cookie).toContain('doc_rt=');
    });
  });

  // ─── Segundo factor (§1, PLT-05) ────────────────────────────────────────

  describe('segundo factor TOTP', () => {
    const who = email('newstaff');

    beforeAll(async () => {
      await createPlatformUser(prisma, {
        email: who,
        password: PASSWORD,
        role: 'OPERATIONS',
        totpSecret: null,
      });
    });

    it('inscripción, verificación, códigos de recuperación y reto de un solo uso', async () => {
      const ip = nextIp();
      const login = await http()
        .post('/v1/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ email: who, password: PASSWORD })
        .expect(200);
      expect(login.body.data).toEqual({
        mfa: { required: true, enrolled: false, mfaToken: expect.any(String) },
      });
      expect(login.headers['set-cookie']).toBeUndefined();
      const mfaToken = login.body.data.mfa.mfaToken as string;

      const notEnrolled = await http()
        .post('/v1/auth/mfa/verify')
        .send({ mfaToken, code: '123456' })
        .expect(409);
      expect(notEnrolled.body.error.code).toBe('AUTH_MFA_NOT_ENROLLED');
      const notStarted = await http()
        .post('/v1/auth/mfa/enroll/confirm')
        .send({ mfaToken, code: '123456' })
        .expect(409);
      expect(notStarted.body.error.code).toBe(
        'AUTH_MFA_ENROLLMENT_NOT_STARTED',
      );

      const enroll = await http()
        .post('/v1/auth/mfa/enroll')
        .send({ mfaToken })
        .expect(200);
      expect(enroll.body.data.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
      const secret = enroll.body.data.secret as string;
      const again = await http()
        .post('/v1/auth/mfa/enroll')
        .send({ mfaToken })
        .expect(200);
      expect(again.body.data.secret).toBe(secret);

      const bad = await http()
        .post('/v1/auth/mfa/enroll/confirm')
        .send({ mfaToken, code: '000000' })
        .expect(401);
      expect(bad.body.error.code).toBe('AUTH_MFA_INVALID_CODE');

      const confirmed = await http()
        .post('/v1/auth/mfa/enroll/confirm')
        .send({ mfaToken, code: currentTotp(secret) })
        .expect(200);
      expect(confirmed.body.data.recoveryCodes).toHaveLength(10);
      expect(confirmed.body.data.activeOrganizationId).toBe(
        PLATFORM_ORGANIZATION_ID,
      );
      cookieOf(confirmed);
      const session = await prisma.session.findFirstOrThrow({
        where: { user: { email: who } },
        orderBy: { createdAt: 'desc' },
      });
      expect(session.mfaVerifiedAt).not.toBeNull();
      const stored = await prisma.userMfa.findUniqueOrThrow({
        where: { userId: session.userId },
      });
      expect(stored.secretEncrypted).not.toContain(secret);

      // El reto ya se usó
      const used = await http()
        .post('/v1/auth/mfa/verify')
        .send({ mfaToken, code: currentTotp(secret) })
        .expect(401);
      expect(used.body.error.code).toBe('AUTH_MFA_TOKEN_INVALID');

      // Código de recuperación: vale una vez
      const recovery = confirmed.body.data.recoveryCodes[0] as string;
      const second = await http()
        .post('/v1/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ email: who, password: PASSWORD })
        .expect(200);
      expect(second.body.data.mfa.enrolled).toBe(true);
      await http()
        .post('/v1/auth/mfa/verify')
        .send({
          mfaToken: second.body.data.mfa.mfaToken,
          code: recovery.toLowerCase(),
        })
        .expect(200);
      const third = await http()
        .post('/v1/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ email: who, password: PASSWORD })
        .expect(200);
      await http()
        .post('/v1/auth/mfa/verify')
        .send({ mfaToken: third.body.data.mfa.mfaToken, code: recovery })
        .expect(401);
    }, 60_000);

    it('5 códigos incorrectos seguidos → 429, aviso por correo y bloqueo temporal', async () => {
      const ip = nextIp();
      const login = await http()
        .post('/v1/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ email: who, password: PASSWORD })
        .expect(200);
      const mfaToken = login.body.data.mfa.mfaToken as string;
      // Un fallo ya contó en la prueba anterior (código de recuperación usado)
      await prisma.userMfa.updateMany({
        where: { user: { email: who } },
        data: { failedAttempts: 0 },
      });
      for (let i = 0; i < 4; i++) {
        await http()
          .post('/v1/auth/mfa/verify')
          .send({ mfaToken, code: '000000' })
          .expect(401);
      }
      const locked = await http()
        .post('/v1/auth/mfa/verify')
        .send({ mfaToken, code: '000000' })
        .expect(429);
      expect(locked.body.error.code).toBe('AUTH_TOO_MANY_ATTEMPTS');
      expect(locked.headers['retry-after']).toBe('300');
      await lastMail(who, 'segundo-factor-intentos-fallidos');

      const relogin = await http()
        .post('/v1/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ email: who, password: PASSWORD })
        .expect(200);
      await http()
        .post('/v1/auth/mfa/verify')
        .send({ mfaToken: relogin.body.data.mfa.mfaToken, code: '123456' })
        .expect(429);
    }, 60_000);
  });

  // ─── Invitaciones (§2) ──────────────────────────────────────────────────

  describe('invitaciones de una bodega', () => {
    it('reglas al crear: dueño reservado, ya miembro, pendiente, permisos', async () => {
      const owner = await http()
        .post('/v1/organizations/current/invitations')
        .set(auth(ownerToken))
        .send({ email: email('x'), role: 'OWNER' })
        .expect(403);
      expect(owner.body.error.code).toBe('ORG_OWNER_ROLE_RESERVED');

      const member = await http()
        .post('/v1/organizations/current/invitations')
        .set(auth(ownerToken))
        .send({ email: email('owner'), role: 'ENOLOGIST' })
        .expect(409);
      expect(member.body.error.code).toBe('ORG_ALREADY_MEMBER');

      const created = await http()
        .post('/v1/organizations/current/invitations')
        .set(auth(ownerToken))
        .send({ email: email('dup'), role: 'OPERATOR' })
        .expect(201);
      expect(created.body.data).toMatchObject({
        email: email('dup'),
        organizationId: wineryId,
        organizationType: 'WINERY',
        role: 'OPERATOR',
        status: 'PENDING',
        invitedBy: { viaPlatform: false },
      });
      const dup = await http()
        .post('/v1/organizations/current/invitations')
        .set(auth(ownerToken))
        .send({ email: email('dup'), role: 'OPERATOR' })
        .expect(409);
      expect(dup.body.error.code).toBe('INVITATION_ALREADY_PENDING');

      // El personal de plataforma no usa /organizations/current
      await http()
        .get('/v1/organizations/current/invitations')
        .set(auth(adminToken))
        .expect(403);
      const list = await http()
        .get('/v1/organizations/current/invitations?status=PENDING')
        .set(auth(ownerToken))
        .expect(200);
      expect(list.body.data.items.map((i: { id: string }) => i.id)).toContain(
        created.body.data.id,
      );
      const mail = await lastMail(email('dup'), 'invitacion');
      expect(
        (mail.variables as { enlace: string }).enlace.startsWith(
          'http://localhost:3002/invitacion/',
        ),
      ).toBe(true);
    });

    it('cuenta nueva: crea la cuenta verificada y abre sesión con la bodega activa', async () => {
      const who = email('enologa');
      await http()
        .post('/v1/organizations/current/invitations')
        .set(auth(ownerToken))
        .send({ email: who, role: 'ENOLOGIST' })
        .expect(201);
      const token = await linkToken(who, 'invitacion');

      const preview = await http().get(`/v1/invitations/${token}`).expect(200);
      expect(preview.body.data).toMatchObject({
        email: who,
        role: 'ENOLOGIST',
        status: 'PENDING',
        accountExists: false,
        organizationType: 'WINERY',
      });
      await http().get('/v1/invitations/token-que-no-existe').expect(404);

      const missing = await http()
        .post(`/v1/invitations/${token}/accept`)
        .send({})
        .expect(422);
      expect(missing.body.error.code).toBe('VALIDATION_ERROR');
      const weak = await http()
        .post(`/v1/invitations/${token}/accept`)
        .send({ fullName: 'Enóloga', password: '1234567890' })
        .expect(422);
      expect(weak.body.error.code).toBe('AUTH_WEAK_PASSWORD');

      const accepted = await http()
        .post(`/v1/invitations/${token}/accept`)
        .send({ fullName: 'Enóloga Nueva', password: NEW_PASSWORD })
        .expect(200);
      expect(accepted.body.data.activeOrganizationId).toBe(wineryId);
      expect(accepted.body.data.memberships).toEqual([
        expect.objectContaining({
          organizationId: wineryId,
          role: 'ENOLOGIST',
        }),
      ]);
      cookieOf(accepted);
      const user = await prisma.user.findUniqueOrThrow({
        where: { email: who },
      });
      expect(user.emailVerifiedAt).not.toBeNull();

      const again = await http()
        .post(`/v1/invitations/${token}/accept`)
        .send({ fullName: 'X', password: NEW_PASSWORD })
        .expect(409);
      expect(again.body.error.code).toBe('INVITATION_NOT_PENDING');

      // Una enóloga no gestiona invitaciones
      await http()
        .post('/v1/organizations/current/invitations')
        .set(auth(accepted.body.data.tokens.accessToken))
        .send({ email: email('y'), role: 'OPERATOR' })
        .expect(403);
    });

    it('cuenta existente: exige su sesión con el mismo correo', async () => {
      // La dueña de la otra bodega es invitada como contadora a esta
      const who = email('other');
      await http()
        .post('/v1/organizations/current/invitations')
        .set(auth(ownerToken))
        .send({ email: who, role: 'ACCOUNTANT' })
        .expect(201);
      const token = await linkToken(who, 'invitacion');
      const preview = await http().get(`/v1/invitations/${token}`).expect(200);
      expect(preview.body.data.accountExists).toBe(true);

      const anonymous = await http()
        .post(`/v1/invitations/${token}/accept`)
        .send({})
        .expect(401);
      expect(anonymous.body.error.code).toBe('AUTH_LOGIN_REQUIRED');
      const mismatch = await http()
        .post(`/v1/invitations/${token}/accept`)
        .set(auth(ownerToken))
        .set('Cookie', ownerCookie)
        .send({})
        .expect(403);
      expect(mismatch.body.error.code).toBe('INVITATION_EMAIL_MISMATCH');

      const login = await http()
        .post('/v1/auth/login')
        .set('X-Forwarded-For', nextIp())
        .send({ email: who, password: PASSWORD })
        .expect(200);
      const accepted = await http()
        .post(`/v1/invitations/${token}/accept`)
        .set(auth(login.body.data.tokens.accessToken))
        .set('Cookie', cookieOf(login))
        .send({})
        .expect(200);
      expect(accepted.body.data.activeOrganizationId).toBe(wineryId);
      expect(accepted.body.data.memberships).toHaveLength(2);
    });

    it('caducada, reenviada (el enlace anterior deja de valer) y anulada; 404 entre bodegas', async () => {
      const who = email('late');
      const created = await http()
        .post('/v1/organizations/current/invitations')
        .set(auth(ownerToken))
        .send({ email: who, role: 'AGRONOMIST' })
        .expect(201);
      const id = created.body.data.id as string;
      const oldToken = await linkToken(who, 'invitacion');
      await prisma.invitation.update({
        where: { id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const expired = await http()
        .post(`/v1/invitations/${oldToken}/accept`)
        .send({ fullName: 'Tarde', password: NEW_PASSWORD })
        .expect(422);
      expect(expired.body.error.code).toBe('INVITATION_EXPIRED');

      // Otra bodega no la ve
      await http()
        .post(`/v1/invitations/${id}/resend`)
        .set(auth(otherOwnerToken))
        .send({})
        .expect(404);
      const resent = await http()
        .post(`/v1/invitations/${id}/resend`)
        .set(auth(ownerToken))
        .send({})
        .expect(200);
      expect(resent.body.data.status).toBe('PENDING');
      await http().get(`/v1/invitations/${oldToken}`).expect(404);
      const newToken = await linkToken(who, 'invitacion');
      expect(newToken).not.toBe(oldToken);

      await http()
        .post(`/v1/invitations/${id}/revoke`)
        .set(auth(ownerToken))
        .send({})
        .expect(200);
      const revoked = await http()
        .post(`/v1/invitations/${id}/revoke`)
        .set(auth(ownerToken))
        .send({})
        .expect(409);
      expect(revoked.body.error.code).toBe('INVITATION_NOT_PENDING');
      const preview = await http()
        .get(`/v1/invitations/${newToken}`)
        .expect(200);
      expect(preview.body.data.status).toBe('REVOKED');
    });

    it('límite de colaboradores: activos + pendientes', async () => {
      const settings = app.get(SettingsService);
      const members = await prisma.membership.count({
        where: { organizationId: otherWineryId, status: 'ACTIVE' },
      });
      await settings.setOverrides(
        'equipo.maxColaboradoresPorBodega',
        [otherWineryId],
        members + 1,
        { reason: 'Prueba del límite' },
      );
      await http()
        .post('/v1/organizations/current/invitations')
        .set(auth(otherOwnerToken))
        .send({ email: email('cupo1'), role: 'OPERATOR' })
        .expect(201);
      const full = await http()
        .post('/v1/organizations/current/invitations')
        .set(auth(otherOwnerToken))
        .send({ email: email('cupo2'), role: 'OPERATOR' })
        .expect(422);
      expect(full.body.error.code).toBe('ORG_MEMBER_LIMIT_REACHED');
      expect(full.body.error.details[0].field).toBe('email');
    });
  });

  // ─── Usuarios internos y permisos (§5) ──────────────────────────────────

  describe('usuarios internos (PLT-02…05)', () => {
    it('lista, permisos por rol y matriz', async () => {
      const list = await http()
        .get('/v1/platform/users?role=SUPPORT')
        .set(auth(adminToken))
        .expect(200);
      expect(list.body.data.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            email: email('support'),
            status: 'ACTIVE',
            mfaEnabled: true,
            accountStatus: 'ACTIVE',
          }),
        ]),
      );
      await http()
        .get('/v1/platform/users')
        .set(auth(supportToken))
        .expect(403);
      await http().get('/v1/platform/users').set(auth(ownerToken)).expect(403);

      const matrix = await http()
        .get('/v1/platform/permissions')
        .set(auth(supportToken))
        .expect(200);
      expect(
        matrix.body.data.capabilities.find(
          (c: { key: string }) => c.key === 'platform.users',
        ).roles,
      ).toMatchObject({ ADMIN: 'FULL', SUPPORT: 'NONE', OWNER: 'NONE' });
    });

    it('invitar a un usuario interno: al aceptar pide inscribir el TOTP', async () => {
      const who = email('interno');
      const invited = await http()
        .post('/v1/platform/users')
        .set(auth(adminToken))
        .send({ email: who, role: 'SUPPORT', reason: 'Refuerzo de soporte' })
        .expect(201);
      expect(invited.body.data.organizationType).toBe('PLATFORM');
      await http()
        .post('/v1/platform/users')
        .set(auth(adminToken))
        .send({ email: email('x2'), role: 'SUPERADMIN' })
        .expect(422);
      const pending = await http()
        .get('/v1/platform/users?status=INVITED')
        .set(auth(adminToken))
        .expect(200);
      expect(pending.body.data.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            email: who,
            membershipId: null,
            invitationId: invited.body.data.id,
          }),
        ]),
      );

      const token = await linkToken(who, 'invitacion');
      const mail = await lastMail(who, 'invitacion');
      expect((mail.variables as { enlace: string }).enlace).toMatch(
        /^http:\/\/localhost:3003\/invitacion\//,
      );
      const accepted = await http()
        .post(`/v1/invitations/${token}/accept`)
        .send({ fullName: 'Soporte Nuevo', password: NEW_PASSWORD })
        .expect(200);
      expect(accepted.body.data.mfa).toMatchObject({
        required: true,
        enrolled: false,
      });
      const mfaToken = accepted.body.data.mfa.mfaToken as string;
      const enroll = await http()
        .post('/v1/auth/mfa/enroll')
        .send({ mfaToken })
        .expect(200);
      const session = await http()
        .post('/v1/auth/mfa/enroll/confirm')
        .send({ mfaToken, code: currentTotp(enroll.body.data.secret) })
        .expect(200);
      expect(session.body.data.activeOrganizationId).toBe(
        PLATFORM_ORGANIZATION_ID,
      );
    });

    it('switch a plataforma sin TOTP en la sesión → 403 AUTH_MFA_REQUIRED', async () => {
      // La dueña recibe una membresía de plataforma; su sesión no pasó el TOTP
      const owner = await prisma.user.findUniqueOrThrow({
        where: { email: email('owner') },
      });
      await prisma.membership.create({
        data: {
          userId: owner.id,
          organizationId: PLATFORM_ORGANIZATION_ID,
          role: 'SUPPORT',
        },
      });
      const res = await http()
        .post('/v1/auth/switch-organization')
        .set(auth(ownerToken))
        .set('Cookie', ownerCookie)
        .send({ organizationId: PLATFORM_ORGANIZATION_ID })
        .expect(403);
      expect(res.body.error.code).toBe('AUTH_MFA_REQUIRED');
      await prisma.membership.deleteMany({
        where: { userId: owner.id, organizationId: PLATFORM_ORGANIZATION_ID },
      });
    });

    it('cambiar rol, bloquear y restablecer el TOTP, con motivo y superusuario protegido', async () => {
      const noReason = await http()
        .patch(`/v1/platform/users/${supportMembershipId}`)
        .set(auth(adminToken))
        .send({ role: 'OPERATIONS' })
        .expect(422);
      expect(noReason.body.error.details[0].field).toBe('reason');

      const protectedSa = await http()
        .patch(`/v1/platform/users/${superadminMembershipId}`)
        .set(auth(adminToken))
        .send({ role: 'SUPPORT', reason: 'Probar la protección' })
        .expect(403);
      expect(protectedSa.body.error.code).toBe('PLATFORM_SUPERADMIN_PROTECTED');
      await http()
        .post(`/v1/platform/users/${superadminMembershipId}/block`)
        .set(auth(adminToken))
        .send({ reason: 'Probar la protección' })
        .expect(403);

      // Una membresía de bodega no es de plataforma: 404
      const wineryMembership = await prisma.membership.findFirstOrThrow({
        where: { organizationId: wineryId },
      });
      await http()
        .post(`/v1/platform/users/${wineryMembership.id}/block`)
        .set(auth(adminToken))
        .send({ reason: 'No es de plataforma' })
        .expect(404);

      const changed = await http()
        .patch(`/v1/platform/users/${supportMembershipId}`)
        .set(auth(adminToken))
        .send({ role: 'OPERATIONS', reason: 'Pasa a operaciones' })
        .expect(200);
      expect(changed.body.data.role).toBe('OPERATIONS');
      const audit = await prisma.auditEvent.findFirstOrThrow({
        where: {
          action: 'PLATFORM_USER_ROLE_CHANGED',
          resourceId: supportMembershipId,
        },
        orderBy: { seq: 'desc' },
      });
      expect(audit.reason).toBe('Pasa a operaciones');
      // Su acceso (con el rol anterior) deja de valer
      await http()
        .get('/v1/platform/permissions')
        .set(auth(supportToken))
        .expect(401);

      const blocked = await http()
        .post(`/v1/platform/users/${supportMembershipId}/block`)
        .set(auth(adminToken))
        .send({ reason: 'Vacaciones largas' })
        .expect(200);
      expect(blocked.body.data).toMatchObject({
        status: 'BLOCKED',
        blockedBy: 'PLATFORM',
      });
      await http()
        .post(`/v1/platform/users/${supportMembershipId}/unblock`)
        .set(auth(adminToken))
        .send({ reason: 'Vuelve' })
        .expect(200);

      const reset = await http()
        .post(`/v1/platform/users/${supportMembershipId}/reset-mfa`)
        .set(auth(adminToken))
        .send({ reason: 'Perdió el teléfono' })
        .expect(200);
      expect(reset.body.data.mfaEnabled).toBe(false);
      await lastMail(email('support'), 'segundo-factor-restablecido');
      const login = await http()
        .post('/v1/auth/login')
        .set('X-Forwarded-For', nextIp())
        .send({ email: email('support'), password: PASSWORD })
        .expect(200);
      expect(login.body.data.mfa.enrolled).toBe(false);
    });

    it('cuenta completa: bloquear (solo administración), estado y desbloquear', async () => {
      const target = await prisma.user.findUniqueOrThrow({
        where: { email: email('enologa') },
      });
      const superadmin = await prisma.user.findUniqueOrThrow({
        where: { email: email('superadmin') },
      });

      await http()
        .post(`/v1/platform/accounts/${superadmin.id}/block`)
        .set(auth(adminToken))
        .send({ reason: 'Probar la protección' })
        .expect(403);
      await http()
        .post(`/v1/platform/accounts/${target.id}/block`)
        .set(auth(otherOwnerToken))
        .send({ reason: 'No es plataforma' })
        .expect(403);

      const blocked = await http()
        .post(`/v1/platform/accounts/${target.id}/block`)
        .set(auth(adminToken))
        .send({ reason: 'Fraude' })
        .expect(200);
      expect(blocked.body.data).toMatchObject({
        status: 'BLOCKED',
        blockedReason: 'Fraude',
      });
      await http()
        .post('/v1/auth/login')
        .set('X-Forwarded-For', nextIp())
        .send({ email: target.email, password: NEW_PASSWORD })
        .expect(401);
      const detail = await http()
        .get(`/v1/platform/accounts/${target.id}`)
        .set(auth(adminToken))
        .expect(200);
      expect(detail.body.data).toMatchObject({
        status: 'BLOCKED',
        blockedReason: 'Fraude',
        memberships: [expect.objectContaining({ organizationId: wineryId })],
      });
      await http()
        .post(`/v1/platform/accounts/${target.id}/unblock`)
        .set(auth(adminToken))
        .send({ reason: 'Aclarado' })
        .expect(200);
    });

    it('recuperación enviada por la plataforma e invitaciones en nombre de una bodega', async () => {
      const target = await prisma.user.findUniqueOrThrow({
        where: { email: email('owner') },
      });
      await http()
        .post(`/v1/platform/users/${target.id}/send-password-reset`)
        .set(auth(adminToken))
        .send({ reason: 'Lo pidió por teléfono' })
        .expect(202);
      await lastMail(email('owner'), 'recuperar-contrasena');

      const invited = await http()
        .post(`/v1/platform/organizations/${wineryId}/invitations`)
        .set(auth(adminToken))
        .send({ email: email('viaplat'), role: 'OPERATOR', reason: 'Soporte' })
        .expect(201);
      expect(invited.body.data.invitedBy.viaPlatform).toBe(true);
      await lastMail(email('owner'), 'aviso-equipo');

      const list = await http()
        .get(
          `/v1/platform/organizations/${wineryId}/invitations?status=PENDING`,
        )
        .set(auth(adminToken))
        .expect(200);
      expect(list.body.data.items.map((i: { id: string }) => i.id)).toContain(
        invited.body.data.id,
      );
      await http()
        .get(
          `/v1/platform/organizations/${PLATFORM_ORGANIZATION_ID}/invitations`,
        )
        .set(auth(adminToken))
        .expect(404);
      await http()
        .post(`/v1/platform/organizations/${wineryId}/invitations`)
        .set(auth(ownerToken))
        .send({ email: email('z'), role: 'OPERATOR' })
        .expect(403);
      // La plataforma reenvía o anula las de cualquier bodega
      await http()
        .post(`/v1/invitations/${invited.body.data.id}/revoke`)
        .set(auth(adminToken))
        .send({ reason: 'Ya no hace falta' })
        .expect(200);
    });
  });
});
