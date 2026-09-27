import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { DemoSeedSummary, seedDemo, selectDemoPeople } from './demo.seed';
import { loadMockFixtures, MockFixtures } from './fixtures';
import { ensurePlatformOrganization, upsertSuperadmin } from './platform.seed';
import { SeedOptions } from './seed.options';

export interface SeedLogger {
  log(message: string): void;
  warn(message: string): void;
}

export interface SeedResult {
  superadmin: { id: string; created: boolean } | null;
  demo: DemoSeedSummary | null;
}

const silentLogger: SeedLogger = {
  log: () => undefined,
  warn: () => undefined,
};

/**
 * Semilla determinista e idempotente (0.10, OPS-09):
 *
 * 1. Organización de plataforma (siempre).
 * 2. Superusuario desde `SUPERADMIN_*` (si está definido).
 * 3. Con `SEED_DEMO=true`: personal interno de demo, bodegas del catálogo de
 *    prueba con sus estados y membresías, y la trazabilidad del ERP de los
 *    fixtures de los mocks, en una sola transacción.
 */
export async function runSeed(
  prisma: PrismaClient,
  options: SeedOptions,
  logger: SeedLogger = silentLogger,
  fixtures?: MockFixtures,
): Promise<SeedResult> {
  await ensurePlatformOrganization(prisma);
  logger.log('Organización de plataforma lista');

  let superadmin: SeedResult['superadmin'] = null;
  if (options.superadmin) {
    const hash = await bcrypt.hash(
      options.superadmin.password,
      options.bcryptRounds,
    );
    superadmin = await upsertSuperadmin(prisma, options.superadmin, hash);
    logger.log(
      `Superusuario ${options.superadmin.email} ${superadmin.created ? 'creado' : 'actualizado'} (SUPERADMIN de la plataforma)`,
    );
  }

  if (!options.demo) {
    logger.log('Sin datos de demostración (SEED_DEMO distinto de true)');
    return { superadmin, demo: null };
  }

  const fx = fixtures ?? loadMockFixtures();
  const people = selectDemoPeople(fx);
  if (
    options.superadmin &&
    people.included.some((u) => u.email === options.superadmin?.email)
  ) {
    throw new Error(
      'SUPERADMIN_EMAIL coincide con una persona de demostración: usa otro correo',
    );
  }
  const hash = await bcrypt.hash(options.demo.password, options.bcryptRounds);
  const demo = await prisma.$transaction((tx) => seedDemo(tx, fx, hash), {
    maxWait: 10_000,
    timeout: 120_000,
  });
  logger.log(
    `Datos de demostración de ${fx.source.package} ${fx.source.git ?? fx.source.version} (día de referencia ${fx.source.referenceDay}): ` +
      `${demo.users} personas, ${demo.wineries} bodegas, ${demo.wineryMemberships} membresías de bodega, ` +
      `${demo.platformMemberships} de plataforma, ${demo.terroirs} parcelas, ${demo.harvestBatches} vendimias, ` +
      `${demo.fermentationTanks} tanques, ${demo.fermentationLogs} lecturas, ${demo.enologicalTreatments} tratamientos, ` +
      `${demo.wineAgings} crianzas, ${demo.productionBatches} destilaciones, ${demo.bottlingBatches} embotellados, ` +
      `${demo.labAnalyses} análisis`,
  );
  for (const { user, reason } of people.skipped) {
    logger.log(`No se crea ${user.email} (${reason})`);
  }
  return { superadmin, demo };
}
