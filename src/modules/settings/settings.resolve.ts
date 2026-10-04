import type { Prisma, PrismaClient } from '@prisma/client';
import { SETTINGS_CATALOG } from './settings.catalog';
import type { ResolvedMap } from './settings.cache';
import type { SettingValue, SettingsSnapshot } from './settings.types';

/** Cliente con el que se leen los valores (el de la API o una transacción). */
export type SettingsReader = Pick<
  PrismaClient | Prisma.TransactionClient,
  'settingGlobalValue' | 'settingOverride'
>;

/**
 * Valores efectivos de una bodega (o el estándar sin bodega) leídos de la
 * base: su ajuste si existe; si no, el estándar general; si tampoco, el valor
 * por defecto del catálogo. Sin caché: lo usan `SettingsService` y la
 * instantánea del lote, también dentro de una transacción (relleno de la
 * migración, semilla).
 */
export async function resolveSettingsFromDatabase(
  client: SettingsReader,
  wineryId: string | null,
): Promise<ResolvedMap> {
  const [globals, overrides] = await Promise.all([
    client.settingGlobalValue.findMany(),
    wineryId
      ? client.settingOverride.findMany({ where: { wineryId } })
      : Promise.resolve([]),
  ]);
  const globalByKey = new Map(globals.map((g) => [g.key, g]));
  const overrideByKey = new Map(overrides.map((o) => [o.key, o]));

  const map: ResolvedMap = {};
  for (const entry of SETTINGS_CATALOG) {
    const override = overrideByKey.get(entry.key);
    const global = globalByKey.get(entry.key);
    if (override && entry.levels !== 'GLOBAL') {
      map[entry.key] = {
        key: entry.key,
        value: override.value as SettingValue,
        source: 'WINERY',
        legalException: override.legalException,
      };
    } else if (global && entry.levels !== 'WINERY') {
      map[entry.key] = {
        key: entry.key,
        value: global.value as SettingValue,
        source: 'GLOBAL',
        legalException: false,
      };
    } else {
      map[entry.key] = {
        key: entry.key,
        value: entry.default,
        source: 'DEFAULT',
        legalException: false,
      };
    }
  }
  return map;
}

/**
 * Instantánea de las reglas que se fijan en el lote (`appliesAt = LOT`,
 * CFG-06) a partir de los valores efectivos.
 */
export function snapshotFromResolved(
  wineryId: string,
  map: ResolvedMap,
  takenAt: Date = new Date(),
): SettingsSnapshot {
  const values: SettingsSnapshot['values'] = {};
  const sources: SettingsSnapshot['sources'] = {};
  const legalExceptions: string[] = [];
  for (const entry of SETTINGS_CATALOG) {
    if (entry.appliesAt !== 'LOT') continue;
    const resolved = map[entry.key];
    values[entry.key] = resolved.value;
    sources[entry.key] = resolved.source;
    if (resolved.legalException) legalExceptions.push(entry.key);
  }
  return {
    wineryId,
    takenAt: takenAt.toISOString(),
    values,
    sources,
    legalExceptions,
  };
}

/** Instantánea leída de la base con `client` (API o transacción). */
export async function readSettingsSnapshot(
  client: SettingsReader,
  wineryId: string,
  takenAt: Date = new Date(),
): Promise<SettingsSnapshot> {
  return snapshotFromResolved(
    wineryId,
    await resolveSettingsFromDatabase(client, wineryId),
    takenAt,
  );
}
