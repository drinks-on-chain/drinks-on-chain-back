import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { SettingsService } from '../src/modules/settings/settings.service';
import { SettingsCatalogSync } from '../src/modules/settings/settings-catalog.sync';
import { SETTINGS_CATALOG } from '../src/modules/settings/settings.catalog';
import { deleteIdentityData } from './helpers/identity';
import { wineryWithOwner } from './helpers/staff-session';

/**
 * Configuración con Postgres y Redis reales: catálogo sincronizado, valor
 * efectivo (bodega → estándar → defecto) con caché e invalidación, mínimos
 * legales, historial, bitácora y lectura por HTTP.
 */
describe('Configuración (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let settings: SettingsService;

  const run = `cfg-${Date.now()}`;
  const email = `settings_${run}@test.bo`;
  const consumerEmail = `consumidor_${run}@test.bo`;
  const startedAt = new Date();
  const touchedKeys = [
    'canje.ventanaDias',
    'trazabilidad.singani.altitudMinimaMsnm',
    'puntos.maxPorBodega',
  ];
  let wineryId: string;
  let consumerToken: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    settings = app.get(SettingsService);

    // Dueña de una bodega activa (alta + invitación aceptada desde H1)
    const owned = await wineryWithOwner(app, {
      name: `Bodega ${run}`,
      taxId: `CFG${Date.now().toString().slice(-9)}`,
      email,
      password: 'Password123!',
      fullName: 'Dueña Configuración',
    });
    wineryId = owned.wineryId;

    // Un consumidor (sin membresías) para comprobar el 403
    const signup = await request(app.getHttpServer())
      .post('/v1/auth/signup')
      .send({
        email: consumerEmail,
        password: 'Password123!',
        fullName: 'Consumidor Configuración',
      })
      .expect(201);
    consumerToken = signup.body.data.tokens.accessToken as string;
  });

  afterAll(async () => {
    // Sin bodega (falló el beforeAll) no se borra nada: un where vacío borraría todo
    if (prisma && wineryId) {
      await prisma.settingOverride.deleteMany({ where: { wineryId } });
      await prisma.settingGlobalValue.deleteMany({
        where: { key: { in: touchedKeys } },
      });
      await prisma.settingChange.deleteMany({
        where: { key: { in: touchedKeys }, changedAt: { gte: startedAt } },
      });
      await prisma.outboxEvent.deleteMany({
        where: {
          eventType: 'setting.changed',
          createdAt: { gte: startedAt },
        },
      });
      await deleteIdentityData(prisma, {
        emailContains: email,
        wineryIds: [wineryId],
      });
      await prisma.userWallet.deleteMany({ where: { user: { email } } });
      await prisma.wineryMember.deleteMany({ where: { user: { email } } });
      await prisma.userWallet.deleteMany({ where: { wineryId } });
      await prisma.winery.deleteMany({ where: { id: wineryId } });
      await prisma.user.deleteMany({ where: { email } });
      await deleteIdentityData(prisma, { emailContains: consumerEmail });
      await prisma.userWallet.deleteMany({
        where: { user: { email: consumerEmail } },
      });
      await prisma.user.deleteMany({ where: { email: consumerEmail } });
      await settings.invalidateCache();
    }
    await app?.close();
  });

  it('al arrancar copia el catálogo completo a setting_definitions (idempotente)', async () => {
    const keys = SETTINGS_CATALOG.map((e) => e.key);
    await expect(
      prisma.settingDefinition.count({
        where: { key: { in: keys }, isActive: true },
      }),
    ).resolves.toBe(keys.length);
    // Con el catálogo al día no escribe nada; si una fila se desvía, la corrige
    await expect(app.get(SettingsCatalogSync).sync()).resolves.toEqual({
      upserted: 0,
      unchanged: keys.length,
      deactivated: 0,
    });
    await prisma.settingDefinition.update({
      where: { key: 'canje.ventanaDias' },
      data: { max: 1 },
    });
    await expect(app.get(SettingsCatalogSync).sync()).resolves.toMatchObject({
      upserted: 1,
    });
    const reposo = await prisma.settingDefinition.findUnique({
      where: { key: 'trazabilidad.singani.reposoMinimoDias' },
    });
    expect(reposo).toMatchObject({
      type: 'NUMBER',
      levels: 'GLOBAL_AND_WINERY',
      appliesAt: 'LOT',
      defaultValue: 180,
      legalMinimum: 180,
    });
  });

  it('estándar general: historial, bitácora, outbox y caché invalidada', async () => {
    await settings.invalidateCache();
    await expect(
      settings.effective('canje.ventanaDias', wineryId),
    ).resolves.toBe(30);

    await settings.setGlobal('canje.ventanaDias', 40, {
      reason: `Prueba ${run}`,
    });
    await expect(
      settings.effective('canje.ventanaDias', wineryId),
    ).resolves.toBe(40);

    const change = await prisma.settingChange.findFirst({
      where: { key: 'canje.ventanaDias', reason: `Prueba ${run}` },
    });
    expect(change).toMatchObject({
      scope: 'GLOBAL',
      before: { value: 30 },
      after: { value: 40 },
    });
    await expect(
      prisma.auditEvent.findFirst({
        where: { action: 'SETTING_CHANGED', reason: `Prueba ${run}` },
      }),
    ).resolves.toMatchObject({
      resourceType: 'setting',
      resourceId: 'canje.ventanaDias',
      before: { value: 30 },
      after: { value: 40 },
    });
    await expect(
      prisma.outboxEvent.count({
        where: {
          eventType: 'setting.changed',
          aggregateId: 'canje.ventanaDias',
          createdAt: { gte: startedAt },
        },
      }),
    ).resolves.toBeGreaterThanOrEqual(1);
  });

  it('lee de la caché hasta que se invalida', async () => {
    await settings.invalidateCache();
    await expect(
      settings.effective('puntos.maxPorBodega', wineryId),
    ).resolves.toBe(3);
    // Cambio por fuera del servicio: la caché sigue sirviendo el valor viejo
    await prisma.settingGlobalValue.create({
      data: { key: 'puntos.maxPorBodega', value: 7 },
    });
    await expect(
      settings.effective('puntos.maxPorBodega', wineryId),
    ).resolves.toBe(3);
    await settings.invalidateCache();
    await expect(
      settings.effective('puntos.maxPorBodega', wineryId),
    ).resolves.toBe(7);
  });

  it('ajuste por bodega bajo el mínimo legal: 422 sin excepción, marcado con ella', async () => {
    const key = 'trazabilidad.singani.altitudMinimaMsnm';
    await expect(
      settings.setOverrides(key, [wineryId], 1500, { reason: 'Sin excepción' }),
    ).rejects.toMatchObject({ errorCode: 'SETTING_BELOW_LEGAL_MINIMUM' });

    await expect(
      settings.setOverrides(key, [wineryId], 1500, {
        reason: 'Excepción autorizada por administración',
        legalException: true,
      }),
    ).resolves.toEqual({ updated: 1 });

    await expect(settings.resolve(key, wineryId)).resolves.toEqual({
      key,
      value: 1500,
      source: 'WINERY',
      legalException: true,
    });
    const snapshot = await settings.snapshot(wineryId);
    expect(snapshot.values[key]).toBe(1500);
    expect(snapshot.legalExceptions).toContain(key);
    await expect(
      prisma.auditEvent.findFirst({
        where: { action: 'SETTING_OVERRIDE_SET', organizationId: wineryId },
      }),
    ).resolves.toMatchObject({
      after: { value: 1500, legalException: true },
    });
  });

  it('GET /v1/organizations/current/settings devuelve el valor efectivo de la bodega', async () => {
    // Un consumidor (sin membresías) no es personal: 403
    await request(app.getHttpServer())
      .get('/v1/organizations/current/settings')
      .set('Authorization', `Bearer ${consumerToken}`)
      .expect(403);

    const login = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send({ email, password: 'Password123!' })
      .expect(200);
    const token = login.body.data.tokens.accessToken as string;

    const res = await request(app.getHttpServer())
      .get('/v1/organizations/current/settings')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const items = res.body.data as {
      key: string;
      value: unknown;
      source: string;
    }[];
    expect(items).toHaveLength(SETTINGS_CATALOG.length);
    expect(
      items.find((i) => i.key === 'trazabilidad.singani.altitudMinimaMsnm'),
    ).toMatchObject({ value: 1500, source: 'WINERY', appliesAt: 'LOT' });
    expect(items.find((i) => i.key === 'canje.ventanaDias')).toMatchObject({
      value: 40,
      source: 'GLOBAL',
    });
  });

  it('volver al estándar borra el ajuste', async () => {
    const key = 'trazabilidad.singani.altitudMinimaMsnm';
    await expect(
      settings.resetOverrides(key, [wineryId], {
        reason: 'Volver al estándar',
      }),
    ).resolves.toEqual({ reset: 1 });
    await expect(settings.resolve(key, wineryId)).resolves.toMatchObject({
      value: 1600,
      source: 'DEFAULT',
      legalException: false,
    });
    const history = await prisma.settingChange.findMany({
      where: { key, wineryId },
      orderBy: { changedAt: 'asc' },
    });
    expect(history.map((h) => [h.before, h.after])).toEqual([
      [null, { value: 1500 }],
      [{ value: 1500 }, null],
    ]);
  });
});
