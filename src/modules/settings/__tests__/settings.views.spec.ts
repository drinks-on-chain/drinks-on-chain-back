import { SettingsService, definitionView } from '../settings.service';
import { InMemorySettingsCache } from '../settings.cache';
import { SETTINGS_CATALOG, settingEntry } from '../settings.catalog';
import type { PrismaService } from '@shared/prisma/prisma.service';
import type { AuditService } from '@shared/audit/audit.service';
import type { OutboxService } from '@shared/outbox/outbox.service';

const WINERY = '11111111-1111-4111-8111-111111111111';
const ADMIN = '22222222-2222-4222-8222-222222222222';
const KEY = 'canje.ventanaDias';

function service(prisma: Record<string, unknown>) {
  return new SettingsService(
    {
      user: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: ADMIN, fullName: 'Jorge Salinas' }]),
      },
      ...prisma,
    } as unknown as PrismaService,
    {} as AuditService,
    {} as OutboxService,
    new InMemorySettingsCache(),
  );
}

describe('SettingsService (vistas del back office)', () => {
  it('definitionView: forma del contrato, sin campos vacíos', () => {
    const entry = settingEntry('trazabilidad.singani.reposoMinimoDias')!;
    const installedAt = new Date('2026-09-01T00:00:00.000Z');
    expect(
      definitionView(entry, {
        overridesCount: 0,
        installedAt,
        names: new Map(),
      }),
    ).toEqual({
      key: 'trazabilidad.singani.reposoMinimoDias',
      description: 'Reposo mínimo tras la destilación',
      type: 'NUMBER',
      unit: 'días',
      levels: 'GLOBAL_AND_WINERY',
      appliesAt: 'LOT',
      default: 180,
      min: 0,
      max: 3650,
      legalMinimum: 180,
      globalValue: 180,
      overridesCount: 0,
      updatedAt: '2026-09-01T00:00:00.000Z',
      updatedBy: null,
    });
    const list = definitionView(settingEntry('compra.maxBotellasPorCompra')!, {
      global: {
        value: null,
        updatedAt: new Date('2026-09-27T10:00:00.000Z'),
        updatedBy: ADMIN,
      },
      overridesCount: 2,
      names: new Map([[ADMIN, 'Jorge Salinas']]),
    });
    expect(list).toMatchObject({
      globalValue: null,
      overridesCount: 2,
      updatedAt: '2026-09-27T10:00:00.000Z',
      updatedBy: 'Jorge Salinas',
      legalMinimum: null,
    });
    expect(list).not.toHaveProperty('enumValues');
  });

  it('listDefinitions: todas las claves del catálogo con su número de ajustes', async () => {
    const svc = service({
      settingGlobalValue: {
        findMany: jest.fn().mockResolvedValue([
          {
            key: KEY,
            value: 40,
            updatedAt: new Date('2026-09-27T10:00:00.000Z'),
            updatedBy: ADMIN,
          },
        ]),
      },
      settingOverride: {
        groupBy: jest.fn().mockResolvedValue([{ key: KEY, _count: 3 }]),
      },
      settingDefinition: { findMany: jest.fn().mockResolvedValue([]) },
    });
    const defs = await svc.listDefinitions();
    expect(defs).toHaveLength(SETTINGS_CATALOG.length);
    expect(defs.find((d) => d.key === KEY)).toMatchObject({
      globalValue: 40,
      overridesCount: 3,
      updatedBy: 'Jorge Salinas',
    });
    expect(
      defs.find((d) => d.key === 'canje.ventanaVencida.accion'),
    ).toMatchObject({
      enumValues: ['BURN', 'EXTEND', 'COMPENSATE'],
      overridesCount: 0,
    });
  });

  it('history: sin valor propio se muestra el estándar que regía', async () => {
    const t = (iso: string) => new Date(iso);
    const changes = [
      // Del más reciente al más antiguo (como los devuelve la consulta)
      {
        id: 'c4',
        scope: 'WINERY',
        wineryId: WINERY,
        before: { value: 60 },
        after: null,
        reason: 'Volver al estándar',
        legalException: false,
        changedAt: t('2026-09-27T12:00:00Z'),
        changedBy: ADMIN,
      },
      {
        id: 'c3',
        scope: 'GLOBAL',
        wineryId: null,
        before: { value: 40 },
        after: { value: 45 },
        reason: 'Más plazo',
        legalException: false,
        changedAt: t('2026-09-26T12:00:00Z'),
        changedBy: ADMIN,
      },
      {
        id: 'c2',
        scope: 'WINERY',
        wineryId: WINERY,
        before: null,
        after: { value: 60 },
        reason: 'Ajuste de la bodega',
        legalException: false,
        changedAt: t('2026-09-25T12:00:00Z'),
        changedBy: null,
      },
      {
        id: 'c1',
        scope: 'GLOBAL',
        wineryId: null,
        before: { value: 30 },
        after: { value: 40 },
        reason: 'Primer cambio',
        legalException: false,
        changedAt: t('2026-09-24T12:00:00Z'),
        changedBy: ADMIN,
      },
    ];
    const findMany = jest.fn(({ where }: { where: { scope?: string } }) =>
      Promise.resolve(
        where.scope === 'GLOBAL'
          ? changes.filter((c) => c.scope === 'GLOBAL').reverse()
          : changes,
      ),
    );
    const svc = service({
      settingChange: {
        findMany,
        count: jest.fn().mockResolvedValue(4),
      },
      settingGlobalValue: {
        findUnique: jest.fn().mockResolvedValue({ key: KEY, value: 45 }),
      },
    });
    const { items, total } = await svc.history(KEY, { limit: 20, offset: 0 });
    expect(total).toBe(4);
    expect(items.map((i) => [i.scope, i.before, i.after, i.by])).toEqual([
      [WINERY, 60, 45, 'Jorge Salinas'],
      ['GLOBAL', 40, 45, 'Jorge Salinas'],
      [WINERY, 40, 60, 'Sistema'],
      ['GLOBAL', 30, 40, 'Jorge Salinas'],
    ]);
  });

  it('claves desconocidas → 404 en todas las vistas', async () => {
    const svc = service({});
    await expect(svc.definitionView('no.existe')).rejects.toMatchObject({
      errorCode: 'SETTING_NOT_FOUND',
    });
    await expect(
      svc.listOverrides('no.existe', { limit: 20, offset: 0 }),
    ).rejects.toMatchObject({ errorCode: 'SETTING_NOT_FOUND' });
    await expect(
      svc.history('no.existe', { limit: 20, offset: 0 }),
    ).rejects.toMatchObject({ errorCode: 'SETTING_NOT_FOUND' });
  });
});
