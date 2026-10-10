import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  MembershipRoleEnum,
  OrganizationStatusEnum,
  OrganizationTypeEnum,
  PrismaClient,
  WineryCategoryEnum,
  WineryStatusEnum,
} from '@prisma/client';
import { Keypair } from '@stellar/stellar-sdk';
import * as request from 'supertest';
import { createPlatformUser } from './helpers/identity';
import {
  FaultyCustody,
  FaultyGateway,
  LOCAL_CHAIN,
  localChainAvailable,
  uploadContractCode,
} from './helpers/local-chain';
import { loadOpenApiValidator } from './helpers/openapi-validator';
import { addWineryMember, staffToken } from './helpers/staff-session';

/**
 * Ola 3 · pasos 3.1 y 3.2 contra la **red local** (contrato O3 §14):
 * `stellar/quickstart --local` con el protocolo vigente. La API y el worker
 * corren en el mismo proceso sobre un esquema y un prefijo de colas propios,
 * con el custodio `ENV` (claves generadas aquí y descartadas al terminar).
 *
 * - Cuentas de plataforma por el Friendbot local (`FUND_ACCOUNT`).
 * - Identidad completa de una bodega al activarse, leída de vuelta en la red.
 * - Idempotencia: evento del outbox reprocesado → una sola transacción.
 * - Relleno de una en una y solo de bodegas `ACTIVE`.
 * - Pausa y reanudación (firma separada), revocación → pausa.
 * - Fallos forzados: RPC detenido, respuesta del envío perdida, secuencia en
 *   conflicto, autorización inválida, intención que no cuadra con la base.
 * - Autorización entre organizaciones y por rol.
 *
 * Sin `CHAIN_E2E_RPC_URL` se omite: el resto de e2e corre sin red.
 */
const run = `${Date.now()}${randomBytes(3).toString('hex')}`;
const schema = `chain_e2e_${run}`;
const describeChain = localChainAvailable() ? describe : describe.skip;

// En la CI la red local es obligatoria: que no se omita en silencio
if (process.env.CHAIN_E2E_REQUIRED === 'true' && !localChainAvailable()) {
  throw new Error(
    'CHAIN_E2E_REQUIRED=true pero faltan CHAIN_E2E_RPC_URL, CHAIN_E2E_FRIENDBOT_URL o CHAIN_E2E_WASM_PATH',
  );
}

const ENV_KEYS = [
  'DATABASE_URL',
  'QUEUE_PREFIX',
  'STELLAR_NETWORK',
  'STELLAR_RPC_URL',
  'STELLAR_FRIENDBOT_URL',
  'STELLAR_EXPLORER_BASE_URL',
  'STELLAR_HOME_DOMAIN',
  'WINERY_NFT_WASM_HASH',
  'CHAIN_CUSTODY_DRIVER',
  'CHAIN_SECRET_OPERATIONS',
  'CHAIN_SECRET_ANCHOR',
  'CHAIN_DEV_WINERY_SEED',
  'CHAIN_TX_RETRY_DELAYS_MS',
  'CHAIN_ENVIRONMENT',
  'API_PUBLIC_URL',
  'OUTBOX_RELAY_INTERVAL_MS',
  'WORKER_HEARTBEAT_FILE',
  'TRUST_PROXY',
] as const;

const EXPLORER = 'https://explorer.e2e.test/local';
const REASON = { reason: 'Prueba de la cadena en la red local' };

function urlWithSchema(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('schema', name);
  return parsed.toString();
}

async function waitFor<T>(
  what: string,
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs = 90_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    last = value;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Tiempo agotado esperando: ${what} (${String(last)})`);
}

describeChain('Ola 3 · firmante e identidad contra la red local (e2e)', () => {
  const openapi = loadOpenApiValidator();
  const saved: Record<string, string | undefined> = {};
  let prisma: PrismaClient;
  let app: INestApplication;
  let worker: TestingModule;
  let gateway: FaultyGateway;
  let custody: FaultyCustody;
  let operationsAddress = '';
  let anchorAddress = '';
  let wasmHash = '';
  let ipSeq = 1;
  const nextIp = () => `10.241.${ipSeq % 250}.${(ipSeq++ % 250) + 1}`;
  const tokens: Record<string, string> = {};
  const timings: Record<string, number> = {};

  const http = () => request(app.getHttpServer());
  const call = (
    method: 'get' | 'post',
    path: string,
    who: string | null,
    options: { body?: object; idempotencyKey?: string } = {},
  ) => {
    const req = http()[method](path).set('X-Forwarded-For', nextIp());
    if (who) req.set('Authorization', `Bearer ${tokens[who]}`);
    if (options.idempotencyKey) {
      req.set('Idempotency-Key', options.idempotencyKey);
    }
    return method === 'get' ? req : req.send(options.body ?? {});
  };

  /** Bodega con prefijo y `slug`, como la deja la activación (ORG-05). */
  async function createWinery(
    label: string,
    prefix: string,
    status: WineryStatusEnum = WineryStatusEnum.ACTIVE,
  ): Promise<string> {
    const id = randomUUID();
    await prisma.winery.create({
      data: {
        id,
        legalName: `${label} S.R.L.`,
        commercialName: label,
        beverageCategory: WineryCategoryEnum.DISTILLERY,
        taxIdNit: `${Date.now()}${Math.floor(Math.random() * 1e4)}`.slice(-15),
        geographicRegion: 'Tarija',
        contactEmail: `contacto+${id.slice(0, 8)}@e2e.test`,
        certificationStatus: status,
        lotPrefix: prefix,
        slug: `${prefix.toLowerCase()}-${run}`,
        activatedAt: new Date(),
      },
    });
    await prisma.organization.create({
      data: {
        id,
        type: OrganizationTypeEnum.WINERY,
        name: label,
        status: status as unknown as OrganizationStatusEnum,
        wineryId: id,
      },
    });
    return id;
  }

  /** `winery.activated` por el outbox, como al aceptar la dueña su invitación. */
  async function emitActivated(wineryId: string, prefix: string) {
    const { OutboxService } =
      await import('../src/shared/outbox/outbox.service');
    return prisma.$transaction((tx) =>
      app.get(OutboxService).add(tx, {
        type: 'winery.activated',
        aggregateType: 'winery',
        aggregateId: wineryId,
        queue: 'chain',
        payload: {
          wineryId,
          lotPrefix: prefix,
          ownerUserId: randomUUID(),
          activatedAt: new Date().toISOString(),
        },
      }),
    );
  }

  const identityOf = async (wineryId: string) =>
    prisma.chainAccount.findFirst({ where: { wineryId, network: 'LOCAL' } });
  const contractOf = async (wineryId: string) =>
    prisma.nftContract.findFirst({ where: { wineryId, network: 'LOCAL' } });
  const txsOf = (wineryId: string) =>
    prisma.chainTransaction.findMany({
      where: { wineryId },
      orderBy: { createdAt: 'asc' },
      include: { attemptsLog: { orderBy: { at: 'asc' } } },
    });
  const waitIdentity = (wineryId: string, status: string, timeoutMs?: number) =>
    waitFor(
      `identidad ${status} de ${wineryId}`,
      async () => {
        const account = await identityOf(wineryId);
        return account?.status === status ? account : null;
      },
      timeoutMs,
    );
  const waitTx = (id: string, statuses: string[], timeoutMs?: number) =>
    waitFor(
      `transacción ${id} en ${statuses.join('/')}`,
      async () => {
        const tx = await prisma.chainTransaction.findUnique({
          where: { id },
          include: { attemptsLog: { orderBy: { at: 'asc' } } },
        });
        return tx && statuses.includes(tx.status) ? tx : null;
      },
      timeoutMs,
    );
  const pausedOnChain = async (contractAddress: string) =>
    gateway.readContract(contractAddress, 'paused', [], operationsAddress);

  async function provisioned(label: string, prefix: string): Promise<string> {
    const wineryId = await createWinery(label, prefix);
    await emitActivated(wineryId, prefix);
    await waitIdentity(wineryId, 'ACTIVE');
    return wineryId;
  }

  beforeAll(async () => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    const databaseUrl = urlWithSchema(process.env.DATABASE_URL ?? '', schema);

    // 1. Esquema propio y limpio (el relleno no debe ver bodegas ajenas)
    const migrated = spawnSync(
      process.execPath,
      [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
      {
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK: '1',
        },
        encoding: 'utf8',
      },
    );
    expect(migrated.status).toBe(0);

    // 2. El código del contrato en la red local (en testnet ya está subido)
    wasmHash = await uploadContractCode();

    // 3. Entorno de la cadena: custodio ENV con claves de usar y tirar
    Object.assign(process.env, {
      DATABASE_URL: databaseUrl,
      QUEUE_PREFIX: `chain-e2e-${run}`,
      STELLAR_NETWORK: 'LOCAL',
      STELLAR_RPC_URL: LOCAL_CHAIN.rpcUrl,
      STELLAR_FRIENDBOT_URL: LOCAL_CHAIN.friendbotUrl,
      STELLAR_EXPLORER_BASE_URL: EXPLORER,
      STELLAR_HOME_DOMAIN: 'api.e2e.test',
      WINERY_NFT_WASM_HASH: wasmHash,
      CHAIN_CUSTODY_DRIVER: 'ENV',
      CHAIN_SECRET_OPERATIONS: Keypair.random().secret(),
      CHAIN_SECRET_ANCHOR: Keypair.random().secret(),
      CHAIN_DEV_WINERY_SEED: randomBytes(32).toString('hex'),
      CHAIN_TX_RETRY_DELAYS_MS: '500,500,500,500,500',
      CHAIN_ENVIRONMENT: `e2e-${run}`.slice(0, 30),
      API_PUBLIC_URL: 'https://api.e2e.test',
      OUTBOX_RELAY_INTERVAL_MS: '200',
      WORKER_HEARTBEAT_FILE: join(tmpdir(), `doc-chain-e2e-${run}.heartbeat`),
      TRUST_PROXY: '1',
    });
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

    // 4. La API y el worker, cargados ahora para que lean este entorno
    const { AppModule } = await import('../src/app.module');
    const { configureApp } = await import('../src/app.setup');
    const { WorkerModule } = await import('../src/worker/worker.module');
    const { CHAIN_SETTINGS } =
      await import('../src/modules/chain/chain.config');
    const { KEY_CUSTODY } =
      await import('../src/modules/chain/custody/key-custody');
    const { createKeyCustody } =
      await import('../src/modules/chain/custody/custody.factory');
    const { CHAIN_GATEWAY } =
      await import('../src/modules/chain/jobs/gateway/chain-gateway');
    const { StellarChainGateway } =
      await import('../src/modules/chain/jobs/gateway/stellar-chain-gateway');
    const { ChainBootstrap } =
      await import('../src/modules/chain/jobs/chain-bootstrap.service');
    const { ConfigService } = await import('@nestjs/config');
    const { PrismaService } =
      await import('../src/shared/prisma/prisma.service');

    const apiRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = apiRef.createNestApplication();
    configureApp(app);
    await app.init();

    worker = await Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(CHAIN_GATEWAY)
      .useFactory({
        factory: (
          settings: ConstructorParameters<typeof StellarChainGateway>[0],
        ) => {
          gateway = new FaultyGateway(new StellarChainGateway(settings));
          return gateway;
        },
        inject: [CHAIN_SETTINGS],
      })
      .overrideProvider(KEY_CUSTODY)
      .useFactory({
        factory: (...args: Parameters<typeof createKeyCustody>) => {
          custody = new FaultyCustody(createKeyCustody(...args));
          return custody;
        },
        inject: [CHAIN_SETTINGS, ConfigService, PrismaService],
      })
      .compile();
    // El mantenimiento (TTL tras cada emisión, conciliación al arrancar) tiene
    // su propia suite (`conciliacion-o3`): aquí no mete transacciones por medio
    const { ChainTtlService } =
      await import('../src/modules/chain/jobs/ttl/chain-ttl.service');
    const { ChainReconciler } =
      await import('../src/modules/chain/jobs/reconcile/chain-reconciler.service');
    jest.spyOn(worker.get(ChainTtlService), 'run').mockResolvedValue({
      codeDays: null,
      contracts: 0,
      requested: [],
      errors: 0,
    });
    jest.spyOn(worker.get(ChainReconciler), 'runNow').mockResolvedValue(null);
    await worker.init();
    await worker.get(ChainBootstrap).ready();
    operationsAddress = await custody.publicKey('platform-operations');
    anchorAddress = await custody.publicKey('platform-anchor');

    // 5. Personas
    for (const [who, role] of [
      ['admin', MembershipRoleEnum.ADMIN],
      ['operations', MembershipRoleEnum.OPERATIONS],
      ['support', MembershipRoleEnum.SUPPORT],
    ] as const) {
      const user = await createPlatformUser(prisma, {
        email: `${who}-chain-${run}@drinksonchain.test`,
        password: 'Plataforma-chain-123',
        role,
      });
      const { PLATFORM_ORGANIZATION_ID } =
        await import('../src/modules/organizations/organization.constants');
      tokens[who] = await staffToken(app, {
        userId: user.id,
        email: user.email,
        organizationId: PLATFORM_ORGANIZATION_ID,
        organizationType: 'PLATFORM',
        role,
      });
    }
  }, 300_000);

  afterAll(async () => {
    await worker?.close();
    await app?.close();
    if (prisma) {
      await prisma.$executeRawUnsafe(
        `DROP SCHEMA IF EXISTS "${schema}" CASCADE`,
      );
      await prisma.$disconnect();
    }
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    if (Object.keys(timings).length > 0) {
      process.stdout.write(
        `\n[chain-o3] tiempos en la red local (ms): ${JSON.stringify(timings)}\n`,
      );
    }
  }, 120_000);

  async function member(
    wineryId: string,
    who: string,
    role: 'OWNER' | 'ENOLOGIST' | 'OPERATOR',
  ) {
    const email = `${who}-chain-${run}@e2e.test`;
    const { userId } = await addWineryMember(app, {
      wineryId,
      role,
      email,
      fullName: `Persona ${who}`,
    });
    tokens[who] = await staffToken(app, {
      userId,
      email,
      organizationId: wineryId,
      organizationType: 'WINERY',
      role: MembershipRoleEnum[role],
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  describe('cuentas de la plataforma (§2.1, §2.4)', () => {
    it('el arranque registra operaciones y anclaje y las fondea con el Friendbot local', async () => {
      const funds = await waitFor('FUND_ACCOUNT confirmadas', async () => {
        const rows = await prisma.chainTransaction.findMany({
          where: { kind: 'FUND_ACCOUNT' },
        });
        return rows.length === 2 && rows.every((r) => r.status === 'CONFIRMED')
          ? rows
          : null;
      });
      expect(funds.map((f) => f.subjectId).sort()).toEqual([
        'ANCHOR',
        'OPERATIONS',
      ]);
      // Friendbot no firma con claves nuestras ni tiene cuenta de origen
      expect(funds.every((f) => f.sourceAccount === null)).toBe(true);
      expect(custody.signatures).toEqual([]);
      expect(await gateway.accountBalance(operationsAddress)).toBeGreaterThan(
        0n,
      );
      expect(await gateway.accountBalance(anchorAddress)).toBeGreaterThan(0n);
    });

    it('GET /v1/platform/chain/accounts devuelve direcciones, saldos y estado sin tocar la red', async () => {
      const { PlatformAccountsSync } =
        await import('../src/modules/chain/jobs/platform-accounts.sync');
      await worker.get(PlatformAccountsSync).checkBalances();
      for (const who of ['admin', 'operations', 'support']) {
        const res = await call('get', '/v1/platform/chain/accounts', who);
        expect(res.status).toBe(200);
        openapi.expectResponse('get', '/v1/platform/chain/accounts', res);
        expect(res.body.data).toMatchObject({
          network: 'LOCAL',
          wasmHash,
          operations: {
            address: operationsAddress,
            status: 'OK',
            explorerUrl: `${EXPLORER}/account/${operationsAddress}`,
            minBalanceXlm: '50.0000000',
          },
          anchor: { address: anchorAddress, status: 'OK' },
        });
        expect(res.body.data.operations.balanceXlm).toMatch(/^\d+\.\d{7}$/);
        expect(res.body.data.operations.checkedAt).not.toBeNull();
      }
      // Ninguna alerta de saldo abierta
      expect(
        await prisma.chainAlert.count({
          where: { code: 'LOW_BALANCE', resolvedAt: null },
        }),
      ).toBe(0);
    });

    it('las claves no están en la base ni en ninguna respuesta', async () => {
      const secrets = [
        process.env.CHAIN_SECRET_OPERATIONS,
        process.env.CHAIN_SECRET_ANCHOR,
        process.env.CHAIN_DEV_WINERY_SEED,
      ] as string[];
      const dump = JSON.stringify(
        await Promise.all([
          prisma.chainAccount.findMany(),
          prisma.chainTransaction.findMany(),
          prisma.auditEvent.findMany(),
          prisma.outboxEvent.findMany(),
        ]),
        (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v),
      );
      for (const secret of secrets) expect(dump).not.toContain(secret);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('identidad de una bodega (§3.1–§3.4)', () => {
    let WINERY = '';
    let OTHER = '';

    it('al activarse: cuenta y contrato confirmados, leídos de vuelta y ACTIVE', async () => {
      WINERY = await createWinery('Destilería Ñandú de la Cadena', 'NDU');
      await member(WINERY, 'owner', 'OWNER');
      await member(WINERY, 'operator', 'OPERATOR');

      const before = await call(
        'get',
        '/v1/organizations/current/chain-account',
        'owner',
      );
      expect(before.status).toBe(200);
      expect(before.body.data.identity).toMatchObject({
        status: 'NOT_PROVISIONED',
        account: null,
        contract: null,
      });

      const started = Date.now();
      await emitActivated(WINERY, 'NDU');
      const account = await waitIdentity(WINERY, 'ACTIVE');
      timings.identidad = Date.now() - started;
      const contract = await contractOf(WINERY);

      expect(account.derivationIndex).toBe(0);
      expect(account.address).toMatch(/^G[A-Z2-7]{55}$/);
      expect(contract).toMatchObject({
        status: 'ACTIVE',
        paused: false,
        wasmHash,
        name: 'Destilería Ñandú de la Cadena',
        symbol: 'NDU',
        baseUri: `https://api.e2e.test/v1/public/nft/ndu-${run}/`,
        operatorAddress: operationsAddress,
      });
      expect(contract?.verifiedAt).not.toBeNull();

      // En la red: la cuenta existe con 2 XLM y el contrato responde
      expect(await gateway.accountBalance(account.address as string)).toBe(
        20_000_000n,
      );
      const address = contract?.address as string;
      expect(
        await gateway.readContract(address, 'get_admin', [], operationsAddress),
      ).toBe(account.address);
      expect(
        await gateway.readContract(address, 'symbol', [], operationsAddress),
      ).toBe('NDU');
      expect(
        await gateway.readContract(
          address,
          'total_minted',
          [],
          operationsAddress,
        ),
      ).toBe(0);

      const txs = await txsOf(WINERY);
      expect(txs.map((t) => [t.kind, t.status])).toEqual([
        ['CREATE_WINERY_ACCOUNT', 'CONFIRMED'],
        ['DEPLOY_WINERY_CONTRACT', 'CONFIRMED'],
      ]);
      for (const tx of txs) {
        expect(tx.sourceAccount).toBe(operationsAddress);
        expect(tx.txHash).toMatch(/^[0-9a-f]{64}$/);
        expect(tx.ledger).toBeGreaterThan(0);
        expect(tx.feeChargedStroops).toBeGreaterThan(0n);
        expect(tx.attemptsLog.map((a) => a.status)).toEqual([
          'BUILDING',
          'SUBMITTED',
          'CONFIRMED',
        ]);
      }
      // Quién firmó: el sobre, operaciones; `setOptions(homeDomain)`, la bodega
      expect(txs[0].signers).toEqual([
        { role: 'OPERATIONS', address: operationsAddress, wineryId: null },
        { role: 'WINERY', address: account.address, wineryId: WINERY },
      ]);
      expect(txs[1].signers).toEqual([
        { role: 'OPERATIONS', address: operationsAddress, wineryId: null },
      ]);
      expect(account.homeDomain).toBe('api.e2e.test');

      const audit = await prisma.auditEvent.findMany({
        where: {
          action: 'WINERY_CHAIN_IDENTITY_CREATED',
          organizationId: WINERY,
        },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0].actorUserId).toBeNull();
      expect(audit[0].after).toMatchObject({
        account: account.address,
        contract: address,
        symbol: 'NDU',
      });
    });

    it('un evento del outbox reprocesado no crea otra transacción (intentKey)', async () => {
      const event = await emitActivated(WINERY, 'NDU');
      await waitFor('evento publicado', async () => {
        const row = await prisma.outboxEvent.findUnique({
          where: { id: event.id },
        });
        return row?.status === 'DONE';
      });
      const { WineryIdentityProvisioner } =
        await import('../src/modules/chain/jobs/winery-identity.provisioner');
      expect(
        await worker.get(WineryIdentityProvisioner).provision(WINERY),
      ).toBe('ALREADY_ACTIVE');
      await new Promise((r) => setTimeout(r, 1500));
      const txs = await txsOf(WINERY);
      expect(txs).toHaveLength(2);
      expect(
        await prisma.chainAccount.count({ where: { wineryId: WINERY } }),
      ).toBe(1);
      expect(
        await prisma.nftContract.count({ where: { wineryId: WINERY } }),
      ).toBe(1);
    });

    it('el ERP ve su cuenta (todos los miembros) con enlaces al explorador', async () => {
      for (const who of ['owner', 'operator']) {
        const res = await call(
          'get',
          '/v1/organizations/current/chain-account',
          who,
        );
        expect(res.status).toBe(200);
        openapi.expectResponse(
          'get',
          '/v1/organizations/current/chain-account',
          res,
        );
        const { identity, totals, byLot, recentTransactions, chainCosts } =
          res.body.data;
        expect(identity).toMatchObject({
          wineryId: WINERY,
          network: 'LOCAL',
          status: 'ACTIVE',
          pendingTransactions: [],
          lastError: null,
          account: { homeDomain: 'api.e2e.test' },
          contract: { symbol: 'NDU', paused: false, wasmHash },
        });
        expect(identity.account.explorerUrl).toBe(
          `${EXPLORER}/account/${identity.account.address}`,
        );
        expect(identity.contract.explorerUrl).toBe(
          `${EXPLORER}/contract/${identity.contract.address}`,
        );
        expect(identity.account.createdTx).toMatchObject({
          kind: 'CREATE_WINERY_ACCOUNT',
          status: 'CONFIRMED',
        });
        expect(identity.contract.deployedTx.explorerUrl).toBe(
          `${EXPLORER}/tx/${identity.contract.deployedTx.txHash}`,
        );
        expect(totals.minted).toBe(0);
        expect(byLot).toEqual([]);
        expect(recentTransactions).toHaveLength(2);
        expect(Number(chainCosts.feesChargedXlm)).toBeGreaterThan(0);
        // El ERP no ve claves, firmantes ni la intención
        expect(JSON.stringify(res.body)).not.toMatch(/signers|intentKey/);
      }
    });

    it('otra bodega no ve esta identidad; la plataforma sí, por su ruta', async () => {
      OTHER = await createWinery('Bodega Vecina de la Cadena', 'VEC');
      await member(OTHER, 'otherOwner', 'OWNER');
      const own = await call(
        'get',
        '/v1/organizations/current/chain-account',
        'otherOwner',
      );
      expect(own.body.data.identity).toMatchObject({
        wineryId: OTHER,
        status: 'NOT_PROVISIONED',
      });
      const foreign = await call(
        'get',
        `/v1/organizations/current/chain-account?wineryId=${WINERY}`,
        'otherOwner',
      );
      expect([403, 404]).toContain(foreign.status);
      expect(JSON.stringify(foreign.body)).not.toContain('NDU');

      for (const who of ['admin', 'operations', 'support']) {
        const res = await call(
          'get',
          `/v1/platform/wineries/${WINERY}/chain-account`,
          who,
        );
        expect(res.status).toBe(200);
        openapi.expectResponse(
          'get',
          `/v1/platform/wineries/${WINERY}/chain-account`,
          res,
        );
        expect(res.body.data.identity.status).toBe('ACTIVE');
      }
      for (const who of ['owner', null]) {
        const res = await call(
          'get',
          `/v1/platform/wineries/${WINERY}/chain-account`,
          who,
        );
        expect(res.status).toBe(who ? 403 : 401);
      }
      const missing = await call(
        'get',
        `/v1/platform/wineries/${randomUUID()}/chain-account`,
        'admin',
      );
      expect(missing.status).toBe(404);
      expect(missing.body.error.code).toBe('ORG_NOT_FOUND');
    });

    it('stellar.toml y el registro público listan las cuentas y el contrato oficiales', async () => {
      const account = await identityOf(WINERY);
      const contract = await contractOf(WINERY);
      const toml = await http().get('/.well-known/stellar.toml');
      expect(toml.status).toBe(200);
      expect(toml.headers['content-type']).toMatch(/^text\/plain/);
      expect(toml.headers['access-control-allow-origin']).toBe('*');
      expect(toml.headers['cache-control']).toBe('public, max-age=300');
      expect(toml.text).toContain(
        'NETWORK_PASSPHRASE="Standalone Network ; February 2017"',
      );
      expect(toml.text).toContain('ORG_NAME="Drinks on Chain"');
      for (const address of [
        operationsAddress,
        anchorAddress,
        account?.address,
      ]) {
        expect(toml.text).toContain(`"${address}"`);
      }

      const registry = await http().get('/v1/public/chain/registry');
      expect(registry.status).toBe(200);
      openapi.expectResponse('get', '/v1/public/chain/registry', registry);
      expect(registry.body.data).toMatchObject({
        network: 'LOCAL',
        wasmHash,
        platform: {
          operationsAccount: operationsAddress,
          anchorAccount: anchorAddress,
        },
      });
      expect(registry.body.data.wineries).toEqual([
        expect.objectContaining({
          slug: `ndu-${run}`,
          tradeName: 'Destilería Ñandú de la Cadena',
          symbol: 'NDU',
          account: account?.address,
          contract: contract?.address,
          paused: false,
          contractExplorerUrl: `${EXPLORER}/contract/${contract?.address}`,
        }),
      ]);
    });

    it('compatibilidad hasta H3: la ruta legada devuelve la cuenta real y el hash de su creación', async () => {
      const account = await identityOf(WINERY);
      const [created] = await txsOf(WINERY);
      const res = await call('get', '/v1/wineries/my', 'owner');
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        stellarPublicKey: account?.address,
        onchainProducerId: null,
        onchainRegisterTxHash: created.txHash,
      });
    });

    it('la plataforma lista y abre las transacciones con su historial; el resto no', async () => {
      const list = await call(
        'get',
        `/v1/platform/chain/transactions?wineryId=${WINERY}&status=CONFIRMED`,
        'support',
      );
      expect(list.status).toBe(200);
      openapi.expectResponse('get', '/v1/platform/chain/transactions', list);
      expect(list.body.data.total).toBe(2);
      // Orden -createdAt
      expect(list.body.data.items.map((t: { kind: string }) => t.kind)).toEqual(
        ['DEPLOY_WINERY_CONTRACT', 'CREATE_WINERY_ACCOUNT'],
      );
      const deploy = list.body.data.items[0];
      expect(deploy).toMatchObject({
        intentKey: `identity:${WINERY}:contract`,
        subject: { type: 'WINERY', id: WINERY },
        wineryId: WINERY,
        sourceAccount: operationsAddress,
        requestedBy: { source: 'WORKER', userId: null },
        abandoned: null,
        lastError: null,
        explorerUrl: `${EXPLORER}/tx/${deploy.txHash}`,
      });
      expect(deploy.result.contractEvents).toContain('role_granted');
      expect(Number(deploy.feeChargedStroops)).toBeGreaterThan(0);
      expect(Number(deploy.rentFeeStroops)).toBeGreaterThan(0);

      const detail = await call(
        'get',
        `/v1/platform/chain/transactions/${deploy.id}`,
        'operations',
      );
      expect(detail.status).toBe(200);
      openapi.expectResponse(
        'get',
        `/v1/platform/chain/transactions/${deploy.id}`,
        detail,
      );
      expect(
        detail.body.data.history.map((h: { status: string }) => h.status),
      ).toEqual(['BUILDING', 'SUBMITTED', 'CONFIRMED']);
      // Ni XDR ni secretos en lo que se guarda o se devuelve
      expect(JSON.stringify(detail.body)).not.toMatch(/AAAA[A-Za-z0-9+/]{40,}/);

      const byKind = await call(
        'get',
        '/v1/platform/chain/transactions?kind=FUND_ACCOUNT&subjectType=PLATFORM',
        'admin',
      );
      expect(byKind.body.data.total).toBe(2);
      for (const who of ['owner', null]) {
        const res = await call('get', '/v1/platform/chain/transactions', who);
        expect(res.status).toBe(who ? 403 : 401);
      }
      const missing = await call(
        'get',
        `/v1/platform/chain/transactions/${randomUUID()}`,
        'admin',
      );
      expect(missing.status).toBe(404);
      expect(missing.body.error.code).toBe('CHN_TX_NOT_FOUND');
    });

    it('provision sobre una identidad ACTIVE → 409; soporte y la bodega no pueden', async () => {
      const path = `/v1/platform/wineries/${WINERY}/chain/provision`;
      const active = await call('post', path, 'operations', { body: REASON });
      expect(active.status).toBe(409);
      expect(active.body.error.code).toBe('CHN_IDENTITY_ALREADY_ACTIVE');
      openapi.expectResponse('post', path, active);
      for (const who of ['support', 'owner']) {
        expect((await call('post', path, who, { body: REASON })).status).toBe(
          403,
        );
      }
      expect((await call('post', path, 'admin', { body: {} })).status).toBe(
        422,
      );
    });

    it('relleno: de una en una y solo bodegas ACTIVE; cada una con su clave derivada', async () => {
      const suspended = await createWinery(
        'Bodega Suspendida de la Cadena',
        'SUS',
        WineryStatusEnum.SUSPENDED,
      );
      const { ChainJobsQueue } =
        await import('../src/modules/chain/jobs/chain-jobs.queue');
      // OTHER está ACTIVE y sin identidad: el relleno la toma
      await worker.get(ChainJobsQueue).backfill();
      const filled = await waitIdentity(OTHER, 'ACTIVE');
      const first = await identityOf(WINERY);
      expect(filled.derivationIndex).toBe(1);
      expect(filled.address).not.toBe(first?.address);
      expect((await contractOf(OTHER))?.symbol).toBe('VEC');
      // Tras terminar una, el relleno sigue solo: la suspendida no entra
      await new Promise((r) => setTimeout(r, 2000));
      expect(await identityOf(suspended)).toBeNull();
      expect(
        await prisma.chainTransaction.count({ where: { wineryId: suspended } }),
      ).toBe(0);
      const registry = await http().get('/v1/public/chain/registry');
      expect(
        registry.body.data.wineries.map((w: { symbol: string }) => w.symbol),
      ).toEqual(['NDU', 'VEC']);
    });

    // ── Pausa y reanudación (§3.5) ───────────────────────────────────────
    it('pausar y reanudar en la red: solo administración, con Idempotency-Key y motivo', async () => {
      const pause = `/v1/platform/wineries/${WINERY}/chain/pause`;
      const unpause = `/v1/platform/wineries/${WINERY}/chain/unpause`;
      const contract = await contractOf(WINERY);
      const address = contract?.address as string;

      for (const who of ['operations', 'support', 'owner']) {
        const res = await call('post', pause, who, {
          body: REASON,
          idempotencyKey: randomUUID(),
        });
        expect(res.status).toBe(403);
      }
      expect(
        (await call('post', pause, 'admin', { body: REASON })).body.error.code,
      ).toBe('IDEMPOTENCY_KEY_REQUIRED');
      const notPaused = await call('post', unpause, 'admin', {
        body: REASON,
        idempotencyKey: randomUUID(),
      });
      expect(notPaused.status).toBe(409);
      expect(notPaused.body.error.code).toBe('CHN_CONTRACT_NOT_PAUSED');

      const key = randomUUID();
      const signaturesBefore = custody.signatures.length;
      const started = Date.now();
      const requested = await call('post', pause, 'admin', {
        body: REASON,
        idempotencyKey: key,
      });
      expect(requested.status).toBe(202);
      openapi.expectResponse('post', pause, requested);
      expect(requested.body.data.pendingTransactions).toEqual([
        expect.objectContaining({ kind: 'PAUSE_CONTRACT', status: 'PENDING' }),
      ]);
      // La misma clave repite la respuesta sin registrar otra intención
      const replay = await call('post', pause, 'admin', {
        body: REASON,
        idempotencyKey: key,
      });
      expect(replay.status).toBe(202);
      expect(replay.body.data).toEqual(requested.body.data);
      // Otra clave, con la pausa en curso → redundante
      const again = await call('post', pause, 'admin', {
        body: REASON,
        idempotencyKey: randomUUID(),
      });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('CHN_CONTRACT_ALREADY_PAUSED');

      await waitIdentity(WINERY, 'PAUSED');
      timings.pausa = Date.now() - started;
      expect(await pausedOnChain(address)).toBe(true);
      expect(
        await prisma.chainTransaction.count({
          where: { wineryId: WINERY, kind: 'PAUSE_CONTRACT' },
        }),
      ).toBe(1);
      // `pause(operador)`: una sola firma, la del sobre
      expect(custody.signatures.slice(signaturesBefore)).toEqual([
        'platform-operations',
      ]);
      const registry = await http().get('/v1/public/chain/registry');
      expect(
        registry.body.data.wineries.find(
          (w: { symbol: string }) => w.symbol === 'NDU',
        ).paused,
      ).toBe(true);

      // Reanudar: la autorización la firma la bodega; el sobre, operaciones
      const beforeUnpause = custody.signatures.length;
      const balance = await gateway.accountBalance(
        (await identityOf(WINERY))?.address as string,
      );
      const resumed = await call('post', unpause, 'admin', {
        body: REASON,
        idempotencyKey: randomUUID(),
      });
      expect(resumed.status).toBe(202);
      await waitIdentity(WINERY, 'ACTIVE');
      expect(await pausedOnChain(address)).toBe(false);
      expect(custody.signatures.slice(beforeUnpause)).toEqual([
        `winery-${WINERY}`,
        'platform-operations',
      ]);
      // La bodega no gasta saldo: paga operaciones (S-3, sin fee-bump)
      expect(
        await gateway.accountBalance(
          (await identityOf(WINERY))?.address as string,
        ),
      ).toBe(balance);
      const unpauseTx = await prisma.chainTransaction.findFirstOrThrow({
        where: { wineryId: WINERY, kind: 'UNPAUSE_CONTRACT' },
      });
      expect(unpauseTx.signers).toEqual([
        { role: 'OPERATIONS', address: operationsAddress, wineryId: null },
        expect.objectContaining({ role: 'WINERY', wineryId: WINERY }),
      ]);
      expect(unpauseTx.requestedSource).toBe('API');
      const actions = await prisma.auditEvent.findMany({
        where: {
          organizationId: WINERY,
          action: { in: ['CHAIN_CONTRACT_PAUSED', 'CHAIN_CONTRACT_UNPAUSED'] },
        },
        orderBy: { seq: 'asc' },
      });
      expect(actions.map((a) => [a.action, a.reason])).toEqual([
        ['CHAIN_CONTRACT_PAUSED', REASON.reason],
        ['CHAIN_CONTRACT_UNPAUSED', REASON.reason],
      ]);
    });

    it('revocar una bodega pausa su contrato en la red (§3.5)', async () => {
      const contract = await contractOf(OTHER);
      const res = await call(
        'post',
        `/v1/platform/wineries/${OTHER}/revoke`,
        'admin',
        { body: { reason: 'Revocada en la prueba de la cadena' } },
      );
      expect(res.status).toBe(200);
      await waitIdentity(OTHER, 'PAUSED');
      expect(await pausedOnChain(contract?.address as string)).toBe(true);
      const pauseTx = await prisma.chainTransaction.findFirstOrThrow({
        where: { wineryId: OTHER, kind: 'PAUSE_CONTRACT' },
      });
      expect(pauseTx).toMatchObject({
        status: 'CONFIRMED',
        requestedSource: 'WORKER',
      });
      const entry = await prisma.auditEvent.findUniqueOrThrow({
        where: {
          id: (pauseTx.intent as { auditEventId: string }).auditEventId,
        },
      });
      expect(entry.action).toBe('WINERY_REVOKED');
      // Suspender no toca la red (S-8)
      await call('post', `/v1/platform/wineries/${WINERY}/suspend`, 'admin', {
        body: { reason: 'Suspendida en la prueba' },
      }).expect(200);
      await new Promise((r) => setTimeout(r, 1500));
      expect(
        await prisma.chainTransaction.count({
          where: { wineryId: WINERY, kind: 'PAUSE_CONTRACT' },
        }),
      ).toBe(1);
      await call(
        'post',
        `/v1/platform/wineries/${WINERY}/reactivate`,
        'admin',
        {
          body: { reason: 'Reactivada en la prueba' },
        },
      ).expect(200);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('fallos forzados (§2.3, §14)', () => {
    afterEach(() => {
      gateway.down = false;
      gateway.loseNextSendResponse = false;
      gateway.staleSequenceOnce = false;
      custody.corrupted.clear();
    });

    it('RPC detenido: RETRYING y, al volver, una sola cuenta y un solo contrato', async () => {
      gateway.down = true;
      const wineryId = await createWinery('Bodega del RPC Caído', 'RPC');
      await emitActivated(wineryId, 'RPC');
      const retrying = await waitFor('RETRYING por RPC', async () => {
        const [tx] = await txsOf(wineryId);
        return tx?.status === 'RETRYING' ? tx : null;
      });
      expect(retrying.lastError).toMatchObject({
        code: 'CHN_RPC_UNAVAILABLE',
        retryable: true,
      });
      expect(retrying.txHash).toBeNull();
      expect((await identityOf(wineryId))?.status).toBe('PROVISIONING');
      const pending = await call(
        'get',
        `/v1/platform/wineries/${wineryId}/chain-account`,
        'support',
      );
      expect(pending.body.data.identity.pendingTransactions).toEqual([
        expect.objectContaining({
          kind: 'CREATE_WINERY_ACCOUNT',
          lastError: expect.objectContaining({ code: 'CHN_RPC_UNAVAILABLE' }),
        }),
      ]);

      gateway.down = false;
      const account = await waitIdentity(wineryId, 'ACTIVE');
      const txs = await txsOf(wineryId);
      expect(txs.map((t) => t.status)).toEqual(['CONFIRMED', 'CONFIRMED']);
      expect(txs[0].attempts).toBeGreaterThan(1);
      expect(txs[0].attemptsLog.map((a) => a.errorCode)).toContain(
        'CHN_RPC_UNAVAILABLE',
      );
      expect(await gateway.accountBalance(account.address as string)).toBe(
        20_000_000n,
      );
    });

    it('respuesta del envío perdida: se consulta el hash y se confirma sin reenviar', async () => {
      const wineryId = await provisioned('Bodega del Envío Perdido', 'ENV');
      const contract = await contractOf(wineryId);
      const sendsBefore = gateway.sends;
      gateway.loseNextSendResponse = true;
      const res = await call(
        'post',
        `/v1/platform/wineries/${wineryId}/chain/pause`,
        'admin',
        { body: REASON, idempotencyKey: randomUUID() },
      );
      expect(res.status).toBe(202);
      await waitIdentity(wineryId, 'PAUSED');
      const tx = await prisma.chainTransaction.findFirstOrThrow({
        where: { wineryId, kind: 'PAUSE_CONTRACT' },
        include: { attemptsLog: { orderBy: { at: 'asc' } } },
      });
      // Se envió una sola vez; el "reintento" solo consultó su hash
      expect(gateway.sends - sendsBefore).toBe(1);
      expect(tx.attempts).toBe(1);
      expect(tx.attemptsLog.map((a) => a.status)).toEqual([
        'BUILDING',
        'RETRYING',
        'CONFIRMED',
      ]);
      expect(
        new Set(tx.attemptsLog.map((a) => a.txHash).filter(Boolean)).size,
      ).toBe(1);
      expect(await pausedOnChain(contract?.address as string)).toBe(true);
    });

    it('secuencia en conflicto: CHN_BAD_SEQUENCE, se reconstruye y confirma', async () => {
      const wineryId = await provisioned('Bodega de la Secuencia', 'SEQ');
      gateway.staleSequenceOnce = true;
      await call(
        'post',
        `/v1/platform/wineries/${wineryId}/chain/pause`,
        'admin',
        { body: REASON, idempotencyKey: randomUUID() },
      ).expect(202);
      await waitIdentity(wineryId, 'PAUSED');
      const tx = await prisma.chainTransaction.findFirstOrThrow({
        where: { wineryId, kind: 'PAUSE_CONTRACT' },
        include: { attemptsLog: { orderBy: { at: 'asc' } } },
      });
      expect(tx.attempts).toBe(2);
      expect(tx.attemptsLog.map((a) => [a.status, a.errorCode])).toEqual([
        ['BUILDING', null],
        ['RETRYING', 'CHN_BAD_SEQUENCE'],
        ['BUILDING', null],
        ['SUBMITTED', null],
        ['CONFIRMED', null],
      ]);
    });

    it('autorización inválida: FAILED sin enviarse, alerta CRITICAL y reintento manual', async () => {
      const wineryId = await provisioned('Bodega de la Firma Mala', 'FIR');
      const contract = await contractOf(wineryId);
      await call(
        'post',
        `/v1/platform/wineries/${wineryId}/chain/pause`,
        'admin',
        { body: REASON, idempotencyKey: randomUUID() },
      ).expect(202);
      await waitIdentity(wineryId, 'PAUSED');

      custody.corrupted.add(`winery-${wineryId}`);
      const sendsBefore = gateway.sends;
      await call(
        'post',
        `/v1/platform/wineries/${wineryId}/chain/unpause`,
        'admin',
        { body: REASON, idempotencyKey: randomUUID() },
      ).expect(202);
      const pendingTx = await prisma.chainTransaction.findFirstOrThrow({
        where: { wineryId, kind: 'UNPAUSE_CONTRACT' },
      });
      const failed = await waitTx(pendingTx.id, ['FAILED']);
      expect(failed.lastError).toMatchObject({
        code: 'CHN_AUTH_FAILED',
        retryable: false,
      });
      expect(gateway.sends).toBe(sendsBefore);
      expect(await pausedOnChain(contract?.address as string)).toBe(true);
      expect((await identityOf(wineryId))?.status).toBe('PAUSED');
      const alert = await prisma.chainAlert.findFirstOrThrow({
        where: { subjectId: failed.id },
      });
      expect(alert).toMatchObject({
        code: 'TX_FAILED',
        level: 'CRITICAL',
        wineryId,
        resolvedAt: null,
      });

      const retry = `/v1/platform/chain/transactions/${failed.id}/retry`;
      // Soporte no reintenta; sin Idempotency-Key o sin motivo, 422
      expect(
        (
          await call('post', retry, 'support', {
            body: REASON,
            idempotencyKey: randomUUID(),
          })
        ).status,
      ).toBe(403);
      expect(
        (await call('post', retry, 'operations', { body: REASON })).body.error
          .code,
      ).toBe('IDEMPOTENCY_KEY_REQUIRED');

      custody.corrupted.clear();
      const retried = await call('post', retry, 'operations', {
        body: REASON,
        idempotencyKey: randomUUID(),
      });
      expect(retried.status).toBe(200);
      openapi.expectResponse('post', retry, retried);
      expect(retried.body.data).toMatchObject({
        status: 'PENDING',
        attempts: 0,
        lastError: null,
      });
      await waitIdentity(wineryId, 'ACTIVE');
      expect(await pausedOnChain(contract?.address as string)).toBe(false);
      // Ya confirmada, no se reintenta
      const again = await call('post', retry, 'operations', {
        body: REASON,
        idempotencyKey: randomUUID(),
      });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('CHN_TX_NOT_RETRYABLE');
      expect(again.body.error.details[0].meta.status).toBe('CONFIRMED');
      expect(
        await prisma.auditEvent.count({
          where: { action: 'CHAIN_TX_RETRIED', resourceId: failed.id },
        }),
      ).toBe(1);
    });

    it('intención que no cuadra con la base: CHN_INTENT_REJECTED, nunca firmada; se puede abandonar', async () => {
      const wineryId = await provisioned('Bodega de la Intención', 'INT');
      const contract = await contractOf(wineryId);
      const { ChainIntentsService } =
        await import('../src/modules/chain/tx/chain-intents.service');
      const intents = app.get(ChainIntentsService);
      const signaturesBefore = custody.signatures.length;
      // Pausa sin entrada de bitácora que la respalde, y un tipo reservado
      const bogusAudit = randomUUID();
      const [pause, transfer] = await prisma.$transaction(async (tx) => [
        await intents.register(tx, {
          kind: 'PAUSE_CONTRACT',
          intentKey: `pause:${contract?.id}:${bogusAudit}`,
          subject: { type: 'CONTRACT', id: contract?.id as string },
          wineryId,
          params: { auditEventId: bogusAudit },
        }),
        await intents.register(tx, {
          kind: 'OPERATOR_TRANSFER',
          intentKey: `transfer:${randomUUID()}`,
          subject: { type: 'TOKEN', id: '0' },
          wineryId,
        }),
      ]);
      for (const { transaction } of [pause, transfer]) {
        const failed = await waitTx(transaction.id, ['FAILED']);
        expect(failed.lastError).toMatchObject({
          code: 'CHN_INTENT_REJECTED',
          retryable: false,
        });
        expect(failed.txHash).toBeNull();
        expect(failed.attemptsLog.map((a) => a.status)).toEqual(['FAILED']);
        const alert = await prisma.chainAlert.findFirstOrThrow({
          where: { subjectId: failed.id },
        });
        expect(alert).toMatchObject({
          code: 'CHN_INTENT_REJECTED',
          level: 'CRITICAL',
        });
      }
      expect(custody.signatures.length).toBe(signaturesBefore);
      expect(await pausedOnChain(contract?.address as string)).toBe(false);

      // Abandonar: solo administración; después ya no se reintenta
      const abandon = `/v1/platform/chain/transactions/${pause.transaction.id}/abandon`;
      expect(
        (await call('post', abandon, 'operations', { body: REASON })).status,
      ).toBe(403);
      expect((await call('post', abandon, 'admin', { body: {} })).status).toBe(
        422,
      );
      const abandoned = await call('post', abandon, 'admin', { body: REASON });
      expect(abandoned.status).toBe(200);
      openapi.expectResponse('post', abandon, abandoned);
      expect(abandoned.body.data.abandoned).toMatchObject({
        reason: REASON.reason,
      });
      const retry = await call(
        'post',
        `/v1/platform/chain/transactions/${pause.transaction.id}/retry`,
        'admin',
        { body: REASON, idempotencyKey: randomUUID() },
      );
      expect(retry.status).toBe(409);
      expect(retry.body.error.code).toBe('CHN_TX_NOT_RETRYABLE');

      // La identidad de una bodega debe terminar: no se abandona
      const [accountTx] = await txsOf(wineryId);
      const blocked = await call(
        'post',
        `/v1/platform/chain/transactions/${accountTx.id}/abandon`,
        'admin',
        { body: REASON },
      );
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe('CHN_TX_NOT_ABANDONABLE');
      expect(blocked.body.error.details[0].meta.kind).toBe(
        'CREATE_WINERY_ACCOUNT',
      );
    });

    it('identidad FAILED (bodega sin prefijo) y `chain/provision` la relanza', async () => {
      const wineryId = await createWinery('Bodega sin Prefijo', 'TMP');
      await prisma.winery.update({
        where: { id: wineryId },
        data: { lotPrefix: null },
      });
      await emitActivated(wineryId, 'TMP');
      const failed = await waitIdentity(wineryId, 'FAILED');
      expect(failed.lastError).toMatchObject({ code: 'CHN_INTENT_REJECTED' });
      const view = await call(
        'get',
        `/v1/platform/wineries/${wineryId}/chain-account`,
        'operations',
      );
      expect(view.body.data.identity).toMatchObject({
        status: 'FAILED',
        contract: null,
        lastError: { code: 'CHN_INTENT_REJECTED' },
      });
      expect(view.body.data.identity.account.createdTx.status).toBe(
        'CONFIRMED',
      );

      await prisma.winery.update({
        where: { id: wineryId },
        data: { lotPrefix: 'PRX' },
      });
      const path = `/v1/platform/wineries/${wineryId}/chain/provision`;
      const res = await call('post', path, 'operations', { body: REASON });
      expect(res.status).toBe(202);
      openapi.expectResponse('post', path, res);
      expect(res.body.data.status).toBe('PROVISIONING');
      await waitIdentity(wineryId, 'ACTIVE');
      expect((await contractOf(wineryId))?.symbol).toBe('PRX');
      // La misma cuenta: relanzar no creó otra
      expect((await identityOf(wineryId))?.address).toBe(failed.address);
      const txs = await txsOf(wineryId);
      expect(txs.map((t) => [t.kind, t.status])).toEqual([
        ['CREATE_WINERY_ACCOUNT', 'CONFIRMED'],
        ['DEPLOY_WINERY_CONTRACT', 'CONFIRMED'],
      ]);
      expect(
        await prisma.auditEvent.count({
          where: {
            action: 'WINERY_CHAIN_PROVISION_RETRIED',
            organizationId: wineryId,
          },
        }),
      ).toBe(1);
    });

    it('una transacción en vuelo por cuenta de origen: dos identidades a la vez no chocan', async () => {
      const first = await createWinery('Bodega Paralela Uno', 'PUN');
      const second = await createWinery('Bodega Paralela Dos', 'PDO');
      await Promise.all([
        emitActivated(first, 'PUN'),
        emitActivated(second, 'PDO'),
      ]);
      await Promise.all([
        waitIdentity(first, 'ACTIVE'),
        waitIdentity(second, 'ACTIVE'),
      ]);
      const txs = [...(await txsOf(first)), ...(await txsOf(second))];
      expect(txs).toHaveLength(4);
      // Ninguna tuvo que reintentar por la secuencia
      expect(txs.every((t) => t.attempts === 1)).toBe(true);
      expect(
        txs
          .flatMap((t) => t.attemptsLog.map((a) => a.errorCode))
          .filter(Boolean),
      ).toEqual([]);
    });
  });
});
