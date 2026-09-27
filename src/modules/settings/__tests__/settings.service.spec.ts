import { SettingsService } from '../settings.service';
import { InMemorySettingsCache } from '../settings.cache';
import { SETTINGS_CATALOG } from '../settings.catalog';
import type { PrismaService } from '@shared/prisma/prisma.service';
import type { AuditService } from '@shared/audit/audit.service';
import type { OutboxService } from '@shared/outbox/outbox.service';

const WINERY = '11111111-1111-1111-1111-111111111111';

function setup() {
  const prisma = {
    settingGlobalValue: {
      findMany: jest.fn().mockResolvedValue([
        { key: 'canje.ventanaDias', value: 45 },
        // Un estándar guardado para un parámetro solo por bodega se ignora
        { key: 'trazabilidad.excepcionMinimoLegal', value: true },
      ]),
    },
    settingOverride: {
      findMany: jest.fn().mockResolvedValue([
        {
          key: 'canje.ventanaDias',
          wineryId: WINERY,
          value: 60,
          legalException: false,
        },
        {
          key: 'trazabilidad.singani.reposoMinimoDias',
          wineryId: WINERY,
          value: 150,
          legalException: true,
        },
        // Un ajuste en un parámetro solo general se ignora
        {
          key: 'compra.minutosReserva',
          wineryId: WINERY,
          value: 10,
          legalException: false,
        },
      ]),
    },
  };
  const cache = new InMemorySettingsCache();
  const service = new SettingsService(
    prisma as unknown as PrismaService,
    {} as AuditService,
    {} as OutboxService,
    cache,
  );
  return { prisma, cache, service };
}

describe('SettingsService (resolución y caché)', () => {
  it('ajuste de la bodega → estándar general → valor por defecto', async () => {
    const { service } = setup();
    await expect(service.resolve('canje.ventanaDias', WINERY)).resolves.toEqual(
      {
        key: 'canje.ventanaDias',
        value: 60,
        source: 'WINERY',
        legalException: false,
      },
    );
    await expect(service.resolve('canje.ventanaDias')).resolves.toMatchObject({
      value: 45,
      source: 'GLOBAL',
    });
    await expect(
      service.effective('compra.minutosReserva', WINERY),
    ).resolves.toBe(30);
    await expect(
      service.resolve('trazabilidad.excepcionMinimoLegal', WINERY),
    ).resolves.toMatchObject({ value: false, source: 'DEFAULT' });
  });

  it('clave desconocida → 404 SETTING_NOT_FOUND', async () => {
    const { service } = setup();
    await expect(service.effective('no.existe')).rejects.toMatchObject({
      errorCode: 'SETTING_NOT_FOUND',
      statusCode: 404,
    });
  });

  it('usa la caché y vuelve a la base tras invalidar', async () => {
    const { service, prisma } = setup();
    await service.effective('canje.ventanaDias', WINERY);
    await service.effective('canje.ventanaDias', WINERY);
    expect(prisma.settingOverride.findMany).toHaveBeenCalledTimes(1);

    prisma.settingOverride.findMany.mockResolvedValueOnce([]);
    await service.invalidateCache();
    await expect(service.effective('canje.ventanaDias', WINERY)).resolves.toBe(
      45,
    );
    expect(prisma.settingOverride.findMany).toHaveBeenCalledTimes(2);
  });

  it('sin caché disponible lee siempre de la base', async () => {
    const { service, prisma, cache } = setup();
    cache.available = false;
    await service.effective('canje.ventanaDias', WINERY);
    await service.effective('canje.ventanaDias', WINERY);
    expect(prisma.settingOverride.findMany).toHaveBeenCalledTimes(2);
  });

  it('effectiveAll: todas las claves, WINERY o GLOBAL (el defecto es el estándar)', async () => {
    const { service } = setup();
    const all = await service.effectiveAll(WINERY);
    expect(all).toHaveLength(SETTINGS_CATALOG.length);
    expect(all.find((s) => s.key === 'canje.ventanaDias')).toMatchObject({
      value: 60,
      source: 'WINERY',
      appliesAt: 'IMMEDIATE',
    });
    expect(all.find((s) => s.key === 'invitacion.caducidadHoras')).toEqual({
      key: 'invitacion.caducidadHoras',
      description: 'Caducidad de las invitaciones',
      value: 72,
      source: 'GLOBAL',
      appliesAt: 'IMMEDIATE',
    });
  });

  it('snapshot: solo las reglas del lote, con origen y excepciones legales', async () => {
    const { service } = setup();
    const snap = await service.snapshot(WINERY);
    const lotKeys = SETTINGS_CATALOG.filter((e) => e.appliesAt === 'LOT').map(
      (e) => e.key,
    );
    expect(Object.keys(snap.values).sort()).toEqual(lotKeys.sort());
    expect(snap.values['trazabilidad.singani.reposoMinimoDias']).toBe(150);
    expect(snap.sources['trazabilidad.singani.reposoMinimoDias']).toBe(
      'WINERY',
    );
    expect(snap.legalExceptions).toEqual([
      'trazabilidad.singani.reposoMinimoDias',
    ]);
    expect(snap.values).not.toHaveProperty('canje.ventanaDias');
  });

  it('las escrituras exigen motivo', async () => {
    const { service } = setup();
    await expect(
      service.setGlobal('canje.ventanaDias', 40, { reason: ' ' }),
    ).rejects.toMatchObject({
      errorCode: 'VALIDATION_ERROR',
      details: [{ field: 'reason', message: expect.any(String) }],
    });
  });
});
