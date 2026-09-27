import { existsSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { runSeed, SeedLogger } from './seed/run-seed';
import { SeedConfigError, seedOptionsFromEnv } from './seed/seed.options';

/**
 * Semilla de la base (0.10, OPS-09). Compilada en la imagen:
 *
 *   pnpm seed                         # local (lee .env)
 *   node dist/seed.js                 # imagen / contenedor
 *   docker compose -p doc-dev -f deploy/dev/compose.yml --env-file ~/doc-dev/.env \
 *     exec api node dist/seed.js      # servidor de desarrollo
 *
 * Variables: SUPERADMIN_EMAIL, SUPERADMIN_PASSWORD, SUPERADMIN_NAME,
 * SEED_DEMO, SEED_DEMO_PASSWORD (ver .env.example y el README).
 */
async function main(): Promise<void> {
  // En local, el .env de la raíz; en el contenedor, el entorno de compose
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  }

  const logger: SeedLogger = {
    log: (message) => console.log(`[seed] ${message}`),
    warn: (message) => console.warn(`[seed] AVISO: ${message}`),
  };

  const { options, warnings } = seedOptionsFromEnv(process.env);
  warnings.forEach((w) => logger.warn(w));

  const prisma = new PrismaClient();
  try {
    await runSeed(prisma, options, logger);
    logger.log('Semilla aplicada');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  if (error instanceof SeedConfigError) {
    console.error(`[seed] Configuración inválida: ${error.message}`);
  } else {
    console.error('[seed] Error al aplicar la semilla:', error);
  }
  process.exit(1);
});
