import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  BeverageTypeEnum,
  MembershipRoleEnum,
  OrganizationStatusEnum,
  OrganizationTypeEnum,
  PrismaClient,
  WineryCategoryEnum,
  WineryStatusEnum,
} from '@prisma/client';
import { Address, Keypair } from '@stellar/stellar-sdk';
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
import { uploadTraceFile } from './helpers/trace-files';

/**
 * Ola 3 · pasos 3.4 (emisión y preventa) y 3.5 (anclaje) contra la **red
 * local** (contrato O3 §14): la API y el worker en el mismo proceso, con el
 * custodio `ENV` y un esquema y un prefijo de colas propios.
 *
 * - Aprobar → 100 NFT: `total_minted` +100, `balance` de la bodega 100 y
 *   `lot_minted` con la referencia del lote; publicar, pausar y reanudar.
 * - Ampliación a 150 con ids y números de botella continuos.
 * - 32 001 NFT → dos trozos, en orden.
 * - Aprobación doble en paralelo y evento del outbox reprocesado: una sola
 *   emisión; respuesta del envío perdida y RPC detenido: sin doble emisión.
 * - `CHAIN_MINT_ENABLED=false` (`CHN_MINT_DISABLED`) y contrato pausado.
 * - Anclaje de un lote certificado con el memo leído de la transacción,
 *   reprocesado (una sola transacción), relleno y verificación pública.
 *
 * Sin `CHAIN_E2E_RPC_URL` se omite: el resto de e2e corre sin red.
 */
const run = `${Date.now()}${randomBytes(3).toString('hex')}`;
const schema = `emision_e2e_${run}`;
const describeChain = localChainAvailable() ? describe : describe.skip;

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
  'CHAIN_MINT_ENABLED',
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
const REASON = { reason: 'Prueba de la emisión en la red local' };
const DESCRIPTION =
  'Singani de altura del Valle de Cinti, destilado en alambique de cobre y reposado.';

function urlWithSchema(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('schema', name);
  return parsed.toString();
}

async function waitFor<T>(
  what: string,
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs = 120_000,
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

describeChain('Ola 3 · emisión y anclaje contra la red local (e2e)', () => {
  const openapi = loadOpenApiValidator();
  const saved: Record<string, string | undefined> = {};
  let prisma: PrismaClient;
  let app: INestApplication;
  let worker: TestingModule;
  let gateway: FaultyGateway;
  let custody: FaultyCustody;
  let chainSettings: { mintEnabled: boolean };
  let operationsAddress = '';
  let anchorAddress = '';
  let ipSeq = 1;
  const nextIp = () => `10.242.${ipSeq % 250}.${(ipSeq++ % 250) + 1}`;
  const tokens: Record<string, string> = {};
  const timings: Record<string, number> = {};
  const fees: Record<string, string> = {};

  let WINERY = '';
  let ACCOUNT = '';
  let CONTRACT_ID = '';
  let CONTRACT = '';
  let COVER_KEY = '';
  let LOT = '';
  let LOT_REFERENCE = '';
  let COLLECTION = '';

  const http = () => request(app.getHttpServer());
  const call = (
    method: 'get' | 'post',
    path: string,
    who: string | null,
    options: { body?: object; key?: string } = {},
  ) => {
    const req = http()[method](path).set('X-Forwarded-For', nextIp());
    if (who) req.set('Authorization', `Bearer ${tokens[who]}`);
    if (options.key) req.set('Idempotency-Key', options.key);
    return method === 'get' ? req : req.send(options.body ?? {});
  };
  const post = (path: string, who: string, body: object = {}) =>
    call('post', path, who, { body, key: randomUUID() });

  const totalMinted = async () =>
    Number(
      await gateway.readContract(
        CONTRACT,
        'total_minted',
        [],
        operationsAddress,
      ),
    );
  const balanceOfWinery = async () =>
    Number(
      await gateway.readContract(
        CONTRACT,
        'balance',
        [new Address(ACCOUNT).toScVal()],
        operationsAddress,
      ),
    );

  async function createWinery(label: string, prefix: string): Promise<string> {
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
        certificationStatus: WineryStatusEnum.ACTIVE,
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
        status: OrganizationStatusEnum.ACTIVE,
        wineryId: id,
      },
    });
    return id;
  }

  async function emit(
    type: string,
    aggregateType: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ) {
    const { OutboxService } =
      await import('../src/shared/outbox/outbox.service');
    return prisma.$transaction((tx) =>
      app.get(OutboxService).add(tx, {
        type,
        aggregateType,
        aggregateId,
        queue: 'chain',
        payload: payload as never,
      }),
    );
  }

  async function newLot(name: string, estimatedBottles: number) {
    const res = await call('post', '/v1/lots', 'owner', {
      body: {
        name,
        harvestYear: new Date().getUTCFullYear(),
        productType: 'SINGANI',
        estimatedBottles,
        plannedFormatCl: 75,
        targetAbvPercent: 40,
      },
    }).expect(201);
    return res.body.data as { id: string; reference: string };
  }

  /** Solicitud enviada por la dueña y tomada por operaciones. */
  async function requestInReview(
    lotId: string,
    quantity: number,
    name: string,
  ) {
    const created = await post(
      `/v1/lots/${lotId}/tokenization-requests`,
      'owner',
      {
        quantity,
        confirm: true,
        commercial: {
          name,
          description: DESCRIPTION,
          imageKeys: [
            { key: COVER_KEY, alt: 'Botella sobre una barrica', isCover: true },
          ],
        },
      },
    ).expect(201);
    const id = created.body.data.id as string;
    await post(
      `/v1/platform/tokenization-requests/${id}/take`,
      'operations',
    ).expect(200);
    return id;
  }

  const approve = (requestId: string, body: object = {}) =>
    post(
      `/v1/platform/tokenization-requests/${requestId}/approve`,
      'operations',
      body,
    );

  const mintTxs = (mintId: string) =>
    prisma.chainTransaction.findMany({
      where: { kind: 'MINT_BATCH', subjectId: mintId },
      orderBy: { intentKey: 'asc' },
      include: { attemptsLog: { orderBy: { at: 'asc' } } },
    });
  const waitMint = (mintId: string, status: string, timeoutMs?: number) =>
    waitFor(
      `emisión ${mintId} en ${status}`,
      async () => {
        const mint = await prisma.mint.findUnique({ where: { id: mintId } });
        return mint?.status === status ? mint : null;
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

  /** Aprueba una solicitud nueva de `quantity` NFT y espera su emisión. */
  async function mintNow(lotId: string, quantity: number, name: string) {
    const requestId = await requestInReview(lotId, quantity, name);
    const res = await approve(requestId).expect(201);
    const mintId = res.body.data.mint.id as string;
    await waitMint(mintId, 'CONFIRMED');
    return {
      requestId,
      mintId,
      collectionId: res.body.data.collection.id as string,
    };
  }

  /** Lote certificado con su expediente cerrado, escrito directamente en la base. */
  async function certifiedLot(label: string, existingLotId?: string) {
    const hash = createHash('sha256')
      .update(`expediente ${label} ${run}`)
      .digest('hex');
    const lotCode = `EMI-${new Date().getUTCFullYear()}-SINGANI-${String(
      Math.floor(Math.random() * 900) + 100,
    )}${randomBytes(1).toString('hex').toUpperCase()}`;
    const lotId =
      existingLotId ?? (await newLot(`Singani certificado ${label}`, 500)).id;
    await prisma.lot.update({
      where: { id: lotId },
      data: { stage: 'CERTIFIED', lotCode },
    });
    await prisma.bottlingBatch.create({
      data: {
        wineryId: WINERY,
        productType: BeverageTypeEnum.SINGANI,
        internationalLotCode: lotCode,
        finalAlcoholAbv: 40,
        totalBottlesPackaged: 500,
        packagingFormatCl: 75,
        bottlingDate: new Date(),
        lotId,
      },
    });
    const closed = {
      status: 'CLOSED',
      hash,
      canonical: `{"lote":"${label}"}`,
      bottleCount: 500,
      closedAt: new Date(),
    };
    await prisma.lotDossier.upsert({
      where: { lotId },
      create: { lotId, ...closed },
      update: closed,
    });
    return { lotId, lotCode, hash };
  }

  const certify = (lot: { lotId: string; lotCode: string; hash: string }) =>
    emit('lot.certified', 'lot', lot.lotId, {
      lotId: lot.lotId,
      wineryId: WINERY,
      lotCode: lot.lotCode,
      hash: lot.hash,
      bottleMerkleRoot: 'b'.repeat(64),
      bottleCount: 500,
      closedAt: new Date().toISOString(),
    });

  const waitAnchor = (lotId: string, status: string) =>
    waitFor(`anclaje ${status} de ${lotId}`, async () => {
      const anchor = await prisma.dossierAnchor.findUnique({
        where: { lotId },
      });
      return anchor?.status === status ? anchor : null;
    });

  beforeAll(async () => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    const databaseUrl = urlWithSchema(process.env.DATABASE_URL ?? '', schema);
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

    const wasmHash = await uploadContractCode();
    Object.assign(process.env, {
      DATABASE_URL: databaseUrl,
      QUEUE_PREFIX: `emision-e2e-${run}`,
      STELLAR_NETWORK: 'LOCAL',
      STELLAR_RPC_URL: LOCAL_CHAIN.rpcUrl,
      STELLAR_FRIENDBOT_URL: LOCAL_CHAIN.friendbotUrl,
      STELLAR_EXPLORER_BASE_URL: EXPLORER,
      STELLAR_HOME_DOMAIN: 'api.e2e.test',
      WINERY_NFT_WASM_HASH: wasmHash,
      CHAIN_CUSTODY_DRIVER: 'ENV',
      CHAIN_MINT_ENABLED: 'true',
      CHAIN_SECRET_OPERATIONS: Keypair.random().secret(),
      CHAIN_SECRET_ANCHOR: Keypair.random().secret(),
      CHAIN_DEV_WINERY_SEED: randomBytes(32).toString('hex'),
      CHAIN_TX_RETRY_DELAYS_MS: '500,500,500,500,500',
      CHAIN_ENVIRONMENT: `emi-${run}`.slice(0, 30),
      API_PUBLIC_URL: 'https://api.e2e.test',
      OUTBOX_RELAY_INTERVAL_MS: '200',
      WORKER_HEARTBEAT_FILE: join(tmpdir(), `doc-emision-e2e-${run}.heartbeat`),
      TRUST_PROXY: '1',
    });
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

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
    await worker.init();
    await worker.get(ChainBootstrap).ready();
    chainSettings = worker.get(CHAIN_SETTINGS);
    operationsAddress = await custody.publicKey('platform-operations');
    anchorAddress = await custody.publicKey('platform-anchor');

    const { PLATFORM_ORGANIZATION_ID } =
      await import('../src/modules/organizations/organization.constants');
    for (const [who, role] of [
      ['admin', MembershipRoleEnum.ADMIN],
      ['operations', MembershipRoleEnum.OPERATIONS],
      ['support', MembershipRoleEnum.SUPPORT],
    ] as const) {
      const user = await createPlatformUser(prisma, {
        email: `${who}-emision-${run}@drinksonchain.test`,
        password: 'Plataforma-emision-123',
        role,
      });
      tokens[who] = await staffToken(app, {
        userId: user.id,
        email: user.email,
        organizationId: PLATFORM_ORGANIZATION_ID,
        organizationType: 'PLATFORM',
        role,
      });
    }

    // La bodega de la suite, con su cuenta y su contrato en la red local
    WINERY = await createWinery('Destilería de la Emisión', 'EMI');
    await emit('winery.activated', 'winery', WINERY, {
      wineryId: WINERY,
      lotPrefix: 'EMI',
      ownerUserId: randomUUID(),
      activatedAt: new Date().toISOString(),
    });
    const account = await waitFor('identidad ACTIVE', async () => {
      const row = await prisma.chainAccount.findFirst({
        where: { wineryId: WINERY, network: 'LOCAL' },
      });
      return row?.status === 'ACTIVE' ? row : null;
    });
    ACCOUNT = account.address as string;
    const contract = await prisma.nftContract.findFirstOrThrow({
      where: { wineryId: WINERY, network: 'LOCAL' },
    });
    CONTRACT_ID = contract.id;
    CONTRACT = contract.address as string;

    const email = `owner-emision-${run}@e2e.test`;
    const { userId } = await addWineryMember(app, {
      wineryId: WINERY,
      role: 'OWNER',
      email,
      fullName: 'Dueña de la emisión',
    });
    tokens.owner = await staffToken(app, {
      userId,
      email,
      organizationId: WINERY,
      organizationType: 'WINERY',
      role: MembershipRoleEnum.OWNER,
    });
    COVER_KEY = await uploadTraceFile(app, tokens.owner, {
      folder: 'labels',
      file: Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from(`portada de la emisión ${run}`),
      ]),
      name: 'portada.png',
      ip: nextIp(),
    });
    const lot = await newLot(`Singani Preventa ${run}`, 3000);
    LOT = lot.id;
    LOT_REFERENCE = lot.reference;
  }, 300_000);

  afterEach(() => {
    gateway.down = false;
    gateway.loseNextSendResponse = false;
    gateway.staleSequenceOnce = false;
    chainSettings.mintEnabled = true;
  });

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
    process.stdout.write(
      `\n[emision-o3] tiempos en la red local (ms): ${JSON.stringify(timings)}\n[emision-o3] comisiones (stroops): ${JSON.stringify(fees)}\n`,
    );
  }, 120_000);

  // ─────────────────────────────────────────────────────────────────────────
  describe('emisión al aprobar (§6.1)', () => {
    let MINT = '';

    it('aprobar → 100 NFT en la red: total_minted +100, balance 100 y lot_minted con la referencia del lote', async () => {
      expect(await totalMinted()).toBe(0);
      const requestId = await requestInReview(
        LOT,
        100,
        `Singani Preventa ${run}`,
      );
      const signaturesBefore = custody.signatures.length;
      const started = Date.now();
      const res = await approve(requestId);
      expect(res.status).toBe(201);
      MINT = res.body.data.mint.id;
      COLLECTION = res.body.data.collection.id;
      expect(res.body.data.collection.status).toBe('MINTING');
      expect(res.body.data.mint.transactions).toHaveLength(1);

      await waitMint(MINT, 'CONFIRMED');
      timings.emision100 = Date.now() - started;
      const [tx] = await mintTxs(MINT);
      fees.mint100Primero = String(tx.feeChargedStroops);
      expect(tx).toMatchObject({
        status: 'CONFIRMED',
        intentKey: `mint:${MINT}:1`,
        sourceAccount: operationsAddress,
        attempts: 1,
      });
      // Sobre de operaciones; la autorización, de la cuenta de la bodega
      expect(tx.signers).toEqual([
        { role: 'OPERATIONS', address: operationsAddress, wineryId: null },
        { role: 'WINERY', address: ACCOUNT, wineryId: WINERY },
      ]);
      expect(custody.signatures.slice(signaturesBefore).sort()).toEqual([
        'platform-operations',
        `winery-${WINERY}`,
      ]);
      expect(tx.result).toMatchObject({
        returnValue: 99,
        contractEvents: expect.arrayContaining([
          'consecutive_mint',
          'lot_minted',
        ]),
      });

      // La red: contador, saldo y evento con la referencia del lote
      expect(await totalMinted()).toBe(100);
      expect(await balanceOfWinery()).toBe(100);
      const lookup = await gateway.getTransaction(tx.txHash as string);
      if (lookup.status !== 'SUCCESS') throw new Error('sin transacción');
      const lotMinted = lookup.events.find((e) => e.name === 'lot_minted');
      expect(lotMinted).toMatchObject({
        topics: [LOT_REFERENCE, ACCOUNT],
        data: { first_token_id: 0, last_token_id: 99, minter: ACCOUNT },
      });
      expect(lookup.sourceAccount).toBe(operationsAddress);

      // La base: emisión, colección y un NFT por botella
      const mint = await prisma.mint.findUniqueOrThrow({ where: { id: MINT } });
      expect(mint.ranges).toEqual([
        {
          firstTokenId: 0,
          lastTokenId: 99,
          firstBottleNumber: 1,
          lastBottleNumber: 100,
        },
      ]);
      expect(mint.confirmedAt).not.toBeNull();
      const collection = await prisma.collection.findUniqueOrThrow({
        where: { id: COLLECTION },
      });
      expect(collection).toMatchObject({
        status: 'READY',
        mintStatus: 'CONFIRMED',
        quota: 100,
        minted: 100,
        pendingMintQuantity: 0,
      });
      const nfts = await prisma.token.findMany({
        where: { collectionId: COLLECTION },
        orderBy: { bottleNumber: 'asc' },
      });
      expect(nfts).toHaveLength(100);
      expect(nfts.map((t) => t.tokenId)).toEqual(
        Array.from({ length: 100 }, (_, i) => i),
      );
      expect(nfts.map((t) => t.bottleNumber)).toEqual(
        Array.from({ length: 100 }, (_, i) => i + 1),
      );
      expect(
        nfts.every(
          (t) =>
            t.status === 'MINTED' &&
            t.ownerKind === 'WINERY' &&
            t.ownerAddress === ACCOUNT &&
            t.contractId === CONTRACT_ID &&
            t.mintTxId === tx.id,
        ),
      ).toBe(true);

      // Bitácora, línea de tiempo, correo y outbox
      expect(
        await prisma.auditEvent.count({
          where: { action: 'NFT_MINTED', resourceId: MINT },
        }),
      ).toBe(1);
      const events = await prisma.lotEvent.findMany({
        where: { lotId: LOT, type: 'NFT_MINTED' },
      });
      expect(events).toHaveLength(1);
      expect(events[0].visibility).toBe('PUBLIC');
      expect(
        await prisma.emailMessage.count({
          where: { template: 'nft-emitidos' },
        }),
      ).toBe(1);
      expect(
        await prisma.outboxEvent.count({
          where: { eventType: 'collection.minted', aggregateId: COLLECTION },
        }),
      ).toBe(1);
    });

    it('el back office y el ERP ven la colección emitida, sus NFT y la transacción con enlace al explorador', async () => {
      const path = `/v1/platform/collections/${COLLECTION}`;
      const res = await call('get', path, 'support');
      expect(res.status).toBe(200);
      openapi.expectResponse('get', path, res);
      expect(res.body.data).toMatchObject({
        status: 'READY',
        mintStatus: 'CONFIRMED',
        counts: { minted: 100, available: 100 },
        contract: { address: CONTRACT },
      });
      const [tx] = res.body.data.mints[0].transactions;
      expect(tx).toMatchObject({ kind: 'MINT_BATCH', status: 'CONFIRMED' });
      expect(tx.explorerUrl).toBe(`${EXPLORER}/tx/${tx.txHash}`);
      const nfts = await call(
        'get',
        `/v1/collections/${COLLECTION}/tokens?limit=5`,
        'owner',
      );
      expect(nfts.status).toBe(200);
      expect(nfts.body.data.total).toBe(100);
      const lot = await call('get', `/v1/lots/${LOT}`, 'owner');
      expect(lot.body.data.tokenization).toMatchObject({
        state: 'READY',
        quota: 100,
        minted: 100,
      });
    });

    it('publicar, pausar y reanudar con la emisión confirmada', async () => {
      const base = `/v1/platform/collections/${COLLECTION}`;
      const published = await post(`${base}/publish`, 'operations', REASON);
      expect(published.status).toBe(200);
      expect(published.body.data).toMatchObject({
        status: 'PUBLISHED',
        saleState: 'PRESALE',
      });
      const paused = await post(`${base}/pause`, 'operations', REASON);
      expect(paused.body.data.status).toBe('PAUSED');
      const resumed = await post(`${base}/resume`, 'operations', REASON);
      expect(resumed.body.data).toMatchObject({
        status: 'PUBLISHED',
        saleState: 'PRESALE',
      });
      // Nada de esto toca la red
      expect(await totalMinted()).toBe(100);
    });

    it('ampliación a 150: ids y números de botella continuos, sin cambiar el estado', async () => {
      const requestId = await requestInReview(LOT, 50, 'Ampliación');
      const res = await approve(requestId);
      expect(res.status).toBe(201);
      expect(res.body.data.request.kind).toBe('QUOTA_INCREASE');
      const mintId = res.body.data.mint.id as string;
      await waitMint(mintId, 'CONFIRMED');
      const [tx] = await mintTxs(mintId);
      fees.mint50Siguiente = String(tx.feeChargedStroops);
      const mint = await prisma.mint.findUniqueOrThrow({
        where: { id: mintId },
      });
      expect(mint.sequence).toBe(2);
      expect(mint.ranges).toEqual([
        {
          firstTokenId: 100,
          lastTokenId: 149,
          firstBottleNumber: 101,
          lastBottleNumber: 150,
        },
      ]);
      expect(await totalMinted()).toBe(150);
      expect(await balanceOfWinery()).toBe(150);
      const collection = await prisma.collection.findUniqueOrThrow({
        where: { id: COLLECTION },
      });
      expect(collection).toMatchObject({
        status: 'PUBLISHED',
        mintStatus: 'CONFIRMED',
        quota: 150,
        minted: 150,
        pendingMintQuantity: 0,
      });
      const last = await prisma.token.findMany({
        where: { collectionId: COLLECTION, mintId },
        orderBy: { bottleNumber: 'asc' },
      });
      expect(last).toHaveLength(50);
      expect([last[0].tokenId, last[0].bottleNumber]).toEqual([100, 101]);
      expect([last[49].tokenId, last[49].bottleNumber]).toEqual([149, 150]);
    });

    it('32 001 NFT → dos trozos en orden (32 000 + 1)', async () => {
      const lot = await newLot(`Singani de dos trozos ${run}`, 40_000);
      const before = await totalMinted();
      const requestId = await requestInReview(
        lot.id,
        32_001,
        `Dos trozos ${run}`,
      );
      const res = await approve(requestId, { publishOnMint: true });
      expect(res.status).toBe(201);
      const mintId = res.body.data.mint.id as string;
      expect(res.body.data.mint.transactions).toHaveLength(2);
      await waitMint(mintId, 'CONFIRMED', 240_000);
      const txs = await mintTxs(mintId);
      expect(txs.map((t) => [t.intentKey, t.status])).toEqual([
        [`mint:${mintId}:1`, 'CONFIRMED'],
        [`mint:${mintId}:2`, 'CONFIRMED'],
      ]);
      expect((txs[0].ledger as number) < (txs[1].ledger as number)).toBe(true);
      fees.mint32000 = String(txs[0].feeChargedStroops);
      const mint = await prisma.mint.findUniqueOrThrow({
        where: { id: mintId },
      });
      expect(mint.ranges).toEqual([
        {
          firstTokenId: before,
          lastTokenId: before + 31_999,
          firstBottleNumber: 1,
          lastBottleNumber: 32_000,
        },
        {
          firstTokenId: before + 32_000,
          lastTokenId: before + 32_000,
          firstBottleNumber: 32_001,
          lastBottleNumber: 32_001,
        },
      ]);
      expect(await totalMinted()).toBe(before + 32_001);
      const collectionId = res.body.data.collection.id as string;
      expect(await prisma.token.count({ where: { collectionId } })).toBe(
        32_001,
      );
      // `publishOnMint`: publicada sola al confirmarse el último trozo
      const collection = await prisma.collection.findUniqueOrThrow({
        where: { id: collectionId },
      });
      expect(collection).toMatchObject({
        status: 'PUBLISHED',
        minted: 32_001,
        mintStatus: 'CONFIRMED',
      });
      expect(collection.publishedAt).not.toBeNull();
      expect(
        await prisma.lotEvent.count({
          where: { lotId: lot.id, type: 'COLLECTION_PUBLISHED' },
        }),
      ).toBe(1);
    }, 300_000);
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('idempotencia y fallos (§2.3, §14)', () => {
    it('aprobación doble en paralelo → una sola emisión en la red', async () => {
      const lot = await newLot(`Singani en paralelo ${run}`, 500);
      const before = await totalMinted();
      const requestId = await requestInReview(lot.id, 10, `Paralelo ${run}`);
      const results = await Promise.all([
        approve(requestId),
        approve(requestId),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      const ok = results.find((r) => r.status === 201) as request.Response;
      const mintId = ok.body.data.mint.id as string;
      await waitMint(mintId, 'CONFIRMED');
      expect(await prisma.mint.count({ where: { requestId } })).toBe(1);
      expect(await mintTxs(mintId)).toHaveLength(1);
      expect(await totalMinted()).toBe(before + 10);
    });

    it('evento del outbox reprocesado → una sola transacción', async () => {
      const lot = await newLot(`Singani reprocesado ${run}`, 500);
      const before = await totalMinted();
      const { requestId, mintId, collectionId } = await mintNow(
        lot.id,
        7,
        `Reprocesado ${run}`,
      );
      const [original] = await prisma.outboxEvent.findMany({
        where: {
          eventType: 'tokenization.request_approved',
          aggregateId: requestId,
        },
      });
      const again = await emit(
        'tokenization.request_approved',
        'tokenization_request',
        requestId,
        original.payload as Record<string, unknown>,
      );
      await waitFor('evento reprocesado', async () => {
        const row = await prisma.outboxEvent.findUnique({
          where: { id: again.id },
        });
        return row?.status === 'DONE';
      });
      expect(await mintTxs(mintId)).toHaveLength(1);
      expect(await totalMinted()).toBe(before + 7);
      expect(await prisma.token.count({ where: { collectionId } })).toBe(7);
    });

    it('respuesta del envío perdida a mitad: se consulta el hash y no se emite dos veces', async () => {
      const lot = await newLot(`Singani del envío perdido ${run}`, 500);
      const before = await totalMinted();
      const requestId = await requestInReview(lot.id, 5, `Perdido ${run}`);
      const sendsBefore = gateway.sends;
      gateway.loseNextSendResponse = true;
      const res = await approve(requestId).expect(201);
      const mintId = res.body.data.mint.id as string;
      await waitMint(mintId, 'CONFIRMED');
      const [tx] = await mintTxs(mintId);
      expect(tx.attemptsLog.map((a) => a.status)).toContain('RETRYING');
      // Un solo envío: el segundo intento encontró el hash del primero
      expect(gateway.sends - sendsBefore).toBe(1);
      expect(
        new Set(tx.attemptsLog.map((a) => a.txHash).filter(Boolean)).size,
      ).toBe(1);
      expect(await totalMinted()).toBe(before + 5);
      expect(await prisma.token.count({ where: { mintId } })).toBe(5);
    });

    it('RPC detenido: RETRYING y, al volver, total_minted sube una sola vez', async () => {
      const lot = await newLot(`Singani del RPC caído ${run}`, 500);
      const before = await totalMinted();
      const requestId = await requestInReview(lot.id, 4, `RPC ${run}`);
      gateway.down = true;
      const res = await approve(requestId).expect(201);
      const mintId = res.body.data.mint.id as string;
      const retrying = await waitFor('RETRYING por RPC', async () => {
        const [tx] = await mintTxs(mintId);
        return tx?.status === 'RETRYING' ? tx : null;
      });
      expect(retrying.lastError).toMatchObject({
        code: 'CHN_RPC_UNAVAILABLE',
        retryable: true,
      });
      expect(
        (await prisma.mint.findUniqueOrThrow({ where: { id: mintId } })).status,
      ).toBe('IN_PROGRESS');
      gateway.down = false;
      await waitMint(mintId, 'CONFIRMED');
      expect(await totalMinted()).toBe(before + 4);
      expect(await prisma.token.count({ where: { mintId } })).toBe(4);
    });

    it('CHAIN_MINT_ENABLED=false: la intención queda PENDING con CHN_MINT_DISABLED y se emite al activarla', async () => {
      const { ChainSigner } =
        await import('../src/modules/chain/jobs/signer/chain-signer.service');
      const lot = await newLot(`Singani con la emisión apagada ${run}`, 500);
      const before = await totalMinted();
      const requestId = await requestInReview(lot.id, 3, `Apagada ${run}`);
      chainSettings.mintEnabled = false;
      const res = await approve(requestId).expect(201);
      const mintId = res.body.data.mint.id as string;
      const held = await waitFor('intención en espera', async () => {
        const [tx] = await mintTxs(mintId);
        return tx?.lastError ? tx : null;
      });
      expect(held).toMatchObject({
        status: 'PENDING',
        txHash: null,
        attempts: 0,
      });
      expect(held.lastError).toMatchObject({ code: 'CHN_MINT_DISABLED' });
      expect(
        (await prisma.mint.findUniqueOrThrow({ where: { id: mintId } })).status,
      ).toBe('PENDING');
      expect(await totalMinted()).toBe(before);
      // Publicar sin emisión confirmada → 409
      const publish = await post(
        `/v1/platform/collections/${res.body.data.collection.id}/publish`,
        'operations',
        REASON,
      );
      expect([publish.status, publish.body.error?.code]).toEqual([
        409,
        'TOK_MINT_NOT_CONFIRMED',
      ]);

      chainSettings.mintEnabled = true;
      await worker.get(ChainSigner).process(held.id);
      await waitMint(mintId, 'CONFIRMED');
      expect(await totalMinted()).toBe(before + 3);
    });

    it('contrato pausado: la intención se rechaza sin firmarse (emisión FAILED) y se reintenta al reanudarlo', async () => {
      const { ChainSigner } =
        await import('../src/modules/chain/jobs/signer/chain-signer.service');
      const lot = await newLot(`Singani con el contrato pausado ${run}`, 500);
      const before = await totalMinted();
      const requestId = await requestInReview(lot.id, 2, `Pausado ${run}`);
      // Aprobada con el contrato en marcha; la pausa llega antes de emitirse
      chainSettings.mintEnabled = false;
      const res = await approve(requestId).expect(201);
      const mintId = res.body.data.mint.id as string;
      const collectionId = res.body.data.collection.id as string;
      const held = await waitFor('intención en espera', async () => {
        const [tx] = await mintTxs(mintId);
        return tx?.lastError ? tx : null;
      });
      const paused = await call(
        'post',
        `/v1/platform/wineries/${WINERY}/chain/pause`,
        'admin',
        { body: REASON, key: randomUUID() },
      );
      expect(paused.status).toBe(202);
      await waitFor('contrato pausado', async () => {
        const contract = await prisma.nftContract.findUnique({
          where: { id: CONTRACT_ID },
        });
        return contract?.paused === true;
      });
      // Con el contrato pausado no se aprueba otra emisión
      const other = await requestInReview(
        (await newLot(`Otro lote ${run}`, 500)).id,
        1,
        `Otro ${run}`,
      );
      const blocked = await approve(other);
      expect([blocked.status, blocked.body.error?.code]).toEqual([
        409,
        'CHN_CONTRACT_PAUSED',
      ]);

      chainSettings.mintEnabled = true;
      const signaturesBefore = custody.signatures.length;
      await worker.get(ChainSigner).process(held.id);
      const failed = await waitTx(held.id, ['FAILED']);
      expect(failed.lastError).toMatchObject({ code: 'CHN_INTENT_REJECTED' });
      expect(failed.txHash).toBeNull();
      expect(custody.signatures.length).toBe(signaturesBefore);
      expect(
        (await prisma.mint.findUniqueOrThrow({ where: { id: mintId } })).status,
      ).toBe('FAILED');
      expect(
        (
          await prisma.collection.findUniqueOrThrow({
            where: { id: collectionId },
          })
        ).mintStatus,
      ).toBe('FAILED');
      expect(
        await prisma.chainAlert.count({
          where: { code: 'CHN_INTENT_REJECTED', subjectId: held.id },
        }),
      ).toBe(1);
      expect(await totalMinted()).toBe(before);

      const unpaused = await call(
        'post',
        `/v1/platform/wineries/${WINERY}/chain/unpause`,
        'admin',
        { body: REASON, key: randomUUID() },
      );
      expect(unpaused.status).toBe(202);
      await waitFor('contrato reanudado', async () => {
        const contract = await prisma.nftContract.findUnique({
          where: { id: CONTRACT_ID },
        });
        return contract?.paused === false;
      });
      const retry = await call(
        'post',
        `/v1/platform/chain/transactions/${held.id}/retry`,
        'operations',
        { body: REASON, key: randomUUID() },
      );
      expect(retry.status).toBe(200);
      await waitMint(mintId, 'CONFIRMED');
      expect(await totalMinted()).toBe(before + 2);
      expect(
        (
          await prisma.collection.findUniqueOrThrow({
            where: { id: collectionId },
          })
        ).status,
      ).toBe('READY');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('anclaje del expediente (§7)', () => {
    let anchored: { lotId: string; lotCode: string; hash: string };

    it('lot.certified → ANCHOR_DOSSIER confirmado: memo = huella, origen = cuenta de anclaje, lote ANCHORED y NFT canjeables', async () => {
      // El lote de la colección publicada, ya certificado, con un NFT vendido
      anchored = await certifiedLot('con colección', LOT);
      const sold = await prisma.token.findFirstOrThrow({
        where: { collectionId: COLLECTION, bottleNumber: 1 },
      });
      await prisma.token.update({
        where: { id: sold.id },
        data: { status: 'SOLD', soldAt: new Date() },
      });
      const signaturesBefore = custody.signatures.length;
      const started = Date.now();
      await certify(anchored);
      const anchor = await waitAnchor(anchored.lotId, 'ANCHORED');
      timings.anclaje = Date.now() - started;
      const tx = await prisma.chainTransaction.findUniqueOrThrow({
        where: { id: anchor.transactionId as string },
      });
      fees.anclaje = String(tx.feeChargedStroops);
      expect(tx).toMatchObject({
        kind: 'ANCHOR_DOSSIER',
        status: 'CONFIRMED',
        intentKey: `anchor:${anchored.lotId}`,
        sourceAccount: anchorAddress,
      });
      expect(custody.signatures.slice(signaturesBefore)).toEqual([
        'platform-anchor',
      ]);
      expect(anchor).toMatchObject({
        account: anchorAddress,
        memoHashHex: anchored.hash,
        txHash: tx.txHash,
        network: 'LOCAL',
      });
      expect(anchor.verifiedAt).not.toBeNull();
      expect(anchor.anchoredAt).not.toBeNull();

      // La transacción, leída de la red: clásica, con el memo y sin efecto
      const lookup = await gateway.getTransaction(tx.txHash as string);
      if (lookup.status !== 'SUCCESS') throw new Error('sin transacción');
      expect(lookup.memoHashHex).toBe(anchored.hash);
      expect(lookup.sourceAccount).toBe(anchorAddress);
      expect(lookup.events).toEqual([]);

      // Efectos de §7.2
      const lot = await prisma.lot.findUniqueOrThrow({
        where: { id: anchored.lotId },
      });
      expect(lot.stage).toBe('ANCHORED');
      const types = (
        await prisma.lotEvent.findMany({
          where: { lotId: anchored.lotId },
          orderBy: { seq: 'asc' },
        })
      ).map((e) => e.type);
      expect(types.slice(-2)).toEqual([
        'DOSSIER_ANCHORED',
        'TOKENS_REDEEMABLE',
      ]);
      const bottling = await prisma.bottlingBatch.findUniqueOrThrow({
        where: { lotId: anchored.lotId },
      });
      expect(bottling).toMatchObject({
        isAnchoredOnChain: true,
        blockchainAnchorTxHash: tx.txHash,
      });
      expect(bottling.anchoredAt).toEqual(anchor.anchoredAt);
      const collection = await prisma.collection.findUniqueOrThrow({
        where: { id: COLLECTION },
      });
      expect(collection.redeemable).toBe(true);
      expect(collection.redeemableSince).toEqual(anchor.anchoredAt);
      const token = await prisma.token.findUniqueOrThrow({
        where: { id: sold.id },
      });
      expect(token.status).toBe('REDEEMABLE');
      expect(token.redeemableAt).toEqual(anchor.anchoredAt);
      // `canje.ventanaDias` por defecto: 30 días
      expect(
        (token.redeemWindowEndsAt as Date).getTime() -
          (token.redeemableAt as Date).getTime(),
      ).toBe(30 * 86_400_000);
      expect(
        await prisma.token.count({
          where: { collectionId: COLLECTION, status: 'MINTED' },
        }),
      ).toBe(149);
      for (const eventType of ['lot.anchored', 'collection.redeemable']) {
        expect(await prisma.outboxEvent.count({ where: { eventType } })).toBe(
          1,
        );
      }
      for (const action of ['DOSSIER_ANCHORED', 'TOKENS_REDEEMABLE']) {
        expect(await prisma.auditEvent.count({ where: { action } })).toBe(1);
      }
      const view = await call(
        'get',
        `/v1/platform/collections/${COLLECTION}`,
        'support',
      );
      expect(view.body.data).toMatchObject({
        saleState: 'ON_SALE',
        redeemable: true,
        anchor: { status: 'ANCHORED', txHash: tx.txHash },
      });
    });

    it('el expediente del ERP y la verificación pública muestran el anclaje con sus cuatro comprobaciones', async () => {
      const dossierPath = `/v1/lots/${anchored.lotId}/dossier`;
      const dossier = await call('get', dossierPath, 'owner');
      expect(dossier.status).toBe(200);
      openapi.expectResponse('get', dossierPath, dossier);
      expect(dossier.body.data.anchor).toMatchObject({
        status: 'ANCHORED',
        network: 'LOCAL',
        account: anchorAddress,
        memoHashHex: anchored.hash,
        memoHashBase64: Buffer.from(anchored.hash, 'hex').toString('base64'),
        transaction: { kind: 'ANCHOR_DOSSIER', status: 'CONFIRMED' },
      });
      expect(dossier.body.data.anchor.explorerUrl).toBe(
        `${EXPLORER}/tx/${dossier.body.data.anchor.txHash}`,
      );

      const path = `/v1/public/lots/${anchored.lotCode}/verification`;
      const res = await call('get', path, null);
      expect(res.status).toBe(200);
      openapi.expectResponse('get', path, res);
      expect(res.headers['cache-control']).toContain('max-age=3600');
      expect(res.body.data).toMatchObject({
        lotCode: anchored.lotCode,
        dossier: {
          status: 'CLOSED',
          hash: anchored.hash,
          algorithm: 'sha256/jcs-rfc8785',
        },
        anchor: {
          status: 'ANCHORED',
          account: anchorAddress,
          memoHashHex: anchored.hash,
        },
        officialAnchorAccount: anchorAddress,
      });
      expect(res.body.data.verifiedOnChainAt).not.toBeNull();
      expect(
        res.body.data.checks.map((c: { key: string; pass: boolean }) => [
          c.key,
          c.pass,
        ]),
      ).toEqual([
        ['DOSSIER_CLOSED', true],
        ['ANCHOR_CONFIRMED', true],
        ['MEMO_MATCHES_HASH', true],
        ['ANCHOR_ACCOUNT_OFFICIAL', true],
      ]);
      const missing = await call(
        'get',
        '/v1/public/lots/EMI-2026-SINGANI-000/verification',
        null,
      );
      expect([missing.status, missing.body.error?.code]).toEqual([
        404,
        'PUB_CODE_NOT_FOUND',
      ]);
    });

    it('anclaje reprocesado → una sola transacción', async () => {
      const again = await certify(anchored);
      await waitFor('lot.certified reprocesado', async () => {
        const row = await prisma.outboxEvent.findUnique({
          where: { id: again.id },
        });
        return row?.status === 'DONE';
      });
      expect(
        await prisma.chainTransaction.count({
          where: { kind: 'ANCHOR_DOSSIER', subjectId: anchored.lotId },
        }),
      ).toBe(1);
      expect(
        await prisma.dossierAnchor.count({ where: { lotId: anchored.lotId } }),
      ).toBe(1);
    });

    it('chain.anchor.backfill ancla un lote certificado sin colección que no tenía anclaje', async () => {
      const { DossierAnchorService } =
        await import('../src/modules/chain/anchor/dossier-anchor.service');
      const pending = await certifiedLot('sin colección');
      const before = await call(
        'get',
        `/v1/public/lots/${pending.lotCode}/verification`,
        null,
      );
      expect(before.body.data.anchor).toBeNull();
      expect(
        before.body.data.checks.map((c: { pass: boolean | null }) => c.pass),
      ).toEqual([true, false, null, null]);

      const result = await worker.get(DossierAnchorService).backfill();
      expect(result.requested).toBe(1);
      await waitAnchor(pending.lotId, 'ANCHORED');
      const lot = await prisma.lot.findUniqueOrThrow({
        where: { id: pending.lotId },
      });
      expect(lot.stage).toBe('ANCHORED');
      // Repetirlo no pide nada más
      expect(
        (await worker.get(DossierAnchorService).backfill()).requested,
      ).toBe(0);
    });
  });
});
