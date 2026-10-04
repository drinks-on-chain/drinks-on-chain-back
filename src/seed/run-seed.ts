import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { DemoSeedSummary, seedDemo, selectDemoPeople } from './demo.seed';
import { loadMockFixtures, MockFixtures } from './fixtures';
import { applySeedCorrections, SEED_CORRECTIONS } from './corrections';
import { DemoLotsSummary, seedDemoLots } from './lots.seed';
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
  /** Lotes de demostración (Ola 2): creados, ya existentes y saltados. */
  lots?: DemoLotsSummary;
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
 *    prueba con sus estados y membresías, y los lotes de demostración de los
 *    fixtures de los mocks con toda su trazabilidad, en una sola transacción.
 *    Los lotes son de solo inserción: los que ya existen no se tocan.
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
      const { summary, people: context } = await seedDemo(tx, fx, hash);
      const ident = await seedDemoIdentity(tx, fx, {
        demoPassword: demoOptions.password,
        totpSecret: demoOptions.totpSecret,
        encryptTotp: crypto ? (secret) => crypto.encrypt(secret) : null,
      });
      const orgs = await seedDemoOrganizations(tx, fx, {
        demoPassword: demoOptions.password,
      });
      // Lotes de demostración (después de las bodegas: usan su prefijo de lote)
      const audit = new AuditService(prisma as unknown as PrismaService);
      const auditEntries: AuditEventInput[] = [];
      const lots = await seedDemoLots(tx, fx, {
        passportBaseUrl: resolvePassportBaseUrl(process.env),
        people: context,
        // La entrada de bitácora se escribe al final (ver abajo)
        audit: (entry) => auditEntries.push(entry),
      });
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
      `${demo.platformMemberships} de plataforma y ${demo.terroirs} parcelas`,
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
  const stages = new Map<string, number>();
  for (const lot of lots.created) {
    stages.set(lot.stage, (stages.get(lot.stage) ?? 0) + 1);
  }
  logger.log(
    `Lotes de demostración: ${lots.created.length} creados` +
      (lots.created.length > 0
        ? ` (${[...stages].map(([stage, n]) => `${n} ${stage}`).join(', ')}; ` +
          `${lots.created.filter((l) => l.dossierClosed).length} con el expediente cerrado; ` +
          `${lots.bottleCodes.toLocaleString('es-BO')} códigos de botella)`
        : '') +
      `, ${lots.existing} ya existían (no se tocan), ${lots.skipped.length} sin crear; ` +
      `${lots.unassignedHarvests} pesajes sin lote`,
  );
  for (const warning of lots.warnings) {
    logger.warn(`Semilla de lotes: ${warning}`);
  }
  for (const c of SEED_CORRECTIONS) {
    logger.log(`Corrección de realismo aplicada: ${c.what}`);
  }
  return { superadmin, demo, identity, organizations, lots };
}
