import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { DemoSeedSummary, seedDemo, selectDemoPeople } from './demo.seed';
import { loadMockFixtures, MockFixtures } from './fixtures';
import { applySeedCorrections, SEED_CORRECTIONS } from './corrections';
import {
  backfillHarvestChain,
  BackfillResult,
} from '../modules/lots/lot-backfill';
import { resolvePassportBaseUrl } from '../modules/lots/bottle-units';
import { AuditService } from '../shared/audit/audit.service';
import type { AuditEventInput } from '../shared/audit/audit.types';
import type { PrismaService } from '../shared/prisma/prisma.service';
import { ensurePlatformOrganization, upsertSuperadmin } from './platform.seed';
import { SeedOptions } from './seed.options';
import { DemoIdentitySummary, seedDemoIdentity } from './identity.seed';
import {
  DemoOrganizationsSummary,
  seedDemoOrganizations,
} from './organizations.seed';
import { ConfigService } from '@nestjs/config';
import { MfaCrypto } from '../modules/auth/mfa/mfa-crypto';

export interface SeedLogger {
  log(message: string): void;
  warn(message: string): void;
}

export interface SeedResult {
  superadmin: { id: string; created: boolean } | null;
  demo: DemoSeedSummary | null;
  identity: DemoIdentitySummary | null;
  organizations: DemoOrganizationsSummary | null;
  /** Relleno de lotes de la Ola 2 (uno por pesaje de demostración). */
  lots?: BackfillResult[];
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
    return { superadmin, demo: null, identity: null, organizations: null };
  }

  const fx = applySeedCorrections(fixtures ?? loadMockFixtures());
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
  const demoOptions = options.demo;
  const crypto =
    demoOptions.totpSecret && options.mfaKeys.jwtSecret
      ? new MfaCrypto(
          new ConfigService({
            JWT_SECRET: options.mfaKeys.jwtSecret,
            MFA_ENCRYPTION_KEY: options.mfaKeys.mfaEncryptionKey ?? undefined,
          }),
        )
      : null;
  const { demo, identity, organizations, lots } = await prisma.$transaction(
    async (tx) => {
      const summary = await seedDemo(tx, fx, hash);
      const ident = await seedDemoIdentity(tx, fx, {
        demoPassword: demoOptions.password,
        totpSecret: demoOptions.totpSecret,
        encryptTotp: crypto ? (secret) => crypto.encrypt(secret) : null,
      });
      const orgs = await seedDemoOrganizations(tx, fx, {
        demoPassword: demoOptions.password,
      });
      // Lotes de la Ola 2 (§2.6): la trazabilidad sembrada es "anterior" y se
      // rellena con la misma lógica que la migración (idempotente)
      const audit = new AuditService(prisma as unknown as PrismaService);
      const auditEntries: AuditEventInput[] = [];
      const lots: BackfillResult[] = [];
      for (const h of fx.harvestBatches) {
        lots.push(
          await backfillHarvestChain(tx, h.id, {
            passportBaseUrl: resolvePassportBaseUrl(process.env),
            // La entrada de bitácora se escribe al final (ver abajo)
            audit: (_client, input) => {
              auditEntries.push(input);
              return Promise.resolve();
            },
          }),
        );
        await tx.lotBackfillPending.deleteMany({
          where: { harvestBatchId: h.id },
        });
      }
      // Bitácora como **último paso** de la transacción: `record` toma el
      // candado de la cadena hasta el `COMMIT`, y es de toda la base de datos.
      // Tomarlo con el primer lote lo retenía mientras se generaban los
      // códigos de botella de los demás (decenas de segundos) y las demás
      // escrituras auditadas caducaban esperando. Las entradas siguen dentro
      // de la misma transacción y en el orden de los lotes.
      for (const entry of auditEntries) {
        await audit.record(tx, entry);
      }
      return { demo: summary, identity: ident, organizations: orgs, lots };
    },
    { maxWait: 10_000, timeout: 300_000 },
  );
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
  logger.log(
    `Invitaciones de demostración: ${identity.invitations}; segundo factor inscrito para ${identity.totpEnrolled} personas del equipo interno`,
  );
  for (const link of identity.links) {
    logger.log(
      `Invitación ${link.status} a ${link.email}: <APP_URL_${link.app}>${link.path}`,
    );
  }
  logger.log(
    `Solicitudes de alta de demostración: ${organizations.applications} (${organizations.applicationNotes} notas); perfil de ${organizations.profiles} bodegas (${organizations.statusChanges} cambios de estado)`,
  );
  for (const link of organizations.links) {
    logger.log(
      `Solicitud sin verificar de ${link.email}: <APP_URL_BODEGAS>${link.path}`,
    );
  }
  for (const warning of organizations.warnings) {
    logger.warn(`Semilla de bodegas: ${warning}`);
  }
  const createdLots = lots.filter((l) => l.lotId && !l.skipped);
  logger.log(
    `Lotes (Ola 2): ${createdLots.length} creados, ${lots.filter((l) => l.skipped === 'ALREADY_ASSIGNED').length} ya existían; ` +
      `${createdLots.reduce((n, l) => n + l.bottleCodes, 0)} códigos de botella; ` +
      `${createdLots.reduce((n, l) => n + l.issues.length, 0)} incidencias de cumplimiento`,
  );
  for (const c of SEED_CORRECTIONS) {
    logger.log(`Corrección de realismo aplicada: ${c.what}`);
  }
  return { superadmin, demo, identity, organizations, lots };
}
