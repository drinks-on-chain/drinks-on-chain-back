import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@shared/prisma/prisma.service';
import { AuditService } from '@shared/audit/audit.service';
import { AuditAction } from '@shared/audit/audit.actions';
import { AppException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';
import { ValidationException } from '@shared/exceptions/validation.exception';
import { OutboxService } from '@shared/outbox/outbox.service';
import { QUEUE_DEFAULT } from '@shared/queue/queue.constants';
import { getRequestContext } from '@shared/context/request-context';
import { SETTINGS_CATALOG, settingEntry } from './settings.catalog';
import { ResolvedMap, SETTINGS_CACHE, SettingsCache } from './settings.cache';
import { validateSettingValue } from './settings.validation';
import {
  SETTING_AGGREGATE,
  SETTING_CHANGED,
  SettingChangedPayload,
} from './settings.events';
import type {
  EffectiveSettingView,
  ResolvedSetting,
  SettingCatalogEntry,
  SettingValue,
  SettingsSnapshot,
} from './settings.types';

/** Ámbito de caché del estándar general (sin bodega). */
const GLOBAL_SCOPE = '_global';

export interface SettingWriteOptions {
  /** Motivo (3–500), obligatorio: queda en el historial y en la bitácora. */
  reason: string;
}

export interface SettingOverrideOptions extends SettingWriteOptions {
  /** Autoriza un valor bajo el mínimo legal (A-31). Solo ADMIN: lo comprueba quien llama. */
  legalException?: boolean;
}

/** Envuelve un valor para el historial: `{ value }` o `null` (sin valor propio). */
function boxed(value: SettingValue | undefined): Prisma.InputJsonValue | null {
  return value === undefined ? null : ({ value } as Prisma.InputJsonObject);
}

/** Valor JSON para una columna `Json?`: `null` se guarda como JSON null. */
function jsonValue(
  value: SettingValue,
): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
}

function checkReason(reason: string | undefined): string {
  const trimmed = (reason ?? '').trim();
  if (trimmed.length < 3 || trimmed.length > 500) {
    throw ValidationException.forField(
      'reason',
      'El motivo es obligatorio (entre 3 y 500 caracteres)',
    );
  }
  return trimmed;
}

/**
 * Configuración en dos niveles (CFG-01, CFG-05; docs-back/07 §5).
 *
 * - Valor efectivo de una bodega = su ajuste si existe; si no, el estándar
 *   general; si tampoco, el valor por defecto del catálogo.
 * - Lecturas con caché en Redis por generación; cada escritura la invalida al
 *   confirmar y publica `setting.changed` por el outbox (el worker vuelve a
 *   invalidar por si la primera invalidación falló).
 * - Escrituras en una transacción con historial y bitácora. Los endpoints del
 *   back office (Ola 1) las exponen; aquí solo el servicio.
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    @Inject(SETTINGS_CACHE) private readonly cache: SettingsCache,
  ) {}

  /** Catálogo completo (definiciones del código). */
  catalog(): readonly SettingCatalogEntry[] {
    return SETTINGS_CATALOG;
  }

  /** Definición de `key` o 404 `SETTING_NOT_FOUND`. */
  definition(key: string): SettingCatalogEntry {
    const entry = settingEntry(key);
    if (!entry) {
      throw new AppException(
        404,
        ErrorCode.SETTING_NOT_FOUND,
        `El parámetro ${key} no existe`,
      );
    }
    return entry;
  }

  /** Valor efectivo de `key` para una bodega (o el estándar sin bodega). */
  async effective<T extends SettingValue = SettingValue>(
    key: string,
    wineryId?: string | null,
  ): Promise<T> {
    return (await this.resolve(key, wineryId)).value as T;
  }

  /** Valor efectivo con su origen. */
  async resolve(
    key: string,
    wineryId?: string | null,
  ): Promise<ResolvedSetting> {
    this.definition(key);
    const map = await this.resolvedMap(wineryId ?? null);
    return map[key];
  }

  /** Todos los valores efectivos de una bodega (`GET /organizations/current/settings`). */
  async effectiveAll(wineryId: string): Promise<EffectiveSettingView[]> {
    const map = await this.resolvedMap(wineryId);
    return SETTINGS_CATALOG.map((entry) => ({
      key: entry.key,
      description: entry.description,
      value: map[entry.key].value,
      source: map[entry.key].source === 'WINERY' ? 'WINERY' : 'GLOBAL',
      appliesAt: entry.appliesAt,
    }));
  }

  /**
   * Instantánea de las reglas que se fijan en el lote (`appliesAt = LOT`),
   * para guardarla en el lote al crearlo (CFG-06, Ola 2). Se lee de la base,
   * no de la caché: fija reglas para siempre.
   */
  async snapshot(wineryId: string): Promise<SettingsSnapshot> {
    const map = await this.loadFromDatabase(wineryId);
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
      takenAt: new Date().toISOString(),
      values,
      sources,
      legalExceptions,
    };
  }

  /** Cambia el estándar general (CFG-02). */
  async setGlobal(
    key: string,
    value: unknown,
    options: SettingWriteOptions,
  ): Promise<ResolvedSetting> {
    const entry = this.definition(key);
    const reason = checkReason(options.reason);
    const { value: normalized } = validateSettingValue(entry, value, {
      scope: 'GLOBAL',
    });
    const actor = getRequestContext()?.userId ?? null;

    await this.prisma.$transaction(async (tx) => {
      await this.ensureDefinition(tx, entry);
      const current = await tx.settingGlobalValue.findUnique({
        where: { key },
      });
      const before =
        current === null ? entry.default : (current.value as SettingValue);
      await tx.settingGlobalValue.upsert({
        where: { key },
        create: { key, value: jsonValue(normalized), updatedBy: actor },
        update: {
          value: jsonValue(normalized),
          version: { increment: 1 },
          updatedBy: actor,
        },
      });
      await tx.settingChange.create({
        data: {
          key,
          scope: 'GLOBAL',
          before: boxed(before) ?? Prisma.DbNull,
          after: boxed(normalized) ?? Prisma.DbNull,
          reason,
          changedBy: actor,
          correlationId: getRequestContext()?.correlationId ?? null,
        },
      });
      await this.outbox.add<SettingChangedPayload>(tx, {
        type: SETTING_CHANGED,
        aggregateType: SETTING_AGGREGATE,
        aggregateId: key,
        queue: QUEUE_DEFAULT,
        payload: { key, scope: 'GLOBAL', wineryIds: [] },
      });
      await this.audit.record(tx, {
        action: AuditAction.SETTING_CHANGED,
        resource: { type: 'setting', id: key },
        organizationId: null,
        before: { value: before },
        after: { value: normalized },
        reason,
      });
    });

    await this.invalidateCache();
    return this.resolve(key);
  }

  /**
   * Aplica un ajuste a una selección de bodegas o a todas (CFG-03, CFG-04),
   * en una transacción. `legalException` solo lo puede pedir ADMIN.
   */
  async setOverrides(
    key: string,
    wineryIds: string[] | 'ALL',
    value: unknown,
    options: SettingOverrideOptions,
  ): Promise<{ updated: number }> {
    const entry = this.definition(key);
    const reason = checkReason(options.reason);
    const { value: normalized, belowLegalMinimum } = validateSettingValue(
      entry,
      value,
      { scope: 'WINERY', legalException: options.legalException },
    );
    const actor = getRequestContext()?.userId ?? null;

    const updated = await this.prisma.$transaction(async (tx) => {
      await this.ensureDefinition(tx, entry);
      const ids = await this.targetWineries(tx, wineryIds);
      for (const wineryId of ids) {
        const current = await tx.settingOverride.findUnique({
          where: { key_wineryId: { key, wineryId } },
        });
        await tx.settingOverride.upsert({
          where: { key_wineryId: { key, wineryId } },
          create: {
            key,
            wineryId,
            value: jsonValue(normalized),
            legalException: belowLegalMinimum,
            reason,
            updatedBy: actor,
          },
          update: {
            value: jsonValue(normalized),
            legalException: belowLegalMinimum,
            reason,
            version: { increment: 1 },
            updatedBy: actor,
          },
        });
        await tx.settingChange.create({
          data: {
            key,
            scope: 'WINERY',
            wineryId,
            before:
              boxed(current ? (current.value as SettingValue) : undefined) ??
              Prisma.DbNull,
            after: boxed(normalized) ?? Prisma.DbNull,
            reason,
            legalException: belowLegalMinimum,
            changedBy: actor,
            correlationId: getRequestContext()?.correlationId ?? null,
          },
        });
        await this.audit.record(tx, {
          action: AuditAction.SETTING_OVERRIDE_SET,
          resource: { type: 'setting', id: key },
          organizationId: wineryId,
          before: current
            ? { value: current.value, legalException: current.legalException }
            : null,
          after: { value: normalized, legalException: belowLegalMinimum },
          reason,
        });
      }
      await this.outbox.add<SettingChangedPayload>(tx, {
        type: SETTING_CHANGED,
        aggregateType: SETTING_AGGREGATE,
        aggregateId: key,
        queue: QUEUE_DEFAULT,
        payload: { key, scope: 'WINERY', wineryIds: ids },
      });
      return ids.length;
    });

    await this.invalidateCache();
    return { updated };
  }

  /** "Volver al estándar": borra los ajustes (CFG-03). */
  async resetOverrides(
    key: string,
    wineryIds: string[] | 'ALL',
    options: SettingWriteOptions,
  ): Promise<{ reset: number }> {
    const entry = this.definition(key);
    const reason = checkReason(options.reason);
    const actor = getRequestContext()?.userId ?? null;

    const reset = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.settingOverride.findMany({
        where: {
          key,
          ...(wineryIds === 'ALL' ? {} : { wineryId: { in: wineryIds } }),
        },
      });
      for (const override of existing) {
        await tx.settingOverride.delete({ where: { id: override.id } });
        await tx.settingChange.create({
          data: {
            key,
            scope: 'WINERY',
            wineryId: override.wineryId,
            before: boxed(override.value as SettingValue) ?? Prisma.DbNull,
            after: Prisma.DbNull,
            reason,
            changedBy: actor,
            correlationId: getRequestContext()?.correlationId ?? null,
          },
        });
        await this.audit.record(tx, {
          action: AuditAction.SETTING_OVERRIDE_RESET,
          resource: { type: 'setting', id: entry.key },
          organizationId: override.wineryId,
          before: {
            value: override.value,
            legalException: override.legalException,
          },
          after: null,
          reason,
        });
      }
      if (existing.length > 0) {
        await this.outbox.add<SettingChangedPayload>(tx, {
          type: SETTING_CHANGED,
          aggregateType: SETTING_AGGREGATE,
          aggregateId: key,
          queue: QUEUE_DEFAULT,
          payload: {
            key,
            scope: 'WINERY',
            wineryIds: existing.map((o) => o.wineryId),
          },
        });
      }
      return existing.length;
    });

    if (reset > 0) await this.invalidateCache();
    return { reset };
  }

  /** Invalida la caché (tras un cambio o desde el worker). No lanza. */
  async invalidateCache(): Promise<void> {
    try {
      await this.cache.invalidate();
    } catch (error) {
      // El worker lo reintenta con el evento setting.changed; mientras
      // tanto, la caché caduca sola (SETTINGS_CACHE_TTL_SECONDS).
      this.logger.warn({
        message: 'No se pudo invalidar la caché de configuración',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async resolvedMap(wineryId: string | null): Promise<ResolvedMap> {
    const scope = wineryId ?? GLOBAL_SCOPE;
    const generation = await this.cache.generation();
    if (generation !== null) {
      const cached = await this.cache.get(generation, scope);
      if (cached && this.isComplete(cached)) return cached;
    }
    const map = await this.loadFromDatabase(wineryId);
    if (generation !== null) {
      await this.cache.set(generation, scope, map);
    }
    return map;
  }

  /** Una entrada vieja de la caché puede no tener claves nuevas del catálogo. */
  private isComplete(map: ResolvedMap): boolean {
    return SETTINGS_CATALOG.every((entry) => entry.key in map);
  }

  private async loadFromDatabase(
    wineryId: string | null,
  ): Promise<ResolvedMap> {
    const [globals, overrides] = await Promise.all([
      this.prisma.settingGlobalValue.findMany(),
      wineryId
        ? this.prisma.settingOverride.findMany({ where: { wineryId } })
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

  private async targetWineries(
    tx: Prisma.TransactionClient,
    wineryIds: string[] | 'ALL',
  ): Promise<string[]> {
    if (wineryIds === 'ALL') {
      const all = await tx.winery.findMany({
        where: { certificationStatus: { not: 'REVOKED' } },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });
      return all.map((w) => w.id);
    }
    const unique = [...new Set(wineryIds)];
    if (unique.length === 0) {
      throw ValidationException.forField(
        'wineryIds',
        'Indica al menos una bodega o ALL',
      );
    }
    const found = await tx.winery.findMany({
      where: { id: { in: unique } },
      select: { id: true },
    });
    if (found.length !== unique.length) {
      const known = new Set(found.map((w) => w.id));
      throw ValidationException.forField(
        'wineryIds',
        `Bodegas inexistentes: ${unique.filter((id) => !known.has(id)).join(', ')}`,
      );
    }
    return unique;
  }

  /** La definición debe existir en la tabla (clave foránea de los valores). */
  private async ensureDefinition(
    tx: Prisma.TransactionClient,
    entry: SettingCatalogEntry,
  ): Promise<void> {
    const exists = await tx.settingDefinition.findUnique({
      where: { key: entry.key },
      select: { key: true },
    });
    if (!exists) {
      await tx.settingDefinition.create({
        data: definitionRow(entry),
      });
    }
  }
}

/** Fila de `setting_definitions` para una entrada del catálogo. */
export function definitionRow(
  entry: SettingCatalogEntry,
): Prisma.SettingDefinitionCreateInput {
  return {
    key: entry.key,
    description: entry.description,
    type: entry.type,
    enumValues: [...(entry.enumValues ?? [])],
    unit: entry.unit ?? null,
    levels: entry.levels,
    appliesAt: entry.appliesAt,
    defaultValue: jsonValue(entry.default),
    min: entry.min ?? null,
    max: entry.max ?? null,
    integer: entry.integer ?? false,
    nullable: entry.nullable ?? entry.type === 'NUMBER_OR_UNLIMITED',
    legalMinimum:
      entry.legalMinimum === undefined || entry.legalMinimum === null
        ? Prisma.DbNull
        : (entry.legalMinimum as Prisma.InputJsonValue),
    isActive: true,
  };
}
