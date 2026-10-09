import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  MembershipRoleEnum,
  PrismaClient,
  WineryStatusEnum,
} from '@prisma/client';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PLATFORM_ORGANIZATION_ID } from '../src/modules/organizations/organization.constants';
import { SimulatedWalletsAuditRunner } from '../src/modules/chain/simulated-wallets-audit.runner';
import { O3_STEP_3_3_ROUTES } from '../src/modules/tokenization/o3-implemented-routes';
import {
  addWineryMember,
  staffToken,
  wineryWithOwner,
} from './helpers/staff-session';
import { createPlatformUser } from './helpers/identity';
import { loadOpenApiValidator } from './helpers/openapi-validator';

/**
 * Ola 3 · apertura (O3-BE-1; contrato O3 §12.1), en un esquema propio:
 *
 * 1. **Migración expand** (`o3_cadena_expand`, §3.3 pasos 1–3 y 6) sobre una
 *    base con datos del estado anterior: copia las direcciones simuladas a
 *    `legacy_simulated_*`, las pone a NULL, marca `user_wallets` y no borra
 *    nada; la API anota `CHAIN_SIMULATED_WALLETS_INVALIDATED` una sola vez.
 * 2. **Invariantes en la base** (§1): `minted ≤ quota`, una colección por lote,
 *    una solicitud abierta por lote.
 * 3. **SE-02**: sin billeteras simuladas; la ruta legada responde 404.
 * 4. **Rutas del contrato con 501**: con sesión y rol válidos responden
 *    `501 NOT_IMPLEMENTED`; sin sesión 401, con otro rol 403, sin
 *    `Idempotency-Key` o sin motivo 422.
 * 5. **Ampliaciones aditivas** con ceros reales: marca de tokenización del
 *    lote, bloques del tablero y del panel del ERP.
 */
process.env.TRUST_PROXY = '1';

const MIGRATION = '20261008120000_o3_cadena_expand';
const run = `${Date.now()}${randomBytes(3).toString('hex')}`;
const schema = `o3_e2e_${run}`;
const originalUrl = process.env.DATABASE_URL;

function urlWithSchema(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('schema', name);
  return parsed.toString();
}
const databaseUrl = urlWithSchema(process.env.DATABASE_URL ?? '', schema);
const prismaCli = require.resolve('prisma/build/index.js');

function migrate(args: string[]): { status: number; output: string } {
  const result = spawnSync(process.execPath, [prismaCli, 'migrate', ...args], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK: '1',
    },
    encoding: 'utf8',
  });
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
  };
}

type Method = 'get' | 'post' | 'patch';
type Who =
  | 'admin'
  | 'operations'
  | 'support'
  | 'owner'
  | 'enologist'
  | 'accountant'
  | 'operator'
  | 'otherOwner'
  | 'nobody';

interface Route {
  method: Method;
  /** Ruta con ids de ejemplo ya sustituidos. */
  path: () => string;
  /** Quién tiene permiso (el primero se usa para llegar al 501). */
  allowed: Who[];
  /** Quién no (403). */
  denied: Who[];
  body?: object;
  idempotent?: boolean;
  reason?: boolean;
  public?: boolean;
  /** No responde JSON de datos con el envoltorio (texto, imagen). */
  raw?: boolean;
}

const ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const LOT_CODE = 'CVJ-2026-SINGANI-004';

const PLATFORM_READ: Pick<Route, 'allowed' | 'denied'> = {
  allowed: ['admin', 'operations', 'support'],
  denied: ['owner'],
};
const PLATFORM_WRITE: Pick<Route, 'allowed' | 'denied'> = {
  allowed: ['admin', 'operations'],
  denied: ['support', 'owner'],
};
const ADMIN_ONLY: Pick<Route, 'allowed' | 'denied'> = {
  allowed: ['admin'],
  denied: ['operations', 'support', 'owner'],
};
const WINERY_READ: Pick<Route, 'allowed' | 'denied'> = {
  allowed: ['owner', 'enologist', 'accountant'],
  denied: ['operator'],
};
const OWNER_ONLY: Pick<Route, 'allowed' | 'denied'> = {
  allowed: ['owner'],
  denied: ['enologist', 'accountant', 'operator'],
};
const TOKEN_READ: Pick<Route, 'allowed' | 'denied'> = {
  allowed: ['owner', 'accountant'],
  denied: ['enologist', 'operator'],
};

const REASON = { reason: 'Prueba de la apertura de la Ola 3' };
const COMMERCIAL = {
  name: 'Singani Preventa 2026',
  description:
    'Singani de altura del Valle de Cinti, destilado en alambique de cobre.',
  imageKeys: [
    { key: 'org/x/collections/a.jpg', alt: 'Botella', isCover: true },
  ],
};

describe('Ola 3 · apertura: migración expand, SE-02 y rutas con 501 (e2e)', () => {
  const openapi = loadOpenApiValidator();
  const before = mkdtempSync(join(tmpdir(), 'doc-o3-'));
  let prisma: PrismaClient;
  let app: INestApplication;
  let WINERY = '';
  let LOT = '';
  let ipSeq = 1;
  const nextIp = () => `10.240.${ipSeq % 250}.${(ipSeq++ % 250) + 1}`;
  const tokens: Record<Who, string> = {
    admin: '',
    operations: '',
    support: '',
    owner: '',
    enologist: '',
    accountant: '',
    operator: '',
    otherOwner: '',
    nobody: '',
  };

  // Datos del estado anterior a la Ola 3 (SE-02)
  const LEGACY_WINERY = randomUUID();
  const CLEAN_WINERY = randomUUID();
  const LEGACY_USER = randomUUID();
  const LEGACY = {
    stellarPublicKey: `G${'A'.repeat(55)}`,
    dynamicVaultId: `dyn_vault_${run}`,
    onchainProducerId: `PROD_BO_${run}`,
    onchainRegisterTxHash: `0x_simulated_tx_${run}`,
  };
  const countsBefore: Record<string, number> = {};

  const sql = (query: string, ...values: unknown[]) =>
    prisma.$executeRawUnsafe(query, ...values);
  const rows = <T>(query: string, ...values: unknown[]) =>
    prisma.$queryRawUnsafe<T[]>(query, ...values);
  const count = async (table: string) =>
    Number(
      (await rows<{ n: bigint }>(`SELECT count(*) AS n FROM "${table}"`))[0].n,
    );
  const http = () => request(app.getHttpServer());

  function call(
    route: Pick<Route, 'method' | 'path'>,
    who: Who,
    options: {
      body?: object;
      idempotencyKey?: string | null;
    } = {},
  ) {
    const req = http()
      [route.method](route.path())
      .set('X-Forwarded-For', nextIp());
    if (tokens[who]) req.set('Authorization', `Bearer ${tokens[who]}`);
    if (options.idempotencyKey) {
      req.set('Idempotency-Key', options.idempotencyKey);
    }
    return route.method === 'get' ? req : req.send(options.body ?? {});
  }

  /** Las 54 rutas de la apertura, con quién puede y quién no. */
  const ROUTES: Route[] = [
    // ── Cadena · back office (§2.4, §8.1, §8.2) ──────────────────────────
    {
      method: 'get',
      path: () =>
        '/v1/platform/chain/transactions?status=FAILED&kind=MINT_BATCH',
      ...PLATFORM_READ,
    },
    {
      method: 'get',
      path: () => `/v1/platform/chain/transactions/${ID}`,
      ...PLATFORM_READ,
    },
    {
      method: 'post',
      path: () => `/v1/platform/chain/transactions/${ID}/retry`,
      ...PLATFORM_WRITE,
      body: REASON,
      idempotent: true,
      reason: true,
    },
    {
      method: 'post',
      path: () => `/v1/platform/chain/transactions/${ID}/abandon`,
      ...ADMIN_ONLY,
      body: REASON,
      reason: true,
    },
    {
      method: 'get',
      path: () => '/v1/platform/chain/accounts',
      ...PLATFORM_READ,
    },
    {
      method: 'get',
      path: () => '/v1/platform/chain/events?type=lot_minted&unmatched=true',
      ...PLATFORM_READ,
    },
    {
      method: 'get',
      path: () => '/v1/platform/chain/reconciliation/runs?status=OK',
      ...PLATFORM_READ,
    },
    {
      method: 'get',
      path: () => `/v1/platform/chain/reconciliation/runs/${ID}`,
      ...PLATFORM_READ,
    },
    {
      method: 'post',
      path: () => '/v1/platform/chain/reconciliation/runs',
      ...PLATFORM_WRITE,
      body: { scope: 'ALL', depth: 'FULL' },
    },
    {
      method: 'get',
      path: () => '/v1/platform/chain/alerts?status=open&level=CRITICAL',
      ...PLATFORM_READ,
    },
    {
      method: 'post',
      path: () => `/v1/platform/chain/alerts/${ID}/resolve`,
      ...PLATFORM_WRITE,
      body: { note: 'Comprobado en el explorador' },
    },
    // ── Identidad de la bodega (§3.1, §3.4, §3.5) ────────────────────────
    {
      method: 'get',
      path: () => `/v1/platform/wineries/${WINERY}/chain-account`,
      ...PLATFORM_READ,
    },
    {
      method: 'post',
      path: () => `/v1/platform/wineries/${WINERY}/chain/provision`,
      ...PLATFORM_WRITE,
      body: REASON,
      reason: true,
    },
    {
      method: 'post',
      path: () => `/v1/platform/wineries/${WINERY}/chain/pause`,
      ...ADMIN_ONLY,
      body: REASON,
      idempotent: true,
      reason: true,
    },
    {
      method: 'post',
      path: () => `/v1/platform/wineries/${WINERY}/chain/unpause`,
      ...ADMIN_ONLY,
      body: REASON,
      idempotent: true,
      reason: true,
    },
    {
      method: 'get',
      path: () => '/v1/organizations/current/chain-account',
      allowed: ['owner', 'enologist', 'accountant', 'operator'],
      denied: [],
    },
    // ── Tokenización · ERP (§5.3) ────────────────────────────────────────
    {
      method: 'get',
      path: () => `/v1/lots/${LOT}/tokenization`,
      ...WINERY_READ,
    },
    {
      method: 'post',
      path: () => `/v1/lots/${LOT}/tokenization-requests`,
      ...OWNER_ONLY,
      body: { quantity: 100, commercial: COMMERCIAL, confirm: true },
      idempotent: true,
    },
    {
      method: 'get',
      path: () => `/v1/tokenization-requests?status=SUBMITTED&lotId=${LOT}`,
      ...WINERY_READ,
    },
    {
      method: 'get',
      path: () => `/v1/tokenization-requests/${ID}`,
      ...WINERY_READ,
    },
    {
      method: 'patch',
      path: () => `/v1/tokenization-requests/${ID}`,
      ...OWNER_ONLY,
      body: { quantity: 120, notes: 'Subimos la cuota' },
    },
    {
      method: 'post',
      path: () => `/v1/tokenization-requests/${ID}/resubmit`,
      ...OWNER_ONLY,
      body: { message: 'Añadida la nota de cata' },
      idempotent: true,
    },
    {
      method: 'post',
      path: () => `/v1/tokenization-requests/${ID}/withdraw`,
      ...OWNER_ONLY,
      body: REASON,
    },
    {
      method: 'get',
      path: () => '/v1/collections?status=PUBLISHED',
      ...WINERY_READ,
    },
    { method: 'get', path: () => `/v1/collections/${ID}`, ...WINERY_READ },
    {
      method: 'get',
      path: () => `/v1/collections/${ID}/tokens?status=MINTED&fromNumber=1`,
      ...TOKEN_READ,
    },
    {
      method: 'get',
      path: () => `/v1/collections/${ID}/closure`,
      ...TOKEN_READ,
    },
    // ── Tokenización · bandeja del back office (§5.4) ────────────────────
    {
      method: 'get',
      path: () => '/v1/platform/tokenization-requests?kind=INITIAL&q=singani',
      ...PLATFORM_READ,
    },
    {
      method: 'get',
      path: () => `/v1/platform/tokenization-requests/${ID}`,
      ...PLATFORM_READ,
    },
    {
      method: 'post',
      path: () => `/v1/platform/tokenization-requests/${ID}/take`,
      ...PLATFORM_WRITE,
    },
    {
      method: 'post',
      path: () => `/v1/platform/tokenization-requests/${ID}/notes`,
      ...PLATFORM_WRITE,
      body: { text: 'Revisar la fecha estimada de canje' },
    },
    {
      method: 'patch',
      path: () => `/v1/platform/tokenization-requests/${ID}`,
      ...PLATFORM_WRITE,
      body: { commercial: COMMERCIAL, price: null },
    },
    {
      method: 'post',
      path: () => `/v1/platform/tokenization-requests/${ID}/request-changes`,
      ...PLATFORM_WRITE,
      body: {
        message: 'Falta la nota de cata',
        fields: ['commercial.tastingNotes'],
      },
    },
    {
      method: 'post',
      path: () => `/v1/platform/tokenization-requests/${ID}/approve`,
      ...PLATFORM_WRITE,
      body: {
        price: { amountMinor: 18000, currency: 'BOB' },
        publishOnMint: false,
      },
      idempotent: true,
    },
    {
      method: 'post',
      path: () => `/v1/platform/tokenization-requests/${ID}/reject`,
      ...PLATFORM_WRITE,
      body: REASON,
      reason: true,
    },
    // ── Colecciones, cierre y métricas (§6.4, §8.4, §8.5) ────────────────
    {
      method: 'get',
      path: () =>
        '/v1/platform/collections?saleState=PRESALE&mintStatus=CONFIRMED',
      ...PLATFORM_READ,
    },
    {
      method: 'get',
      path: () => `/v1/platform/collections/${ID}`,
      ...PLATFORM_READ,
    },
    {
      method: 'patch',
      path: () => `/v1/platform/collections/${ID}`,
      ...PLATFORM_WRITE,
      body: { ...REASON, price: { amountMinor: 20000, currency: 'BOB' } },
      reason: true,
    },
    {
      method: 'post',
      path: () => `/v1/platform/collections/${ID}/publish`,
      ...PLATFORM_WRITE,
      idempotent: true,
    },
    {
      method: 'post',
      path: () => `/v1/platform/collections/${ID}/pause`,
      ...PLATFORM_WRITE,
      body: REASON,
      idempotent: true,
      reason: true,
    },
    {
      method: 'post',
      path: () => `/v1/platform/collections/${ID}/resume`,
      ...PLATFORM_WRITE,
      idempotent: true,
    },
    {
      method: 'post',
      path: () => `/v1/platform/collections/${ID}/close`,
      ...PLATFORM_WRITE,
      body: REASON,
      reason: true,
    },
    {
      method: 'get',
      path: () => `/v1/platform/collections/${ID}/tokens?toNumber=50`,
      ...PLATFORM_READ,
    },
    {
      method: 'get',
      path: () => `/v1/platform/collections/${ID}/transactions`,
      ...PLATFORM_READ,
    },
    {
      method: 'get',
      path: () => `/v1/platform/collections/${ID}/metrics`,
      ...PLATFORM_READ,
    },
    {
      method: 'get',
      path: () => `/v1/platform/collections/${ID}/closure`,
      ...PLATFORM_READ,
    },
    {
      method: 'post',
      path: () => `/v1/platform/collections/${ID}/closure/decide`,
      ...PLATFORM_WRITE,
      body: { unsoldPolicy: 'KEEP_ON_SALE', ...REASON },
      idempotent: true,
      reason: true,
    },
    {
      method: 'post',
      path: () => `/v1/platform/collections/${ID}/closure/items/57/resolve`,
      ...PLATFORM_WRITE,
      body: { outcome: 'MANUAL_REFUND', note: 'Devolución acordada' },
    },
    {
      method: 'get',
      path: () => '/v1/platform/lot-closures?status=SHORTFALL_OPEN',
      ...PLATFORM_READ,
    },
    // ── Públicas (§3.2, §6.5, §7.3 y las imágenes, U-5) ──────────────────
    {
      method: 'get',
      path: () => '/.well-known/stellar.toml',
      allowed: ['nobody'],
      denied: [],
      public: true,
    },
    {
      method: 'get',
      path: () => '/v1/public/chain/registry',
      allowed: ['nobody'],
      denied: [],
      public: true,
    },
    {
      method: 'get',
      path: () => `/v1/public/lots/${LOT_CODE}/verification`,
      allowed: ['nobody'],
      denied: [],
      public: true,
    },
    {
      method: 'get',
      path: () => '/v1/public/nft/cinti-viejo/57',
      allowed: ['nobody'],
      denied: [],
      public: true,
    },
    {
      method: 'get',
      path: () => `/v1/public/collections/images/${ID}`,
      allowed: ['nobody'],
      denied: [],
      public: true,
    },
  ];
  const name = (route: Route) =>
    `${route.method.toUpperCase()} ${route.path().split('?')[0]}`;
  /** Rutas que ya tienen lógica (dejaron de responder 501): paso 3.3. */
  const IMPLEMENTED = new Set<string>(O3_STEP_3_3_ROUTES);
  const template = (route: Route) =>
    `${route.method.toUpperCase()} ${openapi.resolvePath(route.method, route.path())}`;
  const implemented = (route: Route) => IMPLEMENTED.has(template(route));

  beforeAll(async () => {
    // 1. El estado anterior a la Ola 3: todas las migraciones menos la nueva
    cpSync('prisma/schema.prisma', join(before, 'schema.prisma'));
    cpSync('prisma/migrations', join(before, 'migrations'), {
      recursive: true,
      filter: (source) => !source.includes(MIGRATION),
    });
    expect(readdirSync(join(before, 'migrations'))).not.toContain(MIGRATION);
    expect(
      migrate(['deploy', '--schema', join(before, 'schema.prisma')]),
    ).toMatchObject({ status: 0 });
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

    // 2. Datos como los que hay en desarrollo (SQL directo: el cliente
    // generado ya conoce las columnas nuevas)
    await sql(
      `INSERT INTO wineries (id, legal_name, commercial_name, beverage_category, tax_id_nit, geographic_region, contact_email,
                             stellar_public_key, dynamic_vault_id, onchain_producer_id, onchain_register_tx_hash)
       VALUES ($1::uuid, 'Bodega Legada S.R.L.', 'Bodega Legada', 'WINERY', $2, 'Tarija', 'legada@e2e.test', $3, $4, $5, $6)`,
      LEGACY_WINERY,
      `NIT-L-${run.slice(-10)}`,
      LEGACY.stellarPublicKey,
      LEGACY.dynamicVaultId,
      LEGACY.onchainProducerId,
      LEGACY.onchainRegisterTxHash,
    );
    await sql(
      `INSERT INTO wineries (id, legal_name, commercial_name, beverage_category, tax_id_nit, geographic_region, contact_email)
       VALUES ($1::uuid, 'Bodega Sin Cuenta S.R.L.', 'Bodega Sin Cuenta', 'WINERY', $2, 'Tarija', 'sincuenta@e2e.test')`,
      CLEAN_WINERY,
      `NIT-C-${run.slice(-10)}`,
    );
    await sql(
      `INSERT INTO users (id, email, password_hash, full_name) VALUES ($1::uuid, $2, 'x', 'Persona con billetera simulada')`,
      LEGACY_USER,
      `legada-${run}@e2e.test`,
    );
    await sql(
      `INSERT INTO user_wallets (id, user_id, winery_id, stellar_public_address, dynamic_vault_id, wallet_purpose)
       VALUES ($1::uuid, $2::uuid, NULL, $3, $4, 'CONSUMER_NFT'),
              ($5::uuid, $2::uuid, $6::uuid, $7, $8, 'PRODUCER_SIGNING')`,
      randomUUID(),
      LEGACY_USER,
      `G${'B'.repeat(55)}`,
      `dyn_vault_u_${run}`,
      randomUUID(),
      LEGACY_WINERY,
      `G${'C'.repeat(55)}`,
      `dyn_vault_w_${run}`,
    );
    for (const table of ['wineries', 'users', 'user_wallets', 'audit_events']) {
      countsBefore[table] = await count(table);
    }

    // 3. La migración expand de la Ola 3
    const applied = migrate(['deploy']);
    expect({ status: applied.status, output: applied.output }).toMatchObject({
      status: 0,
    });

    // 4. La API sobre esa base
    process.env.DATABASE_URL = databaseUrl;
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    const staff = async (who: Who, role: MembershipRoleEnum) => {
      const user = await createPlatformUser(prisma, {
        email: `${who}-o3-${run}@drinksonchain.test`,
        password: 'Plataforma-o3-123',
        role,
      });
      tokens[who] = await staffToken(app, {
        userId: user.id,
        email: user.email,
        organizationId: PLATFORM_ORGANIZATION_ID,
        organizationType: 'PLATFORM',
        role,
      });
    };
    await staff('admin', MembershipRoleEnum.ADMIN);
    await staff('operations', MembershipRoleEnum.OPERATIONS);
    await staff('support', MembershipRoleEnum.SUPPORT);

    const winery = async (who: Who, label: string) => {
      const email = `${who}-o3-${run}@e2e.test`;
      const { wineryId, ownerId } = await wineryWithOwner(app, {
        name: `${label} ${run}`,
        email,
        password: 'Apertura-o3-123!',
      });
      tokens[who] = await staffToken(app, {
        userId: ownerId,
        email,
        organizationId: wineryId,
        organizationType: 'WINERY',
        role: MembershipRoleEnum.OWNER,
      });
      return wineryId;
    };
    WINERY = await winery('owner', 'Destilería de la Apertura');
    await winery('otherOwner', 'Bodega Vecina de la Apertura');
    for (const [who, role] of [
      ['enologist', 'ENOLOGIST'],
      ['accountant', 'ACCOUNTANT'],
      ['operator', 'OPERATOR'],
    ] as const) {
      const email = `${who}-o3-${run}@e2e.test`;
      const { userId } = await addWineryMember(app, {
        wineryId: WINERY,
        role,
        email,
        fullName: `Miembro ${role}`,
      });
      tokens[who] = await staffToken(app, {
        userId,
        email,
        organizationId: WINERY,
        organizationType: 'WINERY',
        role: MembershipRoleEnum[role],
      });
    }
    const lot = await http()
      .post('/v1/lots')
      .set('X-Forwarded-For', nextIp())
      .set('Authorization', `Bearer ${tokens.owner}`)
      .send({
        name: 'Singani Preventa de la apertura',
        harvestYear: new Date().getUTCFullYear(),
        productType: 'SINGANI',
        estimatedBottles: 3000,
        plannedFormatCl: 75,
        targetAbvPercent: 40,
      })
      .expect(201);
    LOT = lot.body.data.id as string;
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    if (prisma) {
      await prisma.$executeRawUnsafe(
        `DROP SCHEMA IF EXISTS "${schema}" CASCADE`,
      );
      await prisma.$disconnect();
    }
    rmSync(before, { recursive: true, force: true });
    process.env.DATABASE_URL = originalUrl;
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('migración expand sobre datos existentes (§3.3, SE-02)', () => {
    it('copia los valores simulados de la bodega a legacy_simulated_* y los pone a NULL', async () => {
      const [winery] = await rows<Record<string, unknown>>(
        `SELECT stellar_public_key, dynamic_vault_id, onchain_producer_id, onchain_register_tx_hash,
                legacy_simulated_address, legacy_simulated_data, chain_account_id
         FROM wineries WHERE id = $1::uuid`,
        LEGACY_WINERY,
      );
      expect(winery).toEqual({
        stellar_public_key: null,
        dynamic_vault_id: null,
        onchain_producer_id: null,
        onchain_register_tx_hash: null,
        legacy_simulated_address: LEGACY.stellarPublicKey,
        legacy_simulated_data: LEGACY,
        chain_account_id: null,
      });
    });

    it('no toca las bodegas que no tenían ninguno', async () => {
      const [winery] = await rows<Record<string, unknown>>(
        `SELECT legacy_simulated_address, legacy_simulated_data FROM wineries WHERE id = $1::uuid`,
        CLEAN_WINERY,
      );
      expect(winery).toEqual({
        legacy_simulated_address: null,
        legacy_simulated_data: null,
      });
    });

    it('marca todas las billeteras como INVALID_SIMULATED y no borra ninguna fila', async () => {
      const wallets = await rows<{ status: string; n: bigint }>(
        `SELECT status, count(*) AS n FROM user_wallets WHERE user_id = $1::uuid GROUP BY status`,
        LEGACY_USER,
      );
      expect(wallets.map((w) => [w.status, Number(w.n)])).toEqual([
        ['INVALID_SIMULATED', 2],
      ]);
      // Las direcciones siguen ahí (se borran en la contracción de H3)
      expect(
        await rows(
          `SELECT 1 FROM user_wallets WHERE stellar_public_address = $1`,
          `G${'B'.repeat(55)}`,
        ),
      ).toHaveLength(1);
      // Lo que había antes de migrar sigue estando (después se crearon más)
      for (const id of [LEGACY_WINERY, CLEAN_WINERY]) {
        expect(
          await rows(`SELECT 1 FROM wineries WHERE id = $1::uuid`, id),
        ).toHaveLength(1);
      }
      expect(
        await rows(`SELECT 1 FROM users WHERE id = $1::uuid`, LEGACY_USER),
      ).toHaveLength(1);
      expect(countsBefore).toMatchObject({ wineries: 2, user_wallets: 2 });
    });

    it('crea las 19 tablas de la cadena y la tokenización', async () => {
      const tables = await rows<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
        schema,
      );
      expect(tables.map((t) => t.table_name)).toEqual(
        expect.arrayContaining([
          'chain_accounts',
          'nft_contracts',
          'chain_transactions',
          'chain_tx_attempts',
          'chain_events',
          'chain_cursors',
          'chain_alerts',
          'reconciliation_runs',
          'tokenization_requests',
          'tokenization_request_changes',
          'collections',
          'collection_images',
          'collection_status_history',
          'mints',
          'tokens',
          'lot_closures',
          'lot_closure_items',
          'dossier_anchors',
          'consumer_addresses',
        ]),
      );
    });

    it('la API anota CHAIN_SIMULATED_WALLETS_INVALIDATED una sola vez, con el número de filas', async () => {
      const entries = () =>
        rows<{ after: unknown; actor_user_id: string | null; n: number }>(
          `SELECT after, actor_user_id FROM audit_events WHERE action = 'CHAIN_SIMULATED_WALLETS_INVALIDATED'`,
        );
      const first = await entries();
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({
        actor_user_id: null,
        after: { userWallets: 2, wineries: 1, migration: MIGRATION },
      });
      // Otro arranque (u otra réplica) no la repite
      expect(await app.get(SimulatedWalletsAuditRunner).run()).toBeNull();
      await app.get(SimulatedWalletsAuditRunner).onApplicationBootstrap();
      expect(await entries()).toHaveLength(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('invariantes en la base (§1; R6)', () => {
    const ACCOUNT = randomUUID();
    const CONTRACT = randomUUID();
    const COLLECTION = randomUUID();
    const insertRequest = (status: string) =>
      sql(
        `INSERT INTO tokenization_requests (id, winery_id, lot_id, kind, status, quantity, resulting_quota, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'INITIAL', $4, 100, 100, now())`,
        randomUUID(),
        WINERY,
        LOT,
        status,
      );

    beforeAll(async () => {
      await sql(
        `INSERT INTO chain_accounts (id, role, network, winery_id, address, custody_key_ref, derivation_index, status, updated_at)
         VALUES ($1::uuid, 'WINERY', 'LOCAL', $2::uuid, $3, $4, 0, 'ACTIVE', now())`,
        ACCOUNT,
        WINERY,
        `G${'D'.repeat(55)}`,
        `winery-${WINERY}`,
      );
      await sql(
        `INSERT INTO nft_contracts (id, winery_id, chain_account_id, network, address, wasm_hash, name, symbol, base_uri, operator_address, status, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'LOCAL', $4, $5, 'Apertura', 'APE', 'https://api.e2e.test/v1/public/nft/apertura/', $6, 'ACTIVE', now())`,
        CONTRACT,
        WINERY,
        ACCOUNT,
        `C${'D'.repeat(55)}`,
        'a'.repeat(64),
        `G${'E'.repeat(55)}`,
      );
      await sql(
        `INSERT INTO collections (id, slug, winery_id, lot_id, contract_id, quota, minted, name, description, updated_at)
         VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, 100, 100, 'Apertura', 'Colección de la prueba', now())`,
        COLLECTION,
        `apertura-${run}`,
        WINERY,
        LOT,
        CONTRACT,
      );
    });

    afterAll(async () => {
      // Deja la base como antes: el resto de pruebas espera ceros
      await sql(
        `DELETE FROM tokenization_requests WHERE lot_id = $1::uuid`,
        LOT,
      );
      await sql(`DELETE FROM collections WHERE id = $1::uuid`, COLLECTION);
      await sql(`DELETE FROM nft_contracts WHERE id = $1::uuid`, CONTRACT);
      await sql(`DELETE FROM chain_accounts WHERE id = $1::uuid`, ACCOUNT);
    });

    it('minted nunca supera quota (CHECK)', async () => {
      await expect(
        sql(
          `UPDATE collections SET minted = quota + 1 WHERE id = $1::uuid`,
          COLLECTION,
        ),
      ).rejects.toThrow(/collections_minted_lte_quota/);
      await expect(
        sql(
          `UPDATE collections SET quota = 99 WHERE id = $1::uuid`,
          COLLECTION,
        ),
      ).rejects.toThrow(/collections_minted_lte_quota/);
      // Ampliar la cuota sí
      await sql(
        `UPDATE collections SET quota = 150 WHERE id = $1::uuid`,
        COLLECTION,
      );
    });

    it('una sola colección por lote', async () => {
      await expect(
        sql(
          `INSERT INTO collections (id, slug, winery_id, lot_id, contract_id, quota, name, description, updated_at)
           VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, 10, 'Otra', 'Otra colección del mismo lote', now())`,
          randomUUID(),
          `otra-${run}`,
          WINERY,
          LOT,
          CONTRACT,
        ),
      ).rejects.toThrow(/23505[\s\S]*Key \(lot_id\)/);
    });

    it('una sola solicitud abierta por lote; las cerradas no cuentan', async () => {
      await insertRequest('REJECTED');
      await insertRequest('WITHDRAWN');
      await insertRequest('SUBMITTED');
      for (const status of ['SUBMITTED', 'IN_REVIEW', 'CHANGES_REQUESTED']) {
        await expect(insertRequest(status)).rejects.toThrow(
          /23505[\s\S]*Key \(lot_id\)/,
        );
      }
      await insertRequest('APPROVED');
    });

    it('una cuenta de bodega por bodega y red, y sin bodega no es de bodega', async () => {
      await expect(
        sql(
          `INSERT INTO chain_accounts (id, role, network, winery_id, custody_key_ref, updated_at)
           VALUES ($1::uuid, 'WINERY', 'LOCAL', $2::uuid, 'winery-otra', now())`,
          randomUUID(),
          WINERY,
        ),
      ).rejects.toThrow(/23505[\s\S]*Key \(winery_id, network\)/);
      await expect(
        sql(
          `INSERT INTO chain_accounts (id, role, network, custody_key_ref, updated_at)
           VALUES ($1::uuid, 'WINERY', 'LOCAL', 'winery-sin-bodega', now())`,
          randomUUID(),
        ),
      ).rejects.toThrow(/chain_accounts_winery_by_role/);
    });

    it('el índice 0 de los consumidores queda reservado', async () => {
      await expect(
        sql(
          `INSERT INTO consumer_addresses (user_id, index, address, derivation_path, network)
           VALUES ($1::uuid, 0, $2, 'm/44''/148''/0''', 'LOCAL')`,
          LEGACY_USER,
          `G${'F'.repeat(55)}`,
        ),
      ).rejects.toThrow(/consumer_addresses_index_positive/);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('SE-02: sin billeteras simuladas', () => {
    it('GET /v1/users/me/wallet → 404 CHN_WALLET_NOT_AVAILABLE al personal de bodega y de plataforma', async () => {
      for (const who of ['owner', 'admin'] as const) {
        const res = await call(
          { method: 'get', path: () => '/v1/users/me/wallet' },
          who,
        );
        expect({ who, status: res.status, code: res.body.error?.code }).toEqual(
          { who, status: 404, code: 'CHN_WALLET_NOT_AVAILABLE' },
        );
        openapi.expectResponse('get', '/v1/users/me/wallet', res);
      }
    });

    it('un consumidor nuevo no recibe billetera simulada: primaryWallet null y el mismo 404', async () => {
      const signup = await http()
        .post('/v1/auth/signup')
        .set('X-Forwarded-For', nextIp())
        .send({
          email: `consumidor-o3-${run}@e2e.test`,
          password: 'Consumidor-o3-123',
          fullName: 'Consumidora de la apertura',
        })
        .expect(201);
      const token = signup.body.data.tokens.accessToken as string;
      const me = await http()
        .get('/v1/users/me')
        .set('X-Forwarded-For', nextIp())
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(me.body.data.user.primaryWallet).toBeNull();
      const wallet = await http()
        .get('/v1/users/me/wallet')
        .set('X-Forwarded-For', nextIp())
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
      expect(wallet.body.error.code).toBe('CHN_WALLET_NOT_AVAILABLE');
      expect(
        await rows(
          `SELECT 1 FROM user_wallets w JOIN users u ON u.id = w.user_id WHERE u.email = $1`,
          `consumidor-o3-${run}@e2e.test`,
        ),
      ).toHaveLength(0);
    });

    it('con su dirección custodial asignada, el consumidor la recibe con la forma de siempre', async () => {
      const email = `consumidor-dir-${run}@e2e.test`;
      const signup = await http()
        .post('/v1/auth/signup')
        .set('X-Forwarded-For', nextIp())
        .send({
          email,
          password: 'Consumidor-o3-123',
          fullName: 'Consumidor con dirección',
        })
        .expect(201);
      const userId = signup.body.data.user.id as string;
      const address = `G${'H'.repeat(55)}`;
      await sql(
        `INSERT INTO consumer_addresses (user_id, address, derivation_path, network)
         VALUES ($1::uuid, $2, 'm/44''/148''/1''', 'LOCAL')`,
        userId,
        address,
      );
      const res = await http()
        .get('/v1/users/me/wallet')
        .set('X-Forwarded-For', nextIp())
        .set('Authorization', `Bearer ${signup.body.data.tokens.accessToken}`)
        .expect(200);
      openapi.expectResponse('get', '/v1/users/me/wallet', res);
      expect(res.body.data).toMatchObject({
        userId,
        wineryId: null,
        stellarPublicAddress: address,
        walletType: 'CUSTODIAL',
        walletPurpose: 'CONSUMER_NFT',
        isPrimary: true,
      });
      expect(res.body.data).not.toHaveProperty('dynamicVaultId');
    });

    it('la bodega (rutas legadas) no devuelve direcciones simuladas', async () => {
      const res = await call(
        { method: 'get', path: () => '/v1/wineries/my' },
        'owner',
      );
      expect(res.status).toBe(200);
      openapi.expectResponse('get', '/v1/wineries/my', res);
      expect(res.body.data).toMatchObject({
        stellarPublicKey: null,
        onchainProducerId: null,
        onchainRegisterTxHash: null,
      });
      expect(res.body.data).not.toHaveProperty('legacySimulatedAddress');
      expect(res.body.data).not.toHaveProperty('dynamicVaultId');
    });

    it('nada creó billeteras al dar de alta personas y bodegas', async () => {
      expect(await count('user_wallets')).toBe(countsBefore.user_wallets);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('rutas del contrato con 501 (§12.1)', () => {
    it('la prueba recorre las 54 rutas del OpenAPI de la apertura', () => {
      expect(ROUTES).toHaveLength(54);
      const templates = ROUTES.map(
        (route) =>
          `${route.method.toUpperCase()} ${openapi.resolvePath(route.method, route.path())}`,
      );
      expect(templates.filter((t) => t.endsWith('null'))).toEqual([]);
      expect(new Set(templates).size).toBe(54);
    });

    it('las del paso 3.3 (solicitudes y colecciones sin red) ya no responden 501', async () => {
      const done = ROUTES.filter(implemented);
      expect(done).toHaveLength(O3_STEP_3_3_ROUTES.length);
      for (const route of done) {
        const res = await call(route, route.allowed[0], {
          body: route.body,
          idempotencyKey: route.idempotent ? randomUUID() : null,
        });
        expect({
          route: name(route),
          implemented: res.status !== 501,
        }).toEqual({ route: name(route), implemented: true });
        if (!route.raw && !(route.public && res.status === 200)) {
          openapi.expectResponse(route.method, route.path(), res);
        }
      }
    });

    it('con sesión y rol válidos, las pendientes responden 501 NOT_IMPLEMENTED con su paso', async () => {
      for (const route of ROUTES.filter((r) => !implemented(r))) {
        for (const who of route.allowed) {
          const res = await call(route, who, {
            body: route.body,
            idempotencyKey: route.idempotent ? randomUUID() : null,
          });
          expect({
            route: name(route),
            who,
            status: res.status,
            code: res.body.error?.code,
          }).toEqual({
            route: name(route),
            who,
            status: 501,
            code: 'NOT_IMPLEMENTED',
          });
          expect(res.body.error.details[0].meta.step).toMatch(/^3\.[1-6]$/);
          openapi.expectResponse(route.method, route.path(), res);
        }
      }
    });

    it('sin sesión responden 401 (salvo las públicas)', async () => {
      for (const route of ROUTES.filter((r) => !r.public)) {
        const res = await call(route, 'nobody', {
          body: route.body,
          idempotencyKey: route.idempotent ? randomUUID() : null,
        });
        expect({ route: name(route), status: res.status }).toEqual({
          route: name(route),
          status: 401,
        });
      }
    });

    it('con un rol sin permiso responden 403', async () => {
      for (const route of ROUTES) {
        for (const who of route.denied) {
          const res = await call(route, who, {
            body: route.body,
            idempotencyKey: route.idempotent ? randomUUID() : null,
          });
          expect({ route: name(route), who, status: res.status }).toEqual({
            route: name(route),
            who,
            status: 403,
          });
        }
      }
    });

    it('la plataforma lee la tokenización de una bodega pero no la escribe (A-03)', async () => {
      const read = await call(
        {
          method: 'get',
          path: () => `/v1/tokenization-requests?wineryId=${WINERY}`,
        },
        'support',
      );
      expect(read.status).toBe(200);
      expect(read.body.data).toMatchObject({ items: [], total: 0 });
      const write = await call(
        {
          method: 'post',
          path: () =>
            `/v1/lots/${LOT}/tokenization-requests?wineryId=${WINERY}`,
        },
        'admin',
        {
          body: { quantity: 100, confirm: true },
          idempotencyKey: randomUUID(),
        },
      );
      expect({ status: write.status, code: write.body.error?.code }).toEqual({
        status: 403,
        code: 'TRC_PLATFORM_READ_ONLY',
      });
    });

    it('sin Idempotency-Key, las que la exigen responden 422 IDEMPOTENCY_KEY_REQUIRED en ese campo', async () => {
      const required = ROUTES.filter((r) => r.idempotent);
      expect(required).toHaveLength(10);
      for (const route of required) {
        const res = await call(route, route.allowed[0], { body: route.body });
        expect({
          route: name(route),
          status: res.status,
          code: res.body.error?.code,
          field: res.body.error?.details?.[0]?.field,
        }).toEqual({
          route: name(route),
          status: 422,
          code: 'IDEMPOTENCY_KEY_REQUIRED',
          field: 'Idempotency-Key',
        });
        openapi.expectResponse(route.method, route.path(), res);
      }
    });

    it('sin motivo, las acciones del back office sobre una bodega responden 422 en `reason`', async () => {
      const withReason = ROUTES.filter((r) => r.reason);
      expect(withReason).toHaveLength(10);
      for (const route of withReason) {
        const { reason: _reason, ...body } = (route.body ?? {}) as {
          reason?: string;
        };
        const res = await call(route, route.allowed[0], {
          body,
          idempotencyKey: route.idempotent ? randomUUID() : null,
        });
        expect({
          route: name(route),
          status: res.status,
          field: res.body.error?.details?.[0]?.field,
        }).toEqual({ route: name(route), status: 422, field: 'reason' });
      }
    });

    it('el cuerpo se valida antes de llegar al 501', async () => {
      const cases: [string, Who, object, string][] = [
        [
          `/v1/lots/${LOT}/tokenization-requests`,
          'owner',
          { quantity: 0, confirm: true },
          'quantity',
        ],
        [
          `/v1/lots/${LOT}/tokenization-requests`,
          'owner',
          { quantity: 100 },
          'confirm',
        ],
        [
          `/v1/lots/${LOT}/tokenization-requests`,
          'owner',
          { quantity: 100, confirm: true, commercial: { name: 'ab' } },
          'commercial.name',
        ],
        [
          `/v1/platform/tokenization-requests/${ID}/approve`,
          'admin',
          { price: { amountMinor: 10.5, currency: 'USD' } },
          'price.amountMinor',
        ],
        [
          `/v1/platform/collections/${ID}/closure/decide`,
          'admin',
          { unsoldPolicy: 'REGALAR', ...REASON },
          'unsoldPolicy',
        ],
        [
          '/v1/platform/chain/reconciliation/runs',
          'operations',
          { scope: 'TODO' },
          'scope',
        ],
      ];
      for (const [path, who, body, field] of cases) {
        const res = await call({ method: 'post', path: () => path }, who, {
          body,
          idempotencyKey: randomUUID(),
        });
        expect({
          path,
          status: res.status,
          fields: (res.body.error?.details ?? []).map(
            (d: { field: string }) => d.field,
          ),
        }).toEqual({
          path,
          status: 422,
          fields: expect.arrayContaining([field]),
        });
      }
      // Y los filtros de las listas
      const list = await call(
        {
          method: 'get',
          path: () => '/v1/platform/chain/transactions?status=PERDIDA',
        },
        'admin',
      );
      expect(list.status).toBe(422);
    });

    it('la bodega suspendida sigue leyendo su cuenta en la red; el resto del ERP no', async () => {
      const suspendedOwner = `suspendida-o3-${run}@e2e.test`;
      const { wineryId, ownerId } = await wineryWithOwner(app, {
        name: `Bodega Suspendida ${run}`,
        email: suspendedOwner,
        password: 'Apertura-o3-123!',
        status: WineryStatusEnum.SUSPENDED,
      });
      const token = await staffToken(app, {
        userId: ownerId,
        email: suspendedOwner,
        organizationId: wineryId,
        organizationType: 'WINERY',
        role: MembershipRoleEnum.OWNER,
      });
      const get = (path: string) =>
        http()
          .get(path)
          .set('X-Forwarded-For', nextIp())
          .set('Authorization', `Bearer ${token}`);
      expect(
        (await get('/v1/organizations/current/chain-account')).status,
      ).toBe(501);
      const requests = await get('/v1/tokenization-requests');
      expect({
        status: requests.status,
        code: requests.body.error?.code,
      }).toEqual({ status: 403, code: 'ORG_NOT_ACTIVE' });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe('ampliaciones aditivas con ceros reales (§5.3, §7, §11)', () => {
    it('LotSummary y Lot llevan la marca de tokenización NONE', async () => {
      const list = await call(
        { method: 'get', path: () => '/v1/lots' },
        'owner',
      );
      expect(list.status).toBe(200);
      openapi.expectResponse('get', '/v1/lots', list);
      expect(list.body.data.items).toHaveLength(1);
      expect(list.body.data.items[0].tokenization).toEqual({
        state: 'NONE',
        quota: 0,
        minted: 0,
        collectionId: null,
      });
      const lot = await call(
        { method: 'get', path: () => `/v1/lots/${LOT}` },
        'owner',
      );
      openapi.expectResponse('get', `/v1/lots/${LOT}`, lot);
      expect(lot.body.data.tokenization.state).toBe('NONE');
    });

    it('el expediente sigue con anchor null, ahora con forma en el contrato', async () => {
      const dossier = await call(
        { method: 'get', path: () => `/v1/lots/${LOT}/dossier` },
        'owner',
      );
      expect(dossier.status).toBe(200);
      openapi.expectResponse('get', `/v1/lots/${LOT}/dossier`, dossier);
      expect(dossier.body.data.anchor).toBeNull();
    });

    it('el tablero del back office trae tokenization y chain en cero', async () => {
      const res = await call(
        { method: 'get', path: () => '/v1/platform/dashboard' },
        'support',
      );
      expect(res.status).toBe(200);
      openapi.expectResponse('get', '/v1/platform/dashboard', res);
      expect(res.body.data.tokenization).toEqual({
        submitted: 0,
        inReview: 0,
        changesRequested: 0,
        oldestOpenHours: 0,
        collectionsMinting: 0,
        mintFailures: 0,
        collectionsPublished: 0,
        shortfallsOpen: 0,
      });
      expect(res.body.data.chain).toEqual({
        // Sin variables de la cadena: red por defecto y todo en cero
        network: 'TESTNET',
        operationsBalanceXlm: '0.0000000',
        anchorBalanceXlm: '0.0000000',
        failedTransactions: 0,
        stuckTransactions: 0,
        openAlerts: { critical: 0, warning: 0 },
        lastReconciliation: null,
        indexerLagSeconds: 0,
      });
    });

    it('el panel del ERP trae tokenization en cero', async () => {
      const res = await call(
        { method: 'get', path: () => '/v1/traceability/dashboard' },
        'owner',
      );
      expect(res.status).toBe(200);
      openapi.expectResponse('get', '/v1/traceability/dashboard', res);
      expect(res.body.data.tokenization).toEqual({
        openRequests: 0,
        changesRequested: 0,
        collectionsPublished: 0,
      });
    });

    it('la matriz de permisos publica las capacidades de la ola', async () => {
      const res = await call(
        { method: 'get', path: () => '/v1/platform/permissions' },
        'admin',
      );
      expect(res.status).toBe(200);
      openapi.expectResponse('get', '/v1/platform/permissions', res);
      const byKey = Object.fromEntries(
        (
          res.body.data.capabilities as {
            key: string;
            roles: Record<string, string>;
          }[]
        ).map((c) => [c.key, c.roles]),
      );
      expect(byKey.tokenization).toMatchObject({
        ADMIN: 'FULL',
        OPERATIONS: 'FULL',
        SUPPORT: 'READ',
        OWNER: 'OWN',
        OPERATOR: 'NONE',
      });
      expect(byKey['chain.admin']).toMatchObject({
        ADMIN: 'FULL',
        OPERATIONS: 'NONE',
        SUPPORT: 'NONE',
      });
    });
  });
});
