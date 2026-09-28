import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PLATFORM_ORGANIZATION_ID } from '../src/modules/organizations/organization.constants';
import { loadMockFixtures } from '../src/seed/fixtures';
import { applySeedCorrections } from '../src/seed/corrections';
import { mockId } from '../src/seed/ids';
import { runSeed } from '../src/seed/run-seed';
import { SeedOptions } from '../src/seed/seed.options';
import { demoInvitationToken } from '../src/seed/identity.seed';
import { demoApplicationToken } from '../src/seed/organizations.seed';
import { hashOpaqueToken } from '../src/shared/security/opaque-token';
import { TEST_TOTP_SECRET, testMfaCrypto } from './helpers/identity';

/**
 * Semilla de demostración (0.10, OPS-09) sobre una base vacía: un esquema
 * propio de Postgres con las migraciones aplicadas, para no depender de lo que
 * dejen las demás suites (que corren a la vez sobre `public`).
 */
const run = `${Date.now()}${randomBytes(3).toString('hex')}`;
const schema = `seed_e2e_${run}`;
const baseUrl = process.env.DATABASE_URL ?? '';
const originalUrl = process.env.DATABASE_URL;

function urlWithSchema(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('schema', name);
  return parsed.toString();
}

const databaseUrl = urlWithSchema(baseUrl, schema);
const DEMO_PASSWORD = `demo-${randomBytes(8).toString('hex')}`;
const options: SeedOptions = {
  superadmin: {
    email: `superadmin.${run}@example.test`,
    password: `super-${randomBytes(8).toString('hex')}`,
    fullName: 'Superusuario de la prueba',
  },
  demo: { password: DEMO_PASSWORD, totpSecret: TEST_TOTP_SECRET },
  bcryptRounds: 4,
  mfaKeys: {
    jwtSecret: process.env.JWT_SECRET ?? null,
    mfaEncryptionKey: process.env.MFA_ENCRYPTION_KEY ?? null,
  },
};

const fx = loadMockFixtures();
/** Lo que siembra: los fixtures con las correcciones de realismo de la Ola 2. */
const seeded = applySeedCorrections(fx);
const ALTOS = mockId('winery:altos');
const CINTI_VIEJO = mockId('winery:cintiviejo');

async function countAll(prisma: PrismaClient) {
  const [
    users,
    organizations,
    memberships,
    wineries,
    wineryMembers,
    wallets,
    terroirs,
    harvestBatches,
    tanks,
    logs,
    treatments,
    agings,
    productions,
    bottlings,
    labs,
    applications,
    applicationNotes,
    statusChanges,
    lots,
    bottleUnits,
    complianceIssues,
    lotEvents,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.organization.count(),
    prisma.membership.count(),
    prisma.winery.count(),
    prisma.wineryMember.count(),
    prisma.userWallet.count(),
    prisma.terroir.count(),
    prisma.harvestBatch.count(),
    prisma.fermentationTank.count(),
    prisma.fermentationLog.count(),
    prisma.enologicalTreatment.count(),
    prisma.wineAgingBatch.count(),
    prisma.productionBatch.count(),
    prisma.bottlingBatch.count(),
    prisma.batchLabAnalysis.count(),
    prisma.wineryApplication.count(),
    prisma.wineryApplicationNote.count(),
    prisma.wineryStatusChange.count(),
    prisma.lot.count(),
    prisma.bottleUnit.count(),
    prisma.lotComplianceIssue.count(),
    prisma.lotEvent.count(),
  ]);
  return {
    users,
    organizations,
    memberships,
    wineries,
    wineryMembers,
    wallets,
    terroirs,
    harvestBatches,
    tanks,
    logs,
    treatments,
    agings,
    productions,
    bottlings,
    labs,
    applications,
    applicationNotes,
    statusChanges,
    lots,
    bottleUnits,
    complianceIssues,
    lotEvents,
  };
}

describe('Semilla de demostración (e2e, 0.10 OPS-09)', () => {
  let prisma: PrismaClient;
  let app: INestApplication | undefined;
  let ipSeq = 1;
  const nextIp = () => `10.210.${Math.floor(Math.random() * 200)}.${ipSeq++}`;

  beforeAll(async () => {
    // Esquema vacío con todas las migraciones
    execFileSync(
      process.execPath,
      [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
      {
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: 'pipe',
      },
    );
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    if (prisma) {
      await prisma.$executeRawUnsafe(
        `DROP SCHEMA IF EXISTS "${schema}" CASCADE`,
      );
      await prisma.$disconnect();
    }
    process.env.DATABASE_URL = originalUrl;
  });

  it('se aplica dos veces sobre una base vacía sin errores ni duplicados', async () => {
    const first = await runSeed(prisma, options, undefined, fx);
    const afterFirst = await countAll(prisma);
    const second = await runSeed(prisma, options, undefined, fx);
    const afterSecond = await countAll(prisma);

    expect(afterSecond).toEqual(afterFirst);
    expect(first.superadmin?.created).toBe(true);
    expect(second.superadmin?.created).toBe(false);
    expect(second.superadmin?.id).toBe(first.superadmin?.id);
    expect(second.demo).toEqual(first.demo);

    // Mismo contenido que los fixtures de los mocks
    const demo = first.demo!;
    expect(afterFirst).toMatchObject({
      // superusuario + personas de demostración
      users: demo.users + 1,
      // plataforma + bodegas
      organizations: fx.wineries.length + 1,
      wineries: fx.wineries.length,
      wineryMembers: demo.wineryMemberships,
      memberships: demo.wineryMemberships + demo.platformMemberships + 1,
      // superusuario + billeteras de las personas de demostración
      wallets: demo.wallets + 1,
      terroirs: fx.terroirs.length,
      harvestBatches: fx.harvestBatches.length,
      tanks: seeded.fermentationTanks.length,
      logs: seeded.fermentationLogs.length,
      treatments: seeded.enologicalTreatments.length,
      agings: seeded.wineAgings.length,
      productions: seeded.productionBatches.length,
      bottlings: fx.bottlingBatches.length,
      labs: fx.labAnalyses.length,
      applications: fx.applications.length,
      // Ola 2: un lote por pesaje, un código por botella y la semilla sin
      // incidencias de cumplimiento (sus datos cumplen las reglas)
      lots: fx.harvestBatches.length,
      bottleUnits: seeded.bottlingBatches.reduce(
        (n, b) => n + b.totalBottlesPackaged,
        0,
      ),
      complianceIssues: 0,
      statusChanges: fx.wineryProfiles.reduce(
        (n, p) => n + p.statusHistory.length,
        0,
      ),
    });
    // Personal interno ADMIN, OPERATIONS, SUPPORT (sin el SUPERADMIN de los mocks)
    expect(demo.platformMemberships).toBe(4);
    expect(demo.users).toBe(17);
  }, 120_000);

  it('conserva ids, estados, códigos y bloqueos de los mocks', async () => {
    const altos = await prisma.organization.findUniqueOrThrow({
      where: { id: ALTOS },
    });
    expect(altos).toMatchObject({
      type: 'WINERY',
      name: 'Bodega Altos de Calamuchita',
      status: 'ACTIVE',
      wineryId: ALTOS,
    });
    const statuses = await prisma.winery.findMany({
      select: { id: true, certificationStatus: true },
    });
    expect(
      Object.fromEntries(statuses.map((w) => [w.id, w.certificationStatus])),
    ).toEqual(
      Object.fromEntries(fx.wineries.map((w) => [w.id, w.certificationStatus])),
    );

    // Una persona en dos bodegas: enóloga en Altos y dueña de Casa Uriondo
    const sofia = await prisma.user.findUniqueOrThrow({
      where: { email: 'sofia@aramayo.test' },
      include: { memberships: { orderBy: { role: 'asc' } } },
    });
    expect(sofia.id).toBe(mockId('user:sofia'));
    expect(sofia.memberships.map((m) => [m.organizationId, m.role])).toEqual(
      expect.arrayContaining([
        [ALTOS, 'ENOLOGIST'],
        [mockId('winery:uriondo'), 'OWNER'],
      ]),
    );

    // Bloqueo por la plataforma (Cinti Viejo) con su motivo
    const blocked = await prisma.membership.findUniqueOrThrow({
      where: { id: mockId('member:cvj_contable:cintiviejo') },
    });
    expect(blocked).toMatchObject({
      organizationId: CINTI_VIEJO,
      role: 'ACCOUNTANT',
      status: 'BLOCKED',
      blockedBy: 'PLATFORM',
    });
    // En las bodegas, membresía y miembro comparten id
    await expect(
      prisma.wineryMember.findUniqueOrThrow({ where: { id: blocked.id } }),
    ).resolves.toMatchObject({ isActive: false });

    const staff = await prisma.membership.findMany({
      where: { organizationId: PLATFORM_ORGANIZATION_ID },
      include: { user: { select: { email: true } } },
    });
    expect(staff.map((m) => `${m.user.email}:${m.role}`).sort()).toEqual(
      [
        'administracion@drinksonchain.test:ADMIN',
        'analista@drinksonchain.test:OPERATIONS',
        'operaciones@drinksonchain.test:OPERATIONS',
        'soporte@drinksonchain.test:SUPPORT',
        `${options.superadmin!.email}:SUPERADMIN`,
      ].sort(),
    );
    await expect(
      prisma.user.findUnique({ where: { email: 'gestor@drinksonchain.test' } }),
    ).resolves.toBeNull();

    // Trazabilidad con los códigos y fechas de los fixtures
    const lot = await prisma.bottlingBatch.findUniqueOrThrow({
      where: { internationalLotCode: 'CVJ-2026-SINGANI-001' },
      include: { labAnalyses: true, productionBatch: true, lot: true },
    });
    expect(lot.id).toBe(mockId('bottling:b01'));
    expect(lot.bottlingDate.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(lot.labAnalyses.map((l) => l.id)).toEqual([mockId('lab:l01')]);
    expect(lot.labAnalyses[0].conformityStatus).toBe('CONFORMING');
    expect(lot.productionBatch?.restStatus).toBe('BOTTLED');
    // El lote migrado: UUID v5 del pesaje, etapa y código de lote
    expect(lot.lot).toMatchObject({
      stage: 'BOTTLED',
      productType: 'SINGANI',
      lotCode: 'CVJ-2026-SINGANI-001',
      rulesOrigin: 'MIGRATION',
    });
  });

  it('invitaciones de demostración con token secreto y TOTP del personal interno', async () => {
    const invitations = await prisma.invitation.findMany();
    expect(invitations).toHaveLength(fx.invitations.length);
    const padcaya = fx.invitations.find(
      (i) => i._mock.token === 'demo-invitacion-padcaya',
    )!;
    const row = invitations.find((i) => i.id === padcaya.id)!;
    expect(row.tokenHash).toBe(
      hashOpaqueToken(
        demoInvitationToken(DEMO_PASSWORD, 'demo-invitacion-padcaya'),
      ),
    );
    // El token legible de los mocks no sirve
    expect(row.tokenHash).not.toBe(hashOpaqueToken('demo-invitacion-padcaya'));
    expect(row.status).toBe('PENDING');
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
    const soporte = invitations.find(
      (i) => i.email === 'soporte2@drinksonchain.test',
    )!;
    expect(soporte.organizationId).toBe(PLATFORM_ORGANIZATION_ID);

    const mfa = await prisma.userMfa.findMany({
      include: { user: { select: { email: true } } },
    });
    expect(mfa.map((m) => m.user.email).sort()).toEqual([
      'administracion@drinksonchain.test',
      'operaciones@drinksonchain.test',
      'soporte@drinksonchain.test',
    ]);
    expect(testMfaCrypto().decrypt(mfa[0].secretEncrypted!)).toBe(
      TEST_TOTP_SECRET,
    );
  });

  it('solicitudes en todos los estados y perfil de las bodegas (Ola 1 · 1.3–1.5)', async () => {
    const applications = await prisma.wineryApplication.findMany({
      include: { notes: true },
    });
    expect(new Set(applications.map((a) => a.status))).toEqual(
      new Set([
        'UNVERIFIED',
        'RECEIVED',
        'IN_REVIEW',
        'MEETING_SCHEDULED',
        'APPROVED',
        'REJECTED',
      ]),
    );
    const unverified = applications.find((a) => a.status === 'UNVERIFIED')!;
    expect(unverified.verifyTokenHash).toBe(
      hashOpaqueToken(
        demoApplicationToken(DEMO_PASSWORD, 'demo-verificacion-alto-camargo'),
      ),
    );
    expect(unverified.verifyExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    const approved = applications.filter((a) => a.status === 'APPROVED');
    expect(approved.every((a) => a.wineryId && a.decidedAt)).toBe(true);

    const wineries = await prisma.winery.findMany({
      include: { statusChanges: { orderBy: { changedAt: 'asc' } } },
    });
    const byId = new Map(wineries.map((w) => [w.id, w]));
    expect(byId.get(ALTOS)).toMatchObject({
      slug: 'altos-de-calamuchita',
      lotPrefix: 'ALT',
    });
    expect(byId.get(CINTI_VIEJO)?.lotPrefix).toBe('CVJ');
    expect(byId.get(mockId('winery:padcaya'))?.lotPrefix).toBeNull();
    expect(
      byId.get(mockId('winery:uriondo'))?.statusChanges.map((c) => c.status),
    ).toEqual(['INVITED', 'ACTIVE', 'SUSPENDED']);
  });

  it('una dueña de demostración inicia sesión y ve sus parcelas', async () => {
    process.env.DATABASE_URL = databaseUrl;
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    const http = () => request(app!.getHttpServer());

    const ip = nextIp();
    const login = await http()
      .post('/v1/auth/login')
      .set('X-Forwarded-For', ip)
      .send({ email: 'admin@altos.test', password: DEMO_PASSWORD })
      .expect(200);
    expect(login.body.data.activeOrganizationId).toBe(ALTOS);
    expect(login.body.data.user.id).toBe(mockId('user:altos_admin'));

    const terroirs = await http()
      .get('/v1/terroirs')
      .set('X-Forwarded-For', ip)
      .set('Authorization', `Bearer ${login.body.data.tokens.accessToken}`)
      .expect(200);
    const expected = fx.terroirs.filter((t) => t.wineryId === ALTOS);
    expect(terroirs.body.data.total).toBe(expected.length);
    expect(
      terroirs.body.data.items
        .map((t: { id: string; parcelName: string }) => [t.id, t.parcelName])
        .sort(),
    ).toEqual(expected.map((t) => [t.id, t.parcelName]).sort());

    // La contraseña de los mocks no sirve: solo la de SEED_DEMO_PASSWORD
    await http()
      .post('/v1/auth/login')
      .set('X-Forwarded-For', nextIp())
      .send({ email: 'admin@altos.test', password: 'demo1234' })
      .expect(401);
  }, 60_000);
});
