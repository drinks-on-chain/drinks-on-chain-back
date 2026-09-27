import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Prisma, SettingDefinition } from '@prisma/client';
import { PrismaService } from '@shared/prisma/prisma.service';
import { canonicalJson } from '@shared/utils/canonical-json';
import { SETTINGS_CATALOG } from './settings.catalog';
import { definitionRow } from './settings.service';

/**
 * Copia el catálogo del código a `setting_definitions` al arrancar la API
 * (idempotente: crea las nuevas, actualiza las existentes y marca como
 * inactivas las que el código ya no define). No toca valores ni ajustes.
 *
 * Si la base no está disponible, lo registra y sigue: la validación y la
 * resolución usan el catálogo del código; las escrituras crean la definición
 * que falte.
 */
@Injectable()
export class SettingsCatalogSync implements OnApplicationBootstrap {
  private readonly logger = new Logger(SettingsCatalogSync.name);

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const result = await this.sync();
      this.logger.log({
        message: `Catálogo de configuración sincronizado (${result.upserted} escritos, ${result.unchanged} sin cambios)`,
        ...result,
      });
    } catch (error) {
      this.logger.error({
        message: 'No se pudo sincronizar el catálogo de configuración',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Solo escribe lo que cambió: con el catálogo al día (lo normal) no abre
   * ninguna transacción, así que varias réplicas arrancando a la vez no se
   * bloquean entre sí.
   */
  async sync(): Promise<{
    upserted: number;
    unchanged: number;
    deactivated: number;
  }> {
    const keys = SETTINGS_CATALOG.map((entry) => entry.key);
    const current = await this.prisma.settingDefinition.findMany();
    const byKey = new Map(current.map((row) => [row.key, row]));
    const pending = SETTINGS_CATALOG.filter((entry) => {
      const row = byKey.get(entry.key);
      return !row || !sameDefinition(row, definitionRow(entry));
    });
    const stale = current.filter(
      (row) => row.isActive && !keys.includes(row.key),
    );
    if (pending.length === 0 && stale.length === 0) {
      return { upserted: 0, unchanged: keys.length, deactivated: 0 };
    }
    return this.prisma.$transaction(async (tx) => {
      for (const entry of pending) {
        const row = definitionRow(entry);
        const { key: _key, ...update } = row;
        await tx.settingDefinition.upsert({
          where: { key: entry.key },
          create: row,
          update,
        });
      }
      const { count } = await tx.settingDefinition.updateMany({
        where: { key: { in: stale.map((r) => r.key) } },
        data: { isActive: false },
      });
      return {
        upserted: pending.length,
        unchanged: keys.length - pending.length,
        deactivated: count,
      };
    });
  }
}

/** Compara la fila guardada con la del catálogo (campos que se copian). */
function sameDefinition(
  row: SettingDefinition,
  expected: Prisma.SettingDefinitionCreateInput,
): boolean {
  const norm = (v: unknown) => canonicalJson(v ?? null);
  return (
    row.description === expected.description &&
    row.type === expected.type &&
    norm(row.enumValues) === norm(expected.enumValues) &&
    (row.unit ?? null) === (expected.unit ?? null) &&
    row.levels === expected.levels &&
    row.appliesAt === expected.appliesAt &&
    norm(row.defaultValue) === norm(jsonOrNull(expected.defaultValue)) &&
    (row.min ?? null) === (expected.min ?? null) &&
    (row.max ?? null) === (expected.max ?? null) &&
    row.integer === expected.integer &&
    row.nullable === expected.nullable &&
    norm(row.legalMinimum) === norm(jsonOrNull(expected.legalMinimum)) &&
    row.isActive === true
  );
}

/** `Prisma.JsonNull` / `DbNull` → `null` para comparar. */
function jsonOrNull(value: unknown): unknown {
  return value === Prisma.JsonNull || value === Prisma.DbNull ? null : value;
}
