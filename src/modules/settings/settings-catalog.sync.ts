import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '@shared/prisma/prisma.service';
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
        message: `Catálogo de configuración sincronizado (${result.upserted} parámetros)`,
        ...result,
      });
    } catch (error) {
      this.logger.error({
        message: 'No se pudo sincronizar el catálogo de configuración',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async sync(): Promise<{ upserted: number; deactivated: number }> {
    const keys = SETTINGS_CATALOG.map((entry) => entry.key);
    return this.prisma.$transaction(async (tx) => {
      for (const entry of SETTINGS_CATALOG) {
        const row = definitionRow(entry);
        const { key: _key, ...update } = row;
        await tx.settingDefinition.upsert({
          where: { key: entry.key },
          create: row,
          update,
        });
      }
      const { count } = await tx.settingDefinition.updateMany({
        where: { key: { notIn: keys }, isActive: true },
        data: { isActive: false },
      });
      return { upserted: keys.length, deactivated: count };
    });
  }
}
