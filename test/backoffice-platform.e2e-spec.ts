import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { EmailStatusEnum, MembershipStatusEnum } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { AuditService } from '../src/shared/audit/audit.service';
import { SettingsService } from '../src/modules/settings/settings.service';
import { SETTINGS_CATALOG } from '../src/modules/settings/settings.catalog';
import { AuditQueryService } from '../src/modules/audit/audit-query.service';
import { deleteIdentityData } from './helpers/identity';
import {
  createActiveWinery,
  createMember,
  platformStaff,
  staffToken,
} from './helpers/staff-session';

type AuditItem = {
  seq: number;
  action: string;
  organizationId: string | null;
  actor: { fullName: string | null; viaPlatform: boolean };
  source: { app: string };
  resource: { type: string; id: string | null };
  reason: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

/**
 * Back office de la Ola 1 · configuración, bitácora y tablero (contrato O1
 * §6–§9) con Postgres y Redis reales: permisos por rol, 404 entre bodegas,
 * historial y bitácora de cada cambio, mínimo legal con excepción, volver al
 * estándar, exportación CSV, verificación de la cadena y tablero.
 */
describe('Back office: configuración, bitácora y tablero (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let audit: AuditService;

  const run = `bo-${Date.now()}`;
  const emailTag = `_${run}@test.bo`;
  const startedAt = new Date();
  // Claves que ninguna otra suite toca (las suites e2e corren en paralelo)
  const GLOBAL_KEY = 'puntos.maxCajerosPorPunto';
  const LEGAL_KEY = 'trazabilidad.singani.altitudMinimaMsnm';
  const touchedKeys = [GLOBAL_KEY, LEGAL_KEY];

  let wineryA: string;
  let wineryB: string;
  const tokens: Record<string, string> = {};
  let adminName: string;

  const api = () => request(app.getHttpServer());
  const as = (who: string) => ({
    Authorization: `Bearer ${tokens[who]}`,
    'X-Client-App': 'BACKOFFICE',
  });

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    audit = app.get(AuditService);

    const nit = Date.now().toString().slice(-8);
    wineryA = await createActiveWinery(prisma, {
      name: `Bodega A ${run}`,
      taxId: `BOA${nit}`,
    });
    wineryB = await createActiveWinery(prisma, {
      name: `Bodega B ${run}`,
      taxId: `BOB${nit}`,
    });

    for (const [key, role] of [
      ['admin', 'ADMIN'],
      ['ops', 'OPERATIONS'],
      ['support', 'SUPPORT'],
    ] as const) {
      const staff = await platformStaff(app, prisma, {
        email: `${key}${emailTag}`,
        fullName: `Personal ${key} ${run}`,
        role,
      });
      tokens[key] = staff.token;
      if (key === 'admin') adminName = staff.user.fullName;
    }
    for (const [key, organizationId, role] of [
      ['ownerA', wineryA, 'OWNER'],
      ['enologistA', wineryA, 'ENOLOGIST'],
      ['ownerB', wineryB, 'OWNER'],
    ] as const) {
      const { user } = await createMember(prisma, {
        email: `${key}${emailTag}`,
        fullName: `Miembro ${key} ${run}`,
        organizationId,
        role,
      });
      tokens[key] = await staffToken(app, {
        userId: user.id,
        email: user.email,
        organizationId,
        organizationType: 'WINERY',
        role,
      });
    }
    // Un colaborador bloqueado por la plataforma (tablero)
    const blocked = await createMember(prisma, {
      email: `blocked${emailTag}`,
      fullName: `Bloqueado ${run}`,
      organizationId: wineryB,
      role: 'OPERATOR',
    });
    await prisma.membership.update({
      where: { id: blocked.membership.id },
      data: {
        status: MembershipStatusEnum.BLOCKED,
        blockedBy: 'PLATFORM',
        blockedReason: 'Prueba',
      },
    });
  });

  afterAll(async () => {
    if (prisma && wineryA && wineryB) {
      const wineryIds = [wineryA, wineryB];
      await prisma.settingOverride.deleteMany({
        where: { wineryId: { in: wineryIds } },
      });
      await prisma.settingGlobalValue.deleteMany({
        where: { key: GLOBAL_KEY },
      });
      await prisma.settingChange.deleteMany({
        where: { key: { in: touchedKeys }, changedAt: { gte: startedAt } },
      });
      await prisma.outboxEvent.deleteMany({
        where: { eventType: 'setting.changed', createdAt: { gte: startedAt } },
      });
      await prisma.emailMessage.deleteMany({
        where: { toAddress: { endsWith: emailTag } },
      });
      await deleteIdentityData(prisma, { emailContains: emailTag, wineryIds });
      await prisma.user.deleteMany({
        where: { email: { endsWith: emailTag } },
      });
      await prisma.winery.deleteMany({ where: { id: { in: wineryIds } } });
      await app.get(SettingsService).invalidateCache();
    }
    await app?.close();
  });

  describe('configuración (§6)', () => {
    it('todo el personal lee las definiciones; una bodega no', async () => {
      const res = await api()
        .get('/v1/platform/settings')
        .set(as('support'))
        .expect(200);
      const defs = res.body.data as Record<string, unknown>[];
      expect(defs).toHaveLength(SETTINGS_CATALOG.length);
      expect(defs.find((d) => d.key === LEGAL_KEY)).toMatchObject({
        type: 'NUMBER',
        unit: 'msnm',
        levels: 'GLOBAL_AND_WINERY',
        appliesAt: 'LOT',
        default: 1600,
        legalMinimum: 1600,
        globalValue: 1600,
        overridesCount: expect.any(Number),
        updatedAt: expect.any(String),
      });
      await api().get('/v1/platform/settings').set(as('ownerA')).expect(403);
    });

    it('cambiar el estándar: solo ADMIN, con motivo, historial y bitácora', async () => {
      const path = `/v1/platform/settings/${GLOBAL_KEY}`;
      await api()
        .put(path)
        .set(as('ops'))
        .send({ value: 8, reason: 'No debería poder' })
        .expect(403);
      const noReason = await api()
        .put(path)
        .set(as('admin'))
        .send({ value: 8 })
        .expect(422);
      expect(noReason.body.error.details).toEqual([
        expect.objectContaining({ field: 'reason' }),
      ]);
      await api()
        .put(path)
        .set(as('admin'))
        .send({ value: 'ocho', reason: 'Tipo inválido' })
        .expect(422);

      const res = await api()
        .put(path)
        .set(as('admin'))
        .send({ value: 8, reason: `Más cajeros ${run}` })
        .expect(200);
      expect(res.body.data).toMatchObject({
        key: GLOBAL_KEY,
        globalValue: 8,
        updatedBy: adminName,
      });

      const history = await api()
        .get(`${path}/history`)
        .set(as('support'))
        .expect(200);
      expect(history.body.data.items[0]).toMatchObject({
        by: adminName,
        scope: 'GLOBAL',
        before: 5,
        after: 8,
        reason: `Más cajeros ${run}`,
      });

      const entry = await prisma.auditEvent.findFirst({
        where: { action: 'SETTING_CHANGED', reason: `Más cajeros ${run}` },
      });
      expect(entry).toMatchObject({
        resourceType: 'setting',
        resourceId: GLOBAL_KEY,
        before: { value: 5 },
        after: { value: 8 },
        sourceApp: 'BACKOFFICE',
        actorViaPlatform: true,
        actorFullName: adminName,
      });
    });

    it('niveles: 422 SETTING_LEVEL_NOT_ALLOWED', async () => {
      const onlyWinery = await api()
        .put('/v1/platform/settings/trazabilidad.excepcionMinimoLegal')
        .set(as('admin'))
        .send({ value: true, reason: 'Estándar de un parámetro por bodega' })
        .expect(422);
      expect(onlyWinery.body.error.code).toBe('SETTING_LEVEL_NOT_ALLOWED');
      const onlyGlobal = await api()
        .put('/v1/platform/settings/compra.minutosReserva/overrides')
        .set(as('admin'))
        .send({
          wineryIds: [wineryA],
          value: 15,
          reason: 'Ajuste no permitido',
        })
        .expect(422);
      expect(onlyGlobal.body.error.code).toBe('SETTING_LEVEL_NOT_ALLOWED');
      await api()
        .get('/v1/platform/settings/no.existe/history')
        .set(as('support'))
        .expect(404);
    });

    it('ajuste bajo el mínimo legal: 422 sin excepción, aceptado con excepción ADMIN', async () => {
      const path = `/v1/platform/settings/${LEGAL_KEY}/overrides`;
      const below = await api()
        .put(path)
        .set(as('admin'))
        .send({ wineryIds: [wineryA], value: 1500, reason: 'Sin excepción' })
        .expect(422);
      expect(below.body.error.code).toBe('SETTING_BELOW_LEGAL_MINIMUM');

      await api()
        .put(path)
        .set(as('support'))
        .send({
          wineryIds: [wineryA],
          value: 1500,
          reason: 'Soporte no ajusta',
          legalException: true,
        })
        .expect(403);

      await api()
        .put(path)
        .set(as('admin'))
        .send({
          wineryIds: [wineryA],
          value: 1500,
          reason: `Excepción autorizada ${run}`,
          legalException: true,
        })
        .expect(200)
        .expect(({ body }) => expect(body.data).toEqual({ updated: 1 }));
      // Un ajuste normal en B (para la bitácora de cada dueño)
      await api()
        .put(path)
        .set(as('admin'))
        .send({ wineryIds: [wineryB], value: 1800, reason: `Más alto ${run}` })
        .expect(200);

      const list = await api().get(path).set(as('ops')).expect(200);
      const items = list.body.data.items as Record<string, unknown>[];
      expect(items.find((o) => o.wineryId === wineryA)).toMatchObject({
        wineryName: `Bodega A ${run}`,
        value: 1500,
        legalException: true,
        reason: `Excepción autorizada ${run}`,
        updatedBy: adminName,
      });
      expect(items.find((o) => o.wineryId === wineryB)).toMatchObject({
        value: 1800,
        legalException: false,
      });

      // Cada bodega ve su valor efectivo; un dueño no ve la de otra (404)
      const own = await api()
        .get('/v1/organizations/current/settings')
        .set(as('ownerA'))
        .expect(200);
      expect(
        (own.body.data as { key: string }[]).find((s) => s.key === LEGAL_KEY),
      ).toMatchObject({ value: 1500, source: 'WINERY' });
      await api()
        .get(`/v1/organizations/current/settings?wineryId=${wineryB}`)
        .set(as('ownerA'))
        .expect(404);
      // La plataforma indica la bodega
      await api()
        .get('/v1/organizations/current/settings')
        .set(as('support'))
        .expect(422);
      const viaPlatform = await api()
        .get(`/v1/organizations/current/settings?wineryId=${wineryB}`)
        .set(as('support'))
        .expect(200);
      expect(
        (viaPlatform.body.data as { key: string }[]).find(
          (s) => s.key === LEGAL_KEY,
        ),
      ).toMatchObject({ value: 1800, source: 'WINERY' });
    });

    it('volver al estándar: solo lo seleccionado, con historial', async () => {
      const path = `/v1/platform/settings/${LEGAL_KEY}/overrides/reset`;
      await api()
        .post(path)
        .set(as('admin'))
        .send({
          wineryIds: ['00000000-0000-4000-8000-00000000dead'],
          reason: 'Bodega inexistente',
        })
        .expect(422);
      await api()
        .post(path)
        .set(as('admin'))
        .send({ wineryIds: [wineryA], reason: `Volver al estándar ${run}` })
        .expect(200)
        .expect(({ body }) => expect(body.data).toEqual({ reset: 1 }));

      await expect(
        app.get(SettingsService).resolve(LEGAL_KEY, wineryA),
      ).resolves.toMatchObject({ value: 1600, legalException: false });
      await expect(
        app.get(SettingsService).resolve(LEGAL_KEY, wineryB),
      ).resolves.toMatchObject({ value: 1800, source: 'WINERY' });

      const history = await api()
        .get(`/v1/platform/settings/${LEGAL_KEY}/history?limit=100`)
        .set(as('support'))
        .expect(200);
      const ofA = (
        history.body.data.items as {
          scope: string;
          before: unknown;
          after: unknown;
        }[]
      ).filter((h) => h.scope === wineryA);
      // Del más reciente al más antiguo; sin ajuste = estándar vigente (1600)
      expect(ofA.slice(0, 2).map((h) => [h.before, h.after])).toEqual([
        [1500, 1600],
        [1600, 1500],
      ]);
    });
  });

  describe('bitácora (§7)', () => {
    it('consulta con filtros, seq descendente, solo plataforma', async () => {
      const res = await api()
        .get(
          `/v1/platform/audit?resourceType=setting&resourceId=${LEGAL_KEY}&from=${startedAt.toISOString()}`,
        )
        .set(as('support'))
        .expect(200);
      const items = res.body.data.items as AuditItem[];
      expect(res.body.data).toMatchObject({ limit: 20, offset: 0 });
      expect(items.length).toBeGreaterThanOrEqual(3);
      const seqs = items.map((i) => i.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
      expect(items.map((i) => i.action)).toEqual(
        expect.arrayContaining([
          'SETTING_OVERRIDE_SET',
          'SETTING_OVERRIDE_RESET',
        ]),
      );

      const byOrg = await api()
        .get(
          `/v1/platform/audit?organizationId=${wineryB}&action=SETTING_OVERRIDE_SET`,
        )
        .set(as('ops'))
        .expect(200);
      expect(
        (byOrg.body.data.items as AuditItem[]).every(
          (i) => i.organizationId === wineryB,
        ),
      ).toBe(true);
      expect(byOrg.body.data.total).toBeGreaterThanOrEqual(1);

      const invalid = await api()
        .get('/v1/platform/audit?from=ayer&actorId=x')
        .set(as('support'))
        .expect(422);
      expect(
        (invalid.body.error.details as { field: string }[]).map((d) => d.field),
      ).toEqual(expect.arrayContaining(['from', 'actorId']));
      await api().get('/v1/platform/audit').set(as('ownerA')).expect(403);
    });

    it('la bitácora del dueño: su bodega (también lo que hizo la plataforma), no la de otras', async () => {
      const res = await api()
        .get('/v1/organizations/current/audit?resourceType=setting&limit=100')
        .set(as('ownerA'))
        .expect(200);
      const items = res.body.data.items as AuditItem[];
      expect(items.length).toBeGreaterThanOrEqual(2);
      expect(items.every((i) => i.organizationId === wineryA)).toBe(true);
      expect(items[0]).toMatchObject({
        action: 'SETTING_OVERRIDE_RESET',
        actor: { viaPlatform: true, fullName: adminName },
        source: { app: 'BACKOFFICE' },
      });

      const b = await api()
        .get('/v1/organizations/current/audit')
        .set(as('ownerB'))
        .expect(200);
      expect(
        (b.body.data.items as AuditItem[]).some(
          (i) => i.organizationId === wineryA,
        ),
      ).toBe(false);

      // Otra bodega → 404; organizationId no es un filtro del dueño → 422
      await api()
        .get(`/v1/organizations/current/audit?wineryId=${wineryB}`)
        .set(as('ownerA'))
        .expect(404);
      await api()
        .get(`/v1/organizations/current/audit?organizationId=${wineryB}`)
        .set(as('ownerA'))
        .expect(422);
      // Solo el dueño
      await api()
        .get('/v1/organizations/current/audit')
        .set(as('enologistA'))
        .expect(403);
      // La plataforma, con la bodega indicada
      const viaPlatform = await api()
        .get(`/v1/organizations/current/audit?wineryId=${wineryA}`)
        .set(as('support'))
        .expect(200);
      expect(viaPlatform.body.data.total).toBeGreaterThanOrEqual(
        res.body.data.total,
      );
    });

    it('exportación CSV: cabeceras de descarga, contenido seguro y límite', async () => {
      await audit.recordStandalone({
        action: 'E2E_CSV_EXPORT',
        resource: { type: 'e2e_csv', id: run },
        reason: '=HYPERLINK("http://malo")',
        after: { note: 'uno, dos' },
      });
      await audit.recordStandalone({
        action: 'E2E_CSV_EXPORT',
        resource: { type: 'e2e_csv', id: run },
        reason: 'Motivo "normal"',
      });

      const res = await api()
        .get(`/v1/platform/audit/export?resourceType=e2e_csv&resourceId=${run}`)
        .set(as('support'))
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
        /^attachment; filename="bitacora-\d{8}-\d{4}\.csv"$/,
      );
      const body = res.body as string;
      expect(body.startsWith('﻿')).toBe(true);
      const lines = body.slice(1).split('\r\n').filter(Boolean);
      expect(lines[0].split(',')[0]).toBe('seq');
      expect(lines).toHaveLength(3);
      // Orden cronológico; la fórmula queda neutralizada
      expect(lines[1]).toContain(`"'=HYPERLINK(""http://malo"")"`);
      expect(lines[1]).toContain('"{""note"":""uno, dos""}"');
      expect(lines[2]).toContain('"Motivo ""normal"""');

      const count = jest
        .spyOn(app.get(AuditQueryService), 'count')
        .mockResolvedValueOnce(50_001);
      const tooLarge = await api()
        .get('/v1/platform/audit/export')
        .set(as('admin'))
        .expect(422);
      expect(tooLarge.body.error.code).toBe('AUDIT_EXPORT_TOO_LARGE');
      count.mockRestore();

      await api()
        .get('/v1/platform/audit/export')
        .set(as('ownerA'))
        .expect(403);
    });

    it('verificación (ADMIN): válida, y rota tras una manipulación simulada', async () => {
      const row = await audit.recordStandalone({
        action: 'E2E_VERIFY_TARGET',
        resource: { type: 'e2e', id: run },
        after: { amount: 10 },
      });
      const at = row.occurredAt.toISOString();
      const path = `/v1/platform/audit/verify?from=${at}&to=${at}`;

      await api().get(path).set(as('ops')).expect(403);
      const ok = await api().get(path).set(as('admin')).expect(200);
      expect(ok.body.data).toMatchObject({ valid: true, firstBrokenSeq: null });
      expect(ok.body.data.checked).toBeGreaterThanOrEqual(1);

      // Simula a alguien con permisos de superusuario que salta el trigger
      // (solo en esta prueba; se restaura al terminar)
      const tamper = (amount: number) =>
        prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            'ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update_delete',
          );
          await tx.$executeRawUnsafe(
            `UPDATE audit_events SET after = '{"amount": ${amount}}'::jsonb WHERE id = '${row.id}'`,
          );
          await tx.$executeRawUnsafe(
            'ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update_delete',
          );
        });
      await tamper(1000);
      try {
        const broken = await api().get(path).set(as('admin')).expect(200);
        expect(broken.body.data).toMatchObject({
          valid: false,
          firstBrokenSeq: Number(row.seq),
        });
      } finally {
        await tamper(10);
      }
      await api()
        .get(path)
        .set(as('admin'))
        .expect(200)
        .expect(({ body }) => expect(body.data.valid).toBe(true));
    });
  });

  describe('tablero (§8)', () => {
    it('contadores, alertas y los 5 últimos eventos; solo plataforma', async () => {
      await prisma.emailMessage.create({
        data: {
          template: 'e2e',
          toAddress: `fallido${emailTag}`,
          status: EmailStatusEnum.FAILED,
          lastError: 'SMTP caído (prueba)',
        },
      });
      const res = await api()
        .get('/v1/platform/dashboard')
        .set(as('support'))
        .expect(200);
      const data = res.body.data;
      expect(data).toMatchObject({
        applications: {
          unverified: expect.any(Number),
          received: expect.any(Number),
          inReview: expect.any(Number),
          meetingScheduled: expect.any(Number),
        },
        invitations: {
          pending: expect.any(Number),
          expiringIn24h: expect.any(Number),
        },
      });
      expect(data.wineries.active).toBeGreaterThanOrEqual(2);
      expect(data.team.blockedMembers).toBeGreaterThanOrEqual(1);
      expect(data.alerts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'emails-failed', level: 'CRITICAL' }),
        ]),
      );
      const recent = data.recentAudit as AuditItem[];
      expect(recent).toHaveLength(5);
      expect(recent.map((e) => e.seq)).toEqual(
        [...recent.map((e) => e.seq)].sort((a, b) => b - a),
      );

      await api().get('/v1/platform/dashboard').set(as('ownerA')).expect(403);
    });
  });
});
