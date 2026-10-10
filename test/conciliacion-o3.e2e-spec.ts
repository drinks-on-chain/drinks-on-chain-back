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
  Prisma,
  PrismaClient,
  WineryCategoryEnum,
  WineryStatusEnum,
} from '@prisma/client';
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
  authorizeEntry,
  nativeToScVal,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';
import * as request from 'supertest';
import type { ChainIndexer } from '../src/modules/chain/jobs/indexer/chain-indexer.service';
import type { ChainReconciler } from '../src/modules/chain/jobs/reconcile/chain-reconciler.service';
import type { ChainSigner } from '../src/modules/chain/jobs/signer/chain-signer.service';
import type { ChainTtlService } from '../src/modules/chain/jobs/ttl/chain-ttl.service';
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
 * Ola 3 · paso 3.6 contra la **red local** (contrato O3 §8 y §14): indexador,
 * conciliación y alertas, TTL, cierre del lote con faltante, datos reales de
 * la cuenta de la bodega y del tablero, y los cabos de 3.4–3.5.
 *
 * - Recorrido limpio (identidad → 100 NFT → ampliación → embotellado →
 *   anclaje) y conciliación `FULL` en `OK`.
 * - Faltante: autorizar 100 y embotellar 80 → 20 NFT quemados tras la
 *   decisión de administración, `BURNED` en la red (`owner_of` falla).
 * - Diferencia provocada en la base (`TOTAL_MINTED_MISMATCH`), que nadie
 *   corrige sola, y evento que el sistema no originó (`UNEXPECTED_EVENT`).
 * - Bodega suspendida (colección `PAUSED`, emisión en espera) y revocada
 *   (contrato pausado en la red).
 * - `EXTEND_TTL` real y `RESTORE_ENTRIES` con un RPC simulado (S-25: la red
 *   local no archiva entradas).
 * - `SET_TOKEN_URI_BASE`, idempotencia por `total_minted`/`lot_minted`,
 *   «el rango no cuadra» y «el memo no cuadra».
 *
 * Sin `CHAIN_E2E_RPC_URL` se omite: el resto de e2e corre sin red.
 */
const run = `${Date.now()}${randomBytes(3).toString('hex')}`;
const schema = `conciliacion_e2e_${run}`;
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
const REASON = { reason: 'Prueba del paso 3.6 en la red local' };
const DESCRIPTION =
  'Singani de altura del Valle de Cinti, destilado en alambique de cobre y reposado.';
const LEDGERS_PER_DAY = 17_280;
const YEAR = new Date().getUTCFullYear();

function urlWithSchema(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('schema', name);
  return parsed.toString();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    await sleep(250);
  }
  throw new Error(`Tiempo agotado esperando: ${what} (${String(last)})`);
}

describeChain(
  'Ola 3 · indexador, conciliación, TTL y cierre con faltante contra la red local (e2e)',
  () => {
    // Cada caso espera transacciones reales en la red local
    jest.setTimeout(300_000);
    const openapi = loadOpenApiValidator();
    const saved: Record<string, string | undefined> = {};
    let prisma: PrismaClient;
    let app: INestApplication;
    let worker: TestingModule;
    let gateway: FaultyGateway;
    let custody: FaultyCustody;
    let chainSettings: { mintEnabled: boolean; ttlExtendBelowDays: number };
    let indexer: ChainIndexer;
    let reconciler: ChainReconciler;
    let ttl: ChainTtlService;
    let signer: ChainSigner;
    let accountsSync: { checkBalances(): Promise<unknown> };
    /** La revisión del TTL tras cada emisión solo corre donde se prueba. */
    let autoTtl = false;
    let runTtl: ChainTtlService['run'];
    let operationsAddress = '';
    let anchorAddress = '';
    let ipSeq = 1;
    const nextIp = () => `10.243.${ipSeq % 250}.${(ipSeq++ % 250) + 1}`;
    const tokens: Record<string, string> = {};
    const fees: Record<string, string> = {};
    const timings: Record<string, number> = {};

    let WINERY = '';
    let ACCOUNT = '';
    let CONTRACT_ID = '';
    let CONTRACT = '';
    let COVER_KEY = '';
    let LOT = '';
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
    const get = (path: string, who: string | null) => call('get', path, who);
    const post = (path: string, who: string, body: object = {}) =>
      call('post', path, who, { body, key: randomUUID() });

    const readContract = (
      contract: string,
      method: string,
      args: xdr.ScVal[] = [],
    ) => gateway.readContract(contract, method, args, operationsAddress);
    const totalMinted = async (contract = CONTRACT) =>
      Number(await readContract(contract, 'total_minted'));
    const balanceOf = async (account = ACCOUNT, contract = CONTRACT) =>
      Number(
        await readContract(contract, 'balance', [
          new Address(account).toScVal(),
        ]),
      );
    /** Dueño en la red, o el código de error del contrato si `owner_of` falla. */
    const ownerOf = async (tokenId: number, contract = CONTRACT) => {
      try {
        return String(
          await readContract(contract, 'owner_of', [
            nativeToScVal(tokenId, { type: 'u32' }),
          ]),
        );
      } catch (error) {
        const failure = error as { meta?: { contractErrorCode?: number } };
        return `error:${failure.meta?.contractErrorCode ?? '?'}`;
      }
    };

    async function createWinery(
      label: string,
      prefix: string,
    ): Promise<string> {
      const id = randomUUID();
      await prisma.winery.create({
        data: {
          id,
          legalName: `${label} S.R.L.`,
          commercialName: label,
          beverageCategory: WineryCategoryEnum.DISTILLERY,
          taxIdNit: `${Date.now()}${Math.floor(Math.random() * 1e4)}`.slice(
            -15,
          ),
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
      queue: 'chain' | 'default' = 'chain',
    ) {
      const { OutboxService } =
        await import('../src/shared/outbox/outbox.service');
      return prisma.$transaction((tx) =>
        app.get(OutboxService).add(tx, {
          type,
          aggregateType,
          aggregateId,
          queue,
          payload: payload as never,
        }),
      );
    }

    /** Bodega activa con su cuenta y su contrato en la red local. */
    async function provisionWinery(label: string, prefix: string) {
      const wineryId = await createWinery(label, prefix);
      await emit('winery.activated', 'winery', wineryId, {
        wineryId,
        lotPrefix: prefix,
        ownerUserId: randomUUID(),
        activatedAt: new Date().toISOString(),
      });
      const account = await waitFor(
        `identidad ACTIVE de ${label}`,
        async () => {
          const row = await prisma.chainAccount.findFirst({
            where: { wineryId, network: 'LOCAL' },
          });
          return row?.status === 'ACTIVE' ? row : null;
        },
      );
      const contract = await prisma.nftContract.findFirstOrThrow({
        where: { wineryId, network: 'LOCAL' },
      });
      return {
        wineryId,
        account: account.address as string,
        contractId: contract.id,
        contract: contract.address as string,
      };
    }

    const members: Record<
      string,
      {
        userId: string;
        email: string;
        wineryId: string;
        role: MembershipRoleEnum;
      }
    > = {};

    /** Sesión nueva de un miembro (suspender una bodega cierra las que había). */
    async function login(who: string) {
      const member = members[who];
      tokens[who] = await staffToken(app, {
        userId: member.userId,
        email: member.email,
        organizationId: member.wineryId,
        organizationType: 'WINERY',
        role: member.role,
      });
    }

    async function wineryToken(
      who: string,
      wineryId: string,
      role: 'OWNER' | 'ENOLOGIST' | 'ACCOUNTANT',
    ) {
      const email = `${who}-conciliacion-${run}@e2e.test`;
      const { userId } = await addWineryMember(app, {
        wineryId,
        role,
        email,
        fullName: `Persona ${who}`,
      });
      members[who] = { userId, email, wineryId, role };
      await login(who);
    }

    async function newLot(
      name: string,
      estimatedBottles: number,
      who = 'owner',
    ) {
      const res = await call('post', '/v1/lots', who, {
        body: {
          name,
          harvestYear: YEAR,
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
      who = 'owner',
      coverKey = COVER_KEY,
    ) {
      const created = await post(
        `/v1/lots/${lotId}/tokenization-requests`,
        who,
        {
          quantity,
          confirm: true,
          commercial: {
            name,
            description: DESCRIPTION,
            imageKeys: [
              {
                key: coverKey,
                alt: 'Botella sobre una barrica',
                isCover: true,
              },
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
    const waitTx = (
      where: Prisma.ChainTransactionWhereInput,
      statuses: string[],
      timeoutMs?: number,
    ) =>
      waitFor(
        `transacción ${JSON.stringify(where)} en ${statuses.join('/')}`,
        async () => {
          const tx = await prisma.chainTransaction.findFirst({
            where,
            include: { attemptsLog: { orderBy: { at: 'asc' } } },
          });
          return tx && statuses.includes(tx.status) ? tx : null;
        },
        timeoutMs,
      );

    /** Nada pendiente de salir a la red (ni esperando turno). */
    const idle = () =>
      waitFor('la cola de la cadena vacía', async () => {
        const open = await prisma.chainTransaction.count({
          where: {
            OR: [
              { status: { in: ['BUILDING', 'SUBMITTED', 'RETRYING'] } },
              { status: 'PENDING', lastError: { equals: Prisma.DbNull } },
            ],
          },
        });
        return open === 0;
      });
    /**
     * Lo que hace sola la revisión del TTL tras cada emisión o quema (aquí
     * apagada para que no meta transacciones por medio): extiende lo nuevo.
     */
    async function extendTtl() {
      await idle();
      autoTtl = true;
      await runTtl();
      autoTtl = false;
      await idle();
    }

    /** Aprueba una solicitud nueva de `quantity` NFT y espera su emisión. */
    async function mintNow(
      lotId: string,
      quantity: number,
      name: string,
      body: object = {},
      who = 'owner',
      coverKey = COVER_KEY,
    ) {
      const requestId = await requestInReview(
        lotId,
        quantity,
        name,
        who,
        coverKey,
      );
      const res = await approve(requestId, body).expect(201);
      const mintId = res.body.data.mint.id as string;
      await waitMint(mintId, 'CONFIRMED');
      return {
        requestId,
        mintId,
        collectionId: res.body.data.collection.id as string,
      };
    }

    /**
     * Embotellado escrito en la base (lo que deja `POST /v1/lots/{id}/bottling`,
     * que tiene sus propias pruebas): lote `BOTTLED` con su código, un código
     * de botella `ACTIVE` por botella y el evento `lot.bottled`.
     */
    async function bottle(lotId: string, bottles: number, wineryId = WINERY) {
      const lotCode = `CON-${YEAR}-SINGANI-${randomBytes(3).toString('hex').toUpperCase()}`;
      await prisma.lot.update({
        where: { id: lotId },
        data: { stage: 'BOTTLED', lotCode },
      });
      const batch = await prisma.bottlingBatch.create({
        data: {
          wineryId,
          productType: BeverageTypeEnum.SINGANI,
          internationalLotCode: lotCode,
          finalAlcoholAbv: 40,
          totalBottlesPackaged: bottles,
          packagingFormatCl: 75,
          bottlingDate: new Date(),
          lotId,
        },
      });
      await prisma.$executeRaw`
      INSERT INTO bottle_units (id, code, serial, lot_id, bottling_batch_id, status, salt, created_at)
      SELECT gen_random_uuid(),
             upper(substr(md5(${run} || ${lotId} || g::text), 1, 8)),
             g, ${lotId}::uuid, ${batch.id}::uuid,
             'ACTIVE'::"bottle_unit_status_enum", md5(random()::text), now()
      FROM generate_series(1, ${bottles}::int) AS g`;
      await emit(
        'lot.bottled',
        'lot',
        lotId,
        { lotId, wineryId, lotCode, bottles },
        'default',
      );
      return lotCode;
    }

    /** Un código anulado sin sustituto: una botella menos (`lot.bottle_code_voided`). */
    async function voidBottle(lotId: string, serial: number, lotCode: string) {
      await prisma.bottleUnit.updateMany({
        where: { lotId, serial, status: 'ACTIVE' },
        data: {
          status: 'VOIDED',
          voidedAt: new Date(),
          voidReason: 'Botella rota en el almacén',
        },
      });
      const bottles = await prisma.bottleUnit.count({
        where: { lotId, status: 'ACTIVE' },
      });
      await emit(
        'lot.bottle_code_voided',
        'lot',
        lotId,
        { lotId, wineryId: WINERY, lotCode, bottles, serial, replaced: 0 },
        'default',
      );
      return bottles;
    }

    const waitClosure = (
      collectionId: string,
      probe: (closure: {
        status: string;
        shortfall: number;
        bottles: number;
      }) => boolean,
      timeoutMs?: number,
    ) =>
      waitFor(
        `cierre de ${collectionId}`,
        async () => {
          const closure = await prisma.lotClosure.findUnique({
            where: { collectionId },
            include: { items: { orderBy: { bottleNumber: 'desc' } } },
          });
          return closure && probe(closure) ? closure : null;
        },
        timeoutMs,
      );

    /** Cierra el expediente del lote (lo que deja `POST …/dossier/close`). */
    async function closeDossier(lotId: string, lotCode: string, label: string) {
      const hash = createHash('sha256')
        .update(`expediente ${label} ${run}`)
        .digest('hex');
      await prisma.lot.update({
        where: { id: lotId },
        data: { stage: 'CERTIFIED' },
      });
      const closed = {
        status: 'CLOSED',
        hash,
        canonical: `{"lote":"${label}"}`,
        bottleCount: 1,
        closedAt: new Date(),
      };
      await prisma.lotDossier.upsert({
        where: { lotId },
        create: { lotId, ...closed },
        update: closed,
      });
      return { lotId, lotCode, hash };
    }

    const certify = (
      lot: { lotId: string; lotCode: string; hash: string },
      wineryId = WINERY,
    ) =>
      emit('lot.certified', 'lot', lot.lotId, {
        lotId: lot.lotId,
        wineryId,
        lotCode: lot.lotCode,
        hash: lot.hash,
        bottleMerkleRoot: 'b'.repeat(64),
        bottleCount: 1,
        closedAt: new Date().toISOString(),
      });

    /** Lanza una conciliación desde el back office y espera a que termine. */
    async function reconcile(body: object, who = 'operations') {
      await waitFor('ninguna conciliación en curso', async () => {
        const running = await prisma.reconciliationRun.count({
          where: { status: 'RUNNING' },
        });
        return running === 0;
      });
      const started = await call(
        'post',
        '/v1/platform/chain/reconciliation/runs',
        who,
        { body },
      );
      expect(started.status).toBe(202);
      openapi.expectResponse(
        'post',
        '/v1/platform/chain/reconciliation/runs',
        started,
      );
      expect(started.body.data.status).toBe('RUNNING');
      const id = started.body.data.id as string;
      await waitFor(`conciliación ${id} terminada`, async () => {
        const row = await prisma.reconciliationRun.findUnique({
          where: { id },
        });
        return row && row.status !== 'RUNNING' ? row : null;
      });
      const detail = await get(
        `/v1/platform/chain/reconciliation/runs/${id}`,
        who,
      );
      expect(detail.status).toBe(200);
      openapi.expectResponse(
        'get',
        '/v1/platform/chain/reconciliation/runs/{id}',
        detail,
      );
      return detail.body.data as {
        id: string;
        status: string;
        checks: number;
        issuesOpened: number;
        issuesAutoResolved: number;
        alerts: { id: string; code: string; level: string }[];
      };
    }

    const openAlerts = (where: object = {}) =>
      prisma.chainAlert.findMany({
        where: { resolvedAt: null, ...where },
        orderBy: { detectedAt: 'asc' },
      });

    /**
     * Transferencia firmada por la cuenta de la bodega pero **fuera** del
     * sistema: la paga una cuenta cualquiera y ninguna intención la respalda.
     */
    async function foreignTransfer(tokenId: number, to: string) {
      const server = new rpc.Server(LOCAL_CHAIN.rpcUrl, { allowHttp: true });
      const payer = Keypair.random();
      await waitFor('Friendbot para la cuenta ajena', async () => {
        const response = await fetch(
          `${LOCAL_CHAIN.friendbotUrl}?addr=${payer.publicKey()}`,
        ).catch(() => null);
        return response?.ok;
      });
      const account = await waitFor('la cuenta ajena en la red', () =>
        server.getAccount(payer.publicKey()).catch(() => null),
      );
      const builder = () =>
        new TransactionBuilder(
          new Account(payer.publicKey(), account.sequenceNumber()),
          { fee: BASE_FEE, networkPassphrase: LOCAL_CHAIN.passphrase },
        );
      const draft = builder()
        .addOperation(
          new Contract(CONTRACT).call(
            'transfer',
            new Address(ACCOUNT).toScVal(),
            new Address(to).toScVal(),
            nativeToScVal(tokenId, { type: 'u32' }),
          ),
        )
        .setTimeout(120)
        .build();
      const recorded = await server.simulateTransaction(draft);
      if (!rpc.Api.isSimulationSuccess(recorded)) {
        throw new Error('La transferencia ajena no se pudo simular');
      }
      const auth = await Promise.all(
        (recorded.result?.auth ?? []).map((entry) =>
          authorizeEntry(
            entry,
            async (_preimage: unknown, payload: Uint8Array) => ({
              signature: Buffer.from(
                await custody.sign(`winery-${WINERY}`, payload),
              ),
              publicKey: ACCOUNT,
            }),
            recorded.latestLedger + 100,
            LOCAL_CHAIN.passphrase,
          ),
        ),
      );
      const func = (
        draft.operations[0] as unknown as { func: xdr.HostFunction }
      ).func;
      const withAuth = builder()
        .addOperation(Operation.invokeHostFunction({ func, auth }))
        .setTimeout(120)
        .build();
      const strict = await server.simulateTransaction(withAuth);
      const tx = rpc.assembleTransaction(withAuth, strict).build();
      tx.sign(payer);
      const sent = await server.sendTransaction(tx);
      if (sent.status !== 'PENDING' && sent.status !== 'DUPLICATE') {
        throw new Error(`La transferencia ajena no entró: ${sent.status}`);
      }
      await waitFor('la transferencia ajena confirmada', async () => {
        const result = await server.getTransaction(sent.hash);
        if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
          throw new Error('La transferencia ajena falló en la red');
        }
        return result.status === rpc.Api.GetTransactionStatus.SUCCESS;
      });
      return sent.hash;
    }

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
        QUEUE_PREFIX: `conciliacion-e2e-${run}`,
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
        CHAIN_ENVIRONMENT: `con-${run}`.slice(0, 30),
        API_PUBLIC_URL: 'https://api.e2e.test',
        OUTBOX_RELAY_INTERVAL_MS: '200',
        WORKER_HEARTBEAT_FILE: join(
          tmpdir(),
          `doc-conciliacion-e2e-${run}.heartbeat`,
        ),
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
      const indexerModule =
        await import('../src/modules/chain/jobs/indexer/chain-indexer.service');
      const reconcilerModule =
        await import('../src/modules/chain/jobs/reconcile/chain-reconciler.service');
      const ttlModule =
        await import('../src/modules/chain/jobs/ttl/chain-ttl.service');
      const signerModule =
        await import('../src/modules/chain/jobs/signer/chain-signer.service');
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
      // Las tareas programadas siguen registradas, pero la conciliación y la
      // revisión del TTL solo corren cuando la prueba las pide
      indexer = worker.get(indexerModule.ChainIndexer);
      reconciler = worker.get(reconcilerModule.ChainReconciler);
      ttl = worker.get(ttlModule.ChainTtlService);
      signer = worker.get(signerModule.ChainSigner);
      runTtl = ttl.run.bind(ttl);
      jest.spyOn(ttl, 'run').mockImplementation((now?: Date) =>
        autoTtl
          ? runTtl(now)
          : Promise.resolve({
              codeDays: null,
              contracts: 0,
              requested: [],
              errors: 0,
            }),
      );
      jest.spyOn(reconciler, 'runNow').mockResolvedValue(null);
      await worker.init();
      await worker.get(ChainBootstrap).ready();
      const { PlatformAccountsSync } =
        await import('../src/modules/chain/jobs/platform-accounts.sync');
      accountsSync = worker.get(PlatformAccountsSync);
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
          email: `${who}-conciliacion-${run}@drinksonchain.test`,
          password: 'Plataforma-conciliacion-123',
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

      const main = await provisionWinery(
        'Destilería de la Conciliación',
        'CON',
      );
      WINERY = main.wineryId;
      ACCOUNT = main.account;
      CONTRACT_ID = main.contractId;
      CONTRACT = main.contract;
      await wineryToken('owner', WINERY, 'OWNER');
      await wineryToken('enologist', WINERY, 'ENOLOGIST');
      await wineryToken('accountant', WINERY, 'ACCOUNTANT');
      COVER_KEY = await uploadTraceFile(app, tokens.owner, {
        folder: 'labels',
        file: Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          Buffer.from(`portada de la conciliación ${run}`),
        ]),
        name: 'portada.png',
        ip: nextIp(),
      });
      LOT = (await newLot(`Singani Preventa ${run}`, 3000)).id;
      // Con las cuentas ya fondeadas, la alerta de saldo del arranque se cierra sola
      await idle();
      await accountsSync.checkBalances();
    }, 300_000);

    afterEach(() => {
      gateway.down = false;
      gateway.loseNextSendResponse = false;
      gateway.staleSequenceOnce = false;
      gateway.hideLookupsUntilEventsAreRead = false;
      gateway.beforeSend = null;
      gateway.archivedOnce = null;
      chainSettings.mintEnabled = true;
      chainSettings.ttlExtendBelowDays = 30;
      autoTtl = false;
    });

    afterAll(async () => {
      if (prisma) {
        const costs = await prisma.chainTransaction
          .groupBy({
            by: ['kind'],
            where: { status: 'CONFIRMED', feeChargedStroops: { not: null } },
            _sum: { feeChargedStroops: true },
            _max: { feeChargedStroops: true },
            _count: { _all: true },
          })
          .catch(() => []);
        process.stdout.write(
          `\n[conciliacion-o3] comisiones por tipo (stroops): ${JSON.stringify(
            costs.map((c) => ({
              kind: c.kind,
              n: c._count._all,
              total: String(c._sum.feeChargedStroops),
              max: String(c._max.feeChargedStroops),
            })),
          )}\n[conciliacion-o3] comisiones (stroops): ${JSON.stringify(fees)}\n[conciliacion-o3] tiempos (ms): ${JSON.stringify(timings)}\n`,
        );
      }
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
    }, 120_000);

    // ─────────────────────────────────────────────────────────────────────────
    describe('recorrido limpio: indexador, TTL, cierre sin faltante y conciliación FULL en OK (§14)', () => {
      let LOT_CODE = '';

      it('100 NFT, publicar y ampliación a 150: el indexador guarda los eventos y los enlaza con su transacción', async () => {
        const first = await mintNow(LOT, 100, `Singani Preventa ${run}`);
        COLLECTION = first.collectionId;
        await post(
          `/v1/platform/collections/${COLLECTION}/publish`,
          'operations',
          REASON,
        ).expect(200);
        const second = await mintNow(LOT, 50, 'Ampliación');
        expect(await totalMinted()).toBe(150);

        const result = await indexer.poll();
        expect(['INDEXED', 'IDLE']).toContain(result.status);
        expect(result.unexpected).toBe(0);
        const events = await prisma.chainEvent.findMany({
          where: { contractAddress: CONTRACT },
          orderBy: { rpcEventId: 'asc' },
        });
        // Despliegue (role_granted ×2) y dos emisiones (consecutive_mint + lot_minted)
        expect(events.map((e) => e.type)).toEqual([
          'role_granted',
          'role_granted',
          'consecutive_mint',
          'lot_minted',
          'consecutive_mint',
          'lot_minted',
        ]);
        expect(events.every((e) => e.originatedBySystem)).toBe(true);
        expect(events.every((e) => e.wineryId === WINERY)).toBe(true);
        const [mintTx1] = await mintTxs(first.mintId);
        const [mintTx2] = await mintTxs(second.mintId);
        const deploy = await prisma.chainTransaction.findFirstOrThrow({
          where: { kind: 'DEPLOY_WINERY_CONTRACT', wineryId: WINERY },
        });
        expect(events.map((e) => e.matchedTransactionId)).toEqual([
          deploy.id,
          deploy.id,
          mintTx1.id,
          mintTx1.id,
          mintTx2.id,
          mintTx2.id,
        ]);
        expect(events[3]).toMatchObject({
          txHash: mintTx1.txHash,
          ledger: mintTx1.ledger,
          topics: [expect.stringMatching(/^CON-L/), ACCOUNT],
          data: { first_token_id: 0, last_token_id: 99, minter: ACCOUNT },
        });
        expect(events[5].data).toMatchObject({
          first_token_id: 100,
          last_token_id: 149,
        });
        // Ninguna alerta: todo lo originó el sistema y los rangos cuadran
        expect(await openAlerts()).toEqual([]);
        // Lo que la red dice de cada NFT
        expect(
          await prisma.token.count({
            where: {
              collectionId: COLLECTION,
              onchainOwner: ACCOUNT,
              onchainBurned: false,
              onchainCheckedAt: { not: null },
            },
          }),
        ).toBe(150);

        // Repetir la pasada no duplica nada (único por rpcEventId)
        const again = await indexer.poll();
        expect(again.events).toBe(0);
        expect(
          await prisma.chainEvent.count({
            where: { contractAddress: CONTRACT },
          }),
        ).toBe(6);
        const cursor = await prisma.chainCursor.findUniqueOrThrow({
          where: { network_name: { network: 'LOCAL', name: 'events' } },
        });
        expect(cursor.lastLedger).toBeGreaterThanOrEqual(
          mintTx2.ledger as number,
        );
        expect(cursor.cursor).toBe(events[5].rpcEventId);
      });

      it('GET /v1/platform/chain/events: filtros por contrato, tipo, transacción y no originados', async () => {
        const path = '/v1/platform/chain/events';
        const all = await get(`${path}?contract=${CONTRACT}`, 'support');
        expect(all.status).toBe(200);
        openapi.expectResponse('get', path, all);
        expect(all.body.data.total).toBe(6);
        // Los más recientes primero
        expect(all.body.data.items[0]).toMatchObject({
          type: 'lot_minted',
          network: 'LOCAL',
          contractAddress: CONTRACT,
          wineryId: WINERY,
          originatedBySystem: true,
        });
        const minted = await get(
          `${path}?contract=${CONTRACT}&type=lot_minted`,
          'operations',
        );
        expect(minted.body.data.total).toBe(2);
        const txHash = minted.body.data.items[1].txHash as string;
        const byTx = await get(`${path}?txHash=${txHash}`, 'admin');
        expect(
          byTx.body.data.items.map((e: { type: string }) => e.type).sort(),
        ).toEqual(['consecutive_mint', 'lot_minted']);
        const unmatched = await get(`${path}?unmatched=true`, 'admin');
        expect(unmatched.body.data.total).toBe(0);
        const future = await get(
          `${path}?from=${new Date(Date.now() + 3_600_000).toISOString()}`,
          'admin',
        );
        expect(future.body.data.total).toBe(0);
        // Filtros mal formados → 422; la bodega no entra; sin sesión, 401
        expect((await get(`${path}?contract=G123`, 'admin')).status).toBe(422);
        expect((await get(`${path}?unmatched=quizas`, 'admin')).status).toBe(
          422,
        );
        expect((await get(path, 'owner')).status).toBe(403);
        expect((await get(path, null)).status).toBe(401);
      });

      it('chain.ttl.extend: las entradas nuevas de la emisión se extienden a 120 días (EXTEND_TTL)', async () => {
        const before = await ttl.readContract(CONTRACT_ID);
        expect(before.entries.map((e) => e.name)).toEqual([
          'instance',
          'Owner(99)',
          'Owner(149)',
          'OwnershipBucket(0)',
          'Balance(bodega)',
        ]);
        // Todas existen en la red (corrección de §8.3: último id de cada emisión)
        expect(before.entries.every((e) => e.liveUntilLedger !== null)).toBe(
          true,
        );
        const young = before.entries.filter(
          (e) => (e.daysLeft as number) < chainSettings.ttlExtendBelowDays,
        );
        process.stdout.write(
          `\n[conciliacion-o3] TTL tras emitir (días de 17 280 ledgers): ${JSON.stringify(
            before.entries.map((e) => [e.name, Number(e.daysLeft?.toFixed(2))]),
          )}\n`,
        );
        expect(young.map((e) => e.name)).toEqual(
          expect.arrayContaining(['Owner(99)', 'Owner(149)']),
        );

        autoTtl = true;
        const result = await ttl.run();
        expect(result.errors).toBe(0);
        expect(result.contracts).toBeGreaterThanOrEqual(1);
        const day = new Date().toISOString().slice(0, 10);
        const key = `ttl:${CONTRACT_ID}:${day}`;
        expect(result.requested).toContain(key);
        const tx = await waitTx({ intentKey: key }, ['CONFIRMED', 'FAILED']);
        expect(tx).toMatchObject({
          status: 'CONFIRMED',
          kind: 'EXTEND_TTL',
          subjectType: 'CONTRACT',
          subjectId: CONTRACT_ID,
          wineryId: WINERY,
          sourceAccount: operationsAddress,
        });
        // Paga operaciones y solo firma operaciones
        expect(tx.signers).toEqual([
          { role: 'OPERATIONS', address: operationsAddress, wineryId: null },
        ]);
        fees.extendTtlContrato = String(tx.feeChargedStroops);
        const after = await ttl.readContract(CONTRACT_ID);
        for (const entry of after.entries) {
          // Lo que bajaba del umbral queda a 120 días; el resto, como estaba
          const wasYoung = young.some((e) => e.name === entry.name);
          expect([
            entry.name,
            (entry.daysLeft as number) > (wasYoung ? 119 : 29),
          ]).toEqual([entry.name, true]);
        }
        // Las entradas que nacen justo en el umbral (30 días) lo cruzan unos
        // ledgers después: una segunda pasada las recoge. Después, repetirla
        // ya no registra nada
        const second = await ttl.run();
        expect(second.requested.length).toBeLessThanOrEqual(1);
        await idle();
        const again = await ttl.run();
        expect(again.requested).toEqual([]);
        const extensions = await prisma.chainTransaction.findMany({
          where: { kind: 'EXTEND_TTL', subjectId: CONTRACT_ID },
        });
        expect(extensions.length).toBe(1 + second.requested.length);
        expect(extensions.every((e) => e.status === 'CONFIRMED')).toBe(true);
      });

      it('el código se extiende aparte, con su propia transacción, y codeTtlDays deja de ser null', async () => {
        const accounts = await get('/v1/platform/chain/accounts', 'support');
        expect(accounts.status).toBe(200);
        openapi.expectResponse('get', '/v1/platform/chain/accounts', accounts);
        // La pasada anterior ya leyó la vida del código (≈ 120 días tras el despliegue)
        expect(accounts.body.data.codeTtlDays).toBeGreaterThanOrEqual(119);
        expect(accounts.body.data.codeTtlDays).toBeLessThanOrEqual(120);

        // Con el umbral por encima de lo que le queda, el código necesita su extensión
        chainSettings.ttlExtendBelowDays = 120;
        autoTtl = true;
        const result = await ttl.run();
        const codeKey = result.requested.find((k) => k.startsWith('ttl:code:'));
        expect(codeKey).toBeDefined();
        const tx = await waitTx({ intentKey: codeKey }, [
          'CONFIRMED',
          'FAILED',
        ]);
        expect(tx).toMatchObject({
          status: 'CONFIRMED',
          kind: 'EXTEND_TTL',
          subjectType: 'PLATFORM',
          subjectId: 'CODE',
          wineryId: null,
        });
        // Tope de comisión propio del código (no el general)
        expect(String(tx.maxFeeStroops)).not.toBe('');
        fees.extendTtlCodigo = String(tx.feeChargedStroops);
        await idle();
        const code = await ttl.readCode();
        expect(code?.entries[0].daysLeft as number).toBeGreaterThan(119.9);
      });

      it('embotellado de 2.950 botellas: cierre NO_SHORTFALL, sin correos ni alertas', async () => {
        expect(
          (await get(`/v1/platform/collections/${COLLECTION}/closure`, 'admin'))
            .body.error,
        ).toMatchObject({ code: 'TOK_CLOSURE_NOT_APPLICABLE' });
        LOT_CODE = await bottle(LOT, 2950);
        const closure = await waitClosure(COLLECTION, () => true);
        expect(closure).toMatchObject({
          status: 'NO_SHORTFALL',
          bottles: 2950,
          minted: 150,
          unsold: 150,
          sold: 0,
          shortfall: 0,
          unsoldToBurn: 0,
          soldWithoutBottle: 0,
          unsoldPolicy: null,
        });
        expect(closure.items).toEqual([]);
        const view = await get(
          `/v1/platform/collections/${COLLECTION}/closure`,
          'support',
        );
        expect(view.status).toBe(200);
        openapi.expectResponse(
          'get',
          '/v1/platform/collections/{id}/closure',
          view,
        );
        expect(view.body.data).toMatchObject({
          status: 'NO_SHORTFALL',
          decision: null,
          items: [],
        });
        expect(
          await prisma.emailMessage.count({
            where: { template: { startsWith: 'faltante' } },
          }),
        ).toBe(0);
      });

      it('operaciones puede conservar a la venta sin faltante; el cierre sigue NO_SHORTFALL', async () => {
        const path = `/v1/platform/collections/${COLLECTION}/closure/decide`;
        const body = { unsoldPolicy: 'KEEP_ON_SALE', ...REASON };
        // Idempotency-Key obligatoria; soporte no decide
        expect((await call('post', path, 'operations', { body })).status).toBe(
          422,
        );
        expect((await post(path, 'support', body)).status).toBe(403);
        // Quemar los no vendidos es una decisión con quemas: solo administración
        const burn = await post(path, 'operations', {
          unsoldPolicy: 'BURN',
          ...REASON,
        });
        expect([burn.status, burn.body.error?.code]).toEqual([
          403,
          'AUTH_INSUFFICIENT_PERMISSIONS',
        ]);
        const decided = await post(path, 'operations', body);
        expect(decided.status).toBe(200);
        openapi.expectResponse(
          'post',
          '/v1/platform/collections/{id}/closure/decide',
          decided,
        );
        expect(decided.body.data).toMatchObject({
          status: 'NO_SHORTFALL',
          unsoldPolicy: 'KEEP_ON_SALE',
          decision: { reason: REASON.reason },
          items: [],
        });
        expect(
          await prisma.chainTransaction.count({
            where: { kind: 'BURN_UNSOLD' },
          }),
        ).toBe(0);
        const audit = await prisma.auditEvent.findFirstOrThrow({
          where: { action: 'LOT_CLOSURE_DECIDED' },
          orderBy: { seq: 'desc' },
        });
        expect(audit).toMatchObject({
          organizationId: WINERY,
          reason: REASON.reason,
        });
      });

      it('expediente anclado y conciliación FULL de todo → OK, sin alertas', async () => {
        const lot = await closeDossier(LOT, LOT_CODE, 'recorrido limpio');
        await certify(lot);
        await waitFor('anclaje confirmado', async () => {
          const anchor = await prisma.dossierAnchor.findUnique({
            where: { lotId: LOT },
          });
          return anchor?.status === 'ANCHORED';
        });
        await idle();
        const started = Date.now();
        const done = await reconcile({ scope: 'ALL', depth: 'FULL' });
        timings.conciliacionFull = Date.now() - started;
        expect(done).toMatchObject({
          status: 'OK',
          issuesOpened: 0,
          alerts: [],
        });
        // Contrato: existe, total, saldo, dueños, quemas, pausa, roles, TTL;
        // colección: cuota y botellas; anclaje; saldos de la plataforma; código
        expect(done.checks).toBeGreaterThanOrEqual(13);
        expect(await openAlerts()).toEqual([]);
        const row = await prisma.reconciliationRun.findUniqueOrThrow({
          where: { id: done.id },
        });
        expect(row).toMatchObject({
          scope: 'ALL',
          depth: 'FULL',
          trigger: 'MANUAL',
          subjectId: null,
        });
        expect(row.finishedAt).not.toBeNull();
        const audit = await prisma.auditEvent.findFirstOrThrow({
          where: { action: 'RECONCILIATION_RUN_STARTED' },
          orderBy: { seq: 'desc' },
        });
        expect(audit.after).toMatchObject({ scope: 'ALL', depth: 'FULL' });

        const list = await get(
          '/v1/platform/chain/reconciliation/runs?status=OK',
          'support',
        );
        expect(list.status).toBe(200);
        openapi.expectResponse(
          'get',
          '/v1/platform/chain/reconciliation/runs',
          list,
        );
        expect(list.body.data.items[0].id).toBe(done.id);
      });

      it('la cuenta de la bodega, las métricas y el tablero dan datos reales', async () => {
        const account = await get(
          '/v1/organizations/current/chain-account',
          'enologist',
        );
        expect(account.status).toBe(200);
        openapi.expectResponse(
          'get',
          '/v1/organizations/current/chain-account',
          account,
        );
        expect(account.body.data.totals).toEqual({
          minted: 150,
          available: 150,
          reserved: 0,
          sold: 0,
          redeemable: 0,
          passActive: 0,
          redeemed: 0,
          burned: 0,
          expired: 0,
        });
        expect(account.body.data.byLot).toHaveLength(1);
        expect(account.body.data.byLot[0]).toMatchObject({
          lotId: LOT,
          lotCode: LOT_CODE,
          stage: 'ANCHORED',
          collectionId: COLLECTION,
          collectionStatus: 'PUBLISHED',
          quota: 150,
          counts: { minted: 150, available: 150, burned: 0 },
          anchor: { status: 'ANCHORED', account: anchorAddress },
        });
        // Lo pagado por la plataforma por esta bodega: identidad, emisiones, TTL y anclaje
        const paid = await prisma.chainTransaction.aggregate({
          where: { wineryId: WINERY },
          _sum: { feeChargedStroops: true },
        });
        const stroops = paid._sum.feeChargedStroops as bigint;
        expect(stroops > 0n).toBe(true);
        expect(account.body.data.chainCosts.feesChargedXlm).toBe(
          `${stroops / 10_000_000n}.${String(stroops % 10_000_000n).padStart(7, '0')}`,
        );
        expect(account.body.data.chainCosts.since).not.toBeNull();
        const platform = await get(
          `/v1/platform/wineries/${WINERY}/chain-account`,
          'support',
        );
        expect(platform.body.data.totals).toEqual(account.body.data.totals);

        const metrics = await get(
          `/v1/platform/collections/${COLLECTION}/metrics`,
          'support',
        );
        expect(metrics.status).toBe(200);
        openapi.expectResponse(
          'get',
          '/v1/platform/collections/{id}/metrics',
          metrics,
        );
        expect(metrics.body.data).toMatchObject({
          quota: 150,
          authorizedVsEstimatePercent: 5,
          counts: { minted: 150, available: 150 },
          chainCosts: { transactions: 2 },
          byMint: [
            { sequence: 1, quantity: 100 },
            { sequence: 2, quantity: 50 },
          ],
        });
        expect(
          Number(metrics.body.data.chainCosts.feesChargedXlm),
        ).toBeGreaterThan(0);

        const dashboard = await get('/v1/platform/dashboard', 'admin');
        expect(dashboard.status).toBe(200);
        openapi.expectResponse('get', '/v1/platform/dashboard', dashboard);
        expect(dashboard.body.data.chain).toMatchObject({
          network: 'LOCAL',
          failedTransactions: 0,
          stuckTransactions: 0,
          openAlerts: { critical: 0, warning: 0 },
          lastReconciliation: { status: 'OK' },
        });
        expect(dashboard.body.data.chain.indexerLagSeconds).toBeLessThan(300);
        expect(
          Number(dashboard.body.data.chain.operationsBalanceXlm),
        ).toBeGreaterThan(1000);
        expect(dashboard.body.data.tokenization).toMatchObject({
          collectionsPublished: 1,
          shortfallsOpen: 0,
          mintFailures: 0,
        });
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    describe('diferencia provocada en la base: TOTAL_MINTED_MISMATCH (§8.2, S-19)', () => {
      let ALERT = '';
      let MINT_2 = '';
      const original = [
        {
          firstTokenId: 100,
          lastTokenId: 149,
          firstBottleNumber: 101,
          lastBottleNumber: 150,
        },
      ];

      it('la conciliación abre la alerta CRITICAL, avisa a operaciones y no corrige nada', async () => {
        const mint = await prisma.mint.findFirstOrThrow({
          where: { collectionId: COLLECTION, sequence: 2 },
        });
        MINT_2 = mint.id;
        expect(mint.ranges).toEqual(original);
        // La base "pierde" un NFT de la segunda emisión: 149 confirmados frente a 150 en la red
        const tampered = [{ ...original[0], lastTokenId: 148 }];
        await prisma.mint.update({
          where: { id: MINT_2 },
          data: { ranges: tampered },
        });
        const done = await reconcile({
          scope: 'CONTRACT',
          subjectId: CONTRACT_ID,
          depth: 'LIGHT',
        });
        expect(done).toMatchObject({ status: 'DIFFERENCES', issuesOpened: 1 });
        expect(done.alerts).toHaveLength(1);
        expect(done.alerts[0]).toMatchObject({
          code: 'TOTAL_MINTED_MISMATCH',
          level: 'CRITICAL',
          subject: { type: 'CONTRACT', id: CONTRACT_ID },
          wineryId: WINERY,
          expected: { confirmedInDatabase: 149 },
          actual: { totalMinted: 150 },
          runId: done.id,
          resolvedAt: null,
          resolution: null,
        });
        ALERT = done.alerts[0].id;
        // Nunca se corrige sola: ni la base desde la red ni al revés
        expect(
          (await prisma.mint.findUniqueOrThrow({ where: { id: MINT_2 } }))
            .ranges,
        ).toEqual(tampered);
        expect(await totalMinted()).toBe(150);
        expect(
          await prisma.token.count({ where: { collectionId: COLLECTION } }),
        ).toBe(150);

        // Correo a administración y operaciones (no a soporte), uno por persona
        const mails = await waitFor('correos de la alerta', async () => {
          const rows = (
            await prisma.emailMessage.findMany({
              where: { template: 'alerta-cadena' },
            })
          ).filter((m) =>
            JSON.stringify([m.variables, m.subject]).includes(
              'TOTAL_MINTED_MISMATCH',
            ),
          );
          return rows.length >= 2 ? rows : null;
        });
        expect(mails.map((m) => m.toAddress).sort()).toEqual([
          `admin-conciliacion-${run}@drinksonchain.test`,
          `operations-conciliacion-${run}@drinksonchain.test`,
        ]);
        expect(
          JSON.stringify([mails[0].variables, mails[0].subject]),
        ).toContain('TOTAL_MINTED_MISMATCH');
      });

      it('la alerta está en la bandeja y en el tablero; repetir la conciliación no la duplica', async () => {
        const path = '/v1/platform/chain/alerts';
        const open = await get(path, 'support');
        expect(open.status).toBe(200);
        openapi.expectResponse('get', path, open);
        expect(open.body.data.items).toHaveLength(1);
        expect(open.body.data.items[0]).toMatchObject({
          id: ALERT,
          code: 'TOTAL_MINTED_MISMATCH',
        });
        for (const [query, total] of [
          ['status=open&level=CRITICAL', 1],
          ['code=TOTAL_MINTED_MISMATCH', 1],
          [`wineryId=${WINERY}`, 1],
          ['level=WARNING', 0],
          ['status=resolved&code=TOTAL_MINTED_MISMATCH', 0],
          [`wineryId=${randomUUID()}`, 0],
        ] as const) {
          const res = await get(`${path}?${query}`, 'operations');
          expect([query, res.body.data.total]).toEqual([query, total]);
        }
        expect((await get(`${path}?status=todas`, 'admin')).status).toBe(422);
        expect((await get(path, 'owner')).status).toBe(403);

        const dashboard = await get('/v1/platform/dashboard', 'admin');
        expect(dashboard.body.data.chain.openAlerts).toEqual({
          critical: 1,
          warning: 0,
        });

        const again = await reconcile({
          scope: 'CONTRACT',
          subjectId: CONTRACT_ID,
          depth: 'LIGHT',
        });
        // La diferencia sigue, pero la alerta ya estaba abierta
        expect(again).toMatchObject({ status: 'DIFFERENCES', issuesOpened: 0 });
        expect(
          await openAlerts({ code: 'TOTAL_MINTED_MISMATCH' }),
        ).toHaveLength(1);
        expect(
          (await get('/v1/platform/dashboard', 'admin')).body.data.chain
            .lastReconciliation.status,
        ).toBe('DIFFERENCES');
      });

      it('lanzarla: permisos, alcance y una sola en curso por alcance', async () => {
        const path = '/v1/platform/chain/reconciliation/runs';
        const body = { scope: 'ALL', depth: 'LIGHT' };
        expect((await call('post', path, 'support', { body })).status).toBe(
          403,
        );
        expect((await call('post', path, 'owner', { body })).status).toBe(403);
        expect((await call('post', path, null, { body })).status).toBe(401);
        for (const invalid of [
          {},
          { scope: 'TODO' },
          { scope: 'ALL', depth: 'MEDIA' },
          { scope: 'CONTRACT' },
          { scope: 'CONTRACT', subjectId: randomUUID() },
          { scope: 'COLLECTION', subjectId: 'no-es-un-id' },
        ]) {
          const res = await call('post', path, 'operations', { body: invalid });
          expect([JSON.stringify(invalid), res.status]).toEqual([
            JSON.stringify(invalid),
            422,
          ]);
        }
        // Una ejecución en curso para ese alcance → 409 con su id
        const running = await prisma.reconciliationRun.create({
          data: {
            scope: 'ALL',
            trigger: 'SCHEDULED',
            depth: 'LIGHT',
            status: 'RUNNING',
          },
        });
        const conflict = await call('post', path, 'admin', { body });
        expect([conflict.status, conflict.body.error?.code]).toEqual([
          409,
          'CHN_RECONCILIATION_RUNNING',
        ]);
        expect(conflict.body.error.details[0].meta).toEqual({
          runId: running.id,
        });
        // Otro alcance no choca
        await prisma.reconciliationRun.update({
          where: { id: running.id },
          data: { status: 'OK', finishedAt: new Date() },
        });
        expect(
          (await get(`${path}/${randomUUID()}`, 'admin')).body.error,
        ).toMatchObject({ code: 'NOT_FOUND' });
      });

      it('al desaparecer la diferencia la alerta se cierra sola (resolution.auto) y ya no se resuelve a mano', async () => {
        await prisma.mint.update({
          where: { id: MINT_2 },
          data: { ranges: original },
        });
        const done = await reconcile({
          scope: 'CONTRACT',
          subjectId: CONTRACT_ID,
          depth: 'FULL',
        });
        expect(done).toMatchObject({
          status: 'OK',
          issuesOpened: 0,
          issuesAutoResolved: 1,
        });
        const alert = await prisma.chainAlert.findUniqueOrThrow({
          where: { id: ALERT },
        });
        expect(alert).toMatchObject({
          resolvedAuto: true,
          resolvedBy: 'Sistema',
        });
        const resolved = await get(
          '/v1/platform/chain/alerts?status=resolved',
          'support',
        );
        expect(resolved.body.data.items[0]).toMatchObject({
          id: ALERT,
          resolution: { auto: true, by: 'Sistema' },
        });
        const manual = await call(
          'post',
          `/v1/platform/chain/alerts/${ALERT}/resolve`,
          'operations',
          { body: { note: 'Revisado' } },
        );
        expect([manual.status, manual.body.error?.code]).toEqual([
          409,
          'CHN_ALERT_ALREADY_RESOLVED',
        ]);
        expect(await openAlerts()).toEqual([]);
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    describe('cierre del lote con faltante: autorizar 100, embotellar 80 (§8.4, §14)', () => {
      let LOT_B = '';
      let COLLECTION_B = '';
      let LOT_CODE_B = '';
      let FIRST_ID = 0;
      const closurePath = () =>
        `/v1/platform/collections/${COLLECTION_B}/closure`;

      it('SET_TOKEN_URI_BASE: al cambiar el slug de la bodega, la siguiente emisión corrige la URI base en la red', async () => {
        const before = await prisma.nftContract.findUniqueOrThrow({
          where: { id: CONTRACT_ID },
        });
        expect(before.baseUri).toBe(
          `https://api.e2e.test/v1/public/nft/con-${run}/`,
        );
        expect(
          await readContract(CONTRACT, 'token_uri', [
            nativeToScVal(0, { type: 'u32' }),
          ]),
        ).toBe(`${before.baseUri}0`);
        const slug = `conciliacion-${run}`;
        await prisma.winery.update({ where: { id: WINERY }, data: { slug } });
        const expected = `https://api.e2e.test/v1/public/nft/${slug}/`;

        LOT_B = (await newLot(`Singani con faltante ${run}`, 500)).id;
        FIRST_ID = await totalMinted();
        const signaturesBefore = custody.signatures.length;
        const minted = await mintNow(LOT_B, 100, `Singani con faltante ${run}`);
        COLLECTION_B = minted.collectionId;

        const uri = await waitTx(
          {
            subjectId: CONTRACT_ID,
            intentKey: { startsWith: 'uri:' },
          },
          ['CONFIRMED', 'FAILED'],
        );
        expect(uri).toMatchObject({
          kind: 'SET_TOKEN_URI_BASE',
          status: 'CONFIRMED',
          wineryId: WINERY,
          sourceAccount: operationsAddress,
        });
        // La autoriza la bodega (admin del contrato); paga operaciones
        expect(uri.signers).toEqual([
          { role: 'OPERATIONS', address: operationsAddress, wineryId: null },
          { role: 'WINERY', address: ACCOUNT, wineryId: WINERY },
        ]);
        expect(custody.signatures.slice(signaturesBefore)).toEqual(
          expect.arrayContaining([`winery-${WINERY}`, 'platform-operations']),
        );
        expect(
          (uri.result as { contractEvents: string[] }).contractEvents,
        ).toEqual(['base_uri_updated']);
        fees.setTokenUriBase = String(uri.feeChargedStroops);
        // La red y la base, con la URI nueva (también para los NFT ya emitidos)
        expect(
          await readContract(CONTRACT, 'token_uri', [
            nativeToScVal(0, { type: 'u32' }),
          ]),
        ).toBe(`${expected}0`);
        expect(
          (
            await prisma.nftContract.findUniqueOrThrow({
              where: { id: CONTRACT_ID },
            })
          ).baseUri,
        ).toBe(expected);
        // Una sola por URI: otra emisión no la repite
        await indexer.poll();
        const event = await prisma.chainEvent.findFirstOrThrow({
          where: { type: 'base_uri_updated' },
        });
        expect(event).toMatchObject({
          matchedTransactionId: uri.id,
          originatedBySystem: true,
          data: { base_uri: expected },
        });
        const metadata = await get(`/v1/public/nft/${slug}/0`, null);
        expect(metadata.status).toBe(200);
      });

      it('lot.bottled con 80 botellas: SHORTFALL_OPEN con los 20 números más altos, correo, línea de tiempo y bitácora', async () => {
        await idle();
        LOT_CODE_B = await bottle(LOT_B, 80);
        const closure = await waitClosure(COLLECTION_B, () => true);
        expect(closure).toMatchObject({
          status: 'SHORTFALL_OPEN',
          bottles: 80,
          minted: 100,
          unsold: 100,
          sold: 0,
          reserved: 0,
          shortfall: 20,
          unsoldToBurn: 20,
          soldWithoutBottle: 0,
          unsoldPolicy: null,
          decisionAt: null,
        });
        // S-23: primero los no vendidos, del número de botella más alto al más bajo
        expect(closure.items.map((i) => i.bottleNumber)).toEqual(
          Array.from({ length: 20 }, (_, i) => 100 - i),
        );
        expect(closure.items.every((i) => i.outcome === 'PENDING')).toBe(true);
        expect(closure.items[0].tokenId).toBe(FIRST_ID + 99);

        const view = await get(closurePath(), 'support');
        expect(view.status).toBe(200);
        openapi.expectResponse(
          'get',
          '/v1/platform/collections/{id}/closure',
          view,
        );
        expect(view.body.data.items).toHaveLength(20);
        expect(view.body.data.items[0]).toMatchObject({
          bottleNumber: 100,
          status: 'MINTED',
          outcome: 'PENDING',
          burnTx: null,
          resolvedAt: null,
        });

        // Correo al dueño y a operaciones; nada a la enóloga
        const mails = await waitFor('correos del faltante', async () => {
          const rows = await prisma.emailMessage.findMany({
            where: { template: { startsWith: 'faltante' } },
            orderBy: { createdAt: 'asc' },
          });
          return rows.length >= 3 ? rows : null;
        });
        expect(mails.map((m) => [m.template, m.toAddress]).sort()).toEqual(
          [
            ['faltante-detectado', `owner-conciliacion-${run}@e2e.test`],
            [
              'faltante-operaciones',
              `admin-conciliacion-${run}@drinksonchain.test`,
            ],
            [
              'faltante-operaciones',
              `operations-conciliacion-${run}@drinksonchain.test`,
            ],
          ].sort(),
        );
        // Línea de tiempo (interno) y bitácora (sistema)
        const event = await prisma.lotEvent.findFirstOrThrow({
          where: { lotId: LOT_B, type: 'SHORTFALL_DETECTED' },
        });
        expect(event.visibility).toBe('INTERNAL');
        expect(event.summary).toContain('Faltante de 20 botellas');
        const audit = await prisma.auditEvent.findFirstOrThrow({
          where: { action: 'LOT_SHORTFALL_DETECTED' },
        });
        expect(audit).toMatchObject({
          organizationId: WINERY,
          actorUserId: null,
        });
        expect(audit.after).toMatchObject({ shortfall: 20, bottles: 80 });
        const outbox = await prisma.outboxEvent.findFirstOrThrow({
          where: {
            eventType: 'lot.shortfall_detected',
            aggregateId: COLLECTION_B,
          },
        });
        expect(outbox.payload).toMatchObject({
          shortfall: 20,
          unsoldToBurn: 20,
        });

        // El evento reprocesado no cambia nada ni vuelve a avisar
        await emit(
          'lot.bottled',
          'lot',
          LOT_B,
          { lotId: LOT_B, wineryId: WINERY, lotCode: LOT_CODE_B, bottles: 80 },
          'default',
        );
        await sleep(1500);
        expect(
          await prisma.lotClosureItem.count({
            where: { closureId: closure.id },
          }),
        ).toBe(20);
        expect(
          await prisma.emailMessage.count({
            where: { template: 'faltante-detectado' },
          }),
        ).toBe(1);

        const dashboard = await get('/v1/platform/dashboard', 'admin');
        expect(dashboard.body.data.tokenization.shortfallsOpen).toBe(1);
      });

      it('la lista de cierres y la lectura de la bodega (dueña y contadora; sin datos de pedidos)', async () => {
        const list = await get(
          '/v1/platform/lot-closures?status=SHORTFALL_OPEN',
          'support',
        );
        expect(list.status).toBe(200);
        openapi.expectResponse('get', '/v1/platform/lot-closures', list);
        expect(list.body.data.total).toBe(1);
        expect(list.body.data.items[0]).toMatchObject({
          collectionId: COLLECTION_B,
          shortfall: 20,
        });
        expect(list.body.data.items[0].items).toBeUndefined();
        expect(
          (await get(`/v1/platform/lot-closures?wineryId=${WINERY}`, 'admin'))
            .body.data.total,
        ).toBe(2);
        expect(
          (
            await get(
              `/v1/platform/lot-closures?wineryId=${randomUUID()}`,
              'admin',
            )
          ).body.data.total,
        ).toBe(0);
        expect(
          (await get('/v1/platform/lot-closures?status=OTRO', 'admin')).status,
        ).toBe(422);
        expect((await get('/v1/platform/lot-closures', 'owner')).status).toBe(
          403,
        );

        const path = `/v1/collections/${COLLECTION_B}/closure`;
        for (const who of ['owner', 'accountant']) {
          const res = await get(path, who);
          expect([who, res.status]).toEqual([who, 200]);
          openapi.expectResponse('get', '/v1/collections/{id}/closure', res);
          expect(res.body.data).toMatchObject({
            status: 'SHORTFALL_OPEN',
            shortfall: 20,
          });
          expect(res.body.data.items).toHaveLength(20);
          expect(Object.keys(res.body.data.items[0]).sort()).toEqual([
            'bottleNumber',
            'burnTx',
            'outcome',
            'resolvedAt',
            'status',
            'tokenId',
          ]);
        }
        // La enóloga no lo lee; la colección de otra bodega no existe
        expect((await get(path, 'enologist')).status).toBe(403);
        expect(
          (await get(`/v1/collections/${randomUUID()}/closure`, 'owner')).body
            .error,
        ).toMatchObject({ code: 'TOK_COLLECTION_NOT_FOUND' });
        // En la ficha de la colección, también
        const collection = await get(
          `/v1/collections/${COLLECTION_B}`,
          'owner',
        );
        expect(collection.body.data.closure).toMatchObject({
          status: 'SHORTFALL_OPEN',
          shortfall: 20,
        });
      });

      it('con el faltante abierto la colección no se cierra, y con quemas solo decide administración', async () => {
        const close = await post(
          `/v1/platform/collections/${COLLECTION_B}/close`,
          'operations',
          REASON,
        );
        expect([close.status, close.body.error?.code]).toEqual([
          409,
          'TOK_CLOSURE_PENDING',
        ]);
        const path = `${closurePath()}/decide`;
        const body = { unsoldPolicy: 'KEEP_ON_SALE', ...REASON };
        const operations = await post(path, 'operations', body);
        expect([operations.status, operations.body.error?.code]).toEqual([
          403,
          'AUTH_INSUFFICIENT_PERMISSIONS',
        ]);
        expect((await post(path, 'support', body)).status).toBe(403);
        expect((await post(path, 'owner', body)).status).toBe(403);
        expect(
          (await post(path, 'admin', { unsoldPolicy: 'KEEP_ON_SALE' })).status,
        ).toBe(422);
        expect(
          (await post(path, 'admin', { unsoldPolicy: 'REGALAR', ...REASON }))
            .status,
        ).toBe(422);
        expect(
          (await call('post', path, 'admin', { body })).body.error,
        ).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
        // Nada se ha encolado
        expect(
          await prisma.chainTransaction.count({
            where: { kind: 'BURN_UNSOLD' },
          }),
        ).toBe(0);
      });

      it('administración decide: 20 BURN_UNSOLD con redeem_burn del operador; BURNED en la red y owner_of falla', async () => {
        const balanceBefore = await balanceOf();
        const totalBefore = await totalMinted();
        const key = randomUUID();
        const body = { unsoldPolicy: 'KEEP_ON_SALE', ...REASON };
        const started = Date.now();
        const decided = await call('post', `${closurePath()}/decide`, 'admin', {
          body,
          key,
        });
        expect(decided.status).toBe(200);
        openapi.expectResponse(
          'post',
          '/v1/platform/collections/{id}/closure/decide',
          decided,
        );
        expect(decided.body.data).toMatchObject({
          status: 'DECIDED',
          unsoldPolicy: 'KEEP_ON_SALE',
          shortfall: 20,
          unsoldToBurn: 20,
          decision: { reason: REASON.reason },
        });
        expect(decided.body.data.items).toHaveLength(20);
        for (const item of decided.body.data.items) {
          expect(item).toMatchObject({
            outcome: 'BURN_UNSOLD',
            burnTx: { kind: 'BURN_UNSOLD', network: 'LOCAL' },
          });
        }
        // La misma clave devuelve lo mismo y no encola otra vez; otra decisión → 409
        const replay = await call('post', `${closurePath()}/decide`, 'admin', {
          body,
          key,
        });
        expect(replay.status).toBe(200);
        const again = await post(`${closurePath()}/decide`, 'admin', body);
        expect([again.status, again.body.error?.code]).toEqual([
          409,
          'CONFLICT',
        ]);
        const burns = await prisma.chainTransaction.findMany({
          where: { kind: 'BURN_UNSOLD', wineryId: WINERY },
        });
        expect(burns).toHaveLength(20);
        const closureRow = await prisma.lotClosure.findUniqueOrThrow({
          where: { collectionId: COLLECTION_B },
        });
        expect(new Set(burns.map((b) => b.intentKey))).toEqual(
          new Set(
            Array.from(
              { length: 20 },
              (_, i) => `burn-unsold:${closureRow.id}:${FIRST_ID + 80 + i}`,
            ),
          ),
        );

        await waitClosure(
          COLLECTION_B,
          (closure) => closure.status === 'RESOLVED',
          300_000,
        );
        timings.quemas20 = Date.now() - started;
        const confirmed = await prisma.chainTransaction.findMany({
          where: { kind: 'BURN_UNSOLD', wineryId: WINERY },
          orderBy: { confirmedAt: 'asc' },
        });
        expect(confirmed.every((tx) => tx.status === 'CONFIRMED')).toBe(true);
        // Solo firma operaciones (rol operator); la bodega no interviene
        expect(confirmed[0].signers).toEqual([
          { role: 'OPERATIONS', address: operationsAddress, wineryId: null },
        ]);
        expect(
          (confirmed[0].result as { contractEvents: string[] }).contractEvents,
        ).toEqual(['burn']);
        fees.burnUnsold = String(confirmed[0].feeChargedStroops);

        // La base: 20 BURNED por faltante (botellas 81–100) y 80 a la venta
        const burned = await prisma.token.findMany({
          where: { collectionId: COLLECTION_B, status: 'BURNED' },
          orderBy: { bottleNumber: 'asc' },
        });
        expect(burned.map((t) => t.bottleNumber)).toEqual(
          Array.from({ length: 20 }, (_, i) => 81 + i),
        );
        for (const token of burned) {
          expect(token).toMatchObject({
            burnReason: 'SHORTFALL',
            onchainBurned: true,
            onchainOwner: null,
          });
          expect(token.burnedAt).not.toBeNull();
          expect(token.burnTxId).not.toBeNull();
        }
        expect(
          await prisma.token.count({
            where: { collectionId: COLLECTION_B, status: 'MINTED' },
          }),
        ).toBe(80);
        // La red: la bodega tiene 20 menos, el contador no baja y owner_of falla con 200
        expect(await balanceOf()).toBe(balanceBefore - 20);
        expect(await totalMinted()).toBe(totalBefore);
        expect(await ownerOf(FIRST_ID + 99)).toBe('error:200');
        expect(await ownerOf(FIRST_ID + 80)).toBe('error:200');
        expect(await ownerOf(FIRST_ID + 79)).toBe(ACCOUNT);

        const view = await get(closurePath(), 'admin');
        expect(view.body.data).toMatchObject({
          status: 'RESOLVED',
          shortfall: 20,
          unsoldToBurn: 20,
        });
        for (const item of view.body.data.items) {
          expect(item).toMatchObject({
            status: 'BURNED',
            outcome: 'BURN_UNSOLD',
            burnTx: { status: 'CONFIRMED' },
          });
          expect(item.resolvedAt).not.toBeNull();
          expect(item.burnTx.explorerUrl).toContain(`${EXPLORER}/tx/`);
        }
        // Bitácora: la decisión (administración) y las quemas (sistema)
        const decision = await prisma.auditEvent.findFirstOrThrow({
          where: {
            action: 'LOT_CLOSURE_DECIDED',
            resourceId: closureRow.id,
          },
        });
        expect(decision.after).toMatchObject({
          status: 'DECIDED',
          burnsRequested: 20,
        });
        const burnedAudit = await prisma.auditEvent.findFirstOrThrow({
          where: { action: 'UNSOLD_TOKENS_BURNED' },
        });
        expect(burnedAudit).toMatchObject({ actorUserId: null });
        expect(burnedAudit.after).toMatchObject({
          burned: 20,
          burnReason: 'SHORTFALL',
          closureStatus: 'RESOLVED',
        });
        // Metadatos públicos: el NFT quemado sigue respondiendo, como BURNED
        const slug = `conciliacion-${run}`;
        const metadata = await get(
          `/v1/public/nft/${slug}/${FIRST_ID + 99}`,
          null,
        );
        expect(
          metadata.body.properties ?? metadata.body.data?.properties,
        ).toMatchObject({ status: 'BURNED' });
      });

      it('el indexador enlaza las 20 quemas; la colección y la cuenta de la bodega cuentan los quemados', async () => {
        await indexer.poll();
        const events = await prisma.chainEvent.findMany({
          where: { contractAddress: CONTRACT, type: 'burn' },
        });
        expect(events).toHaveLength(20);
        expect(events.every((e) => e.originatedBySystem)).toBe(true);
        expect(events.every((e) => (e.topics as string[])[0] === ACCOUNT)).toBe(
          true,
        );
        expect(await openAlerts()).toEqual([]);

        const collection = await get(
          `/v1/platform/collections/${COLLECTION_B}`,
          'support',
        );
        expect(collection.body.data.counts).toMatchObject({
          minted: 100,
          available: 80,
          burned: 20,
        });
        expect(collection.body.data.closure).toMatchObject({
          status: 'RESOLVED',
        });
        // Las quemas cuentan en los costes de la colección: 1 emisión + 20 quemas
        expect(collection.body.data.metrics.chainCosts.transactions).toBe(21);
        const transactions = await get(
          `/v1/platform/collections/${COLLECTION_B}/transactions?limit=100`,
          'support',
        );
        expect(
          transactions.body.data.items.filter(
            (t: { kind: string }) => t.kind === 'BURN_UNSOLD',
          ),
        ).toHaveLength(20);

        const account = await get(
          '/v1/organizations/current/chain-account',
          'owner',
        );
        expect(account.body.data.totals).toMatchObject({
          minted: 250,
          available: 230,
          burned: 20,
        });
        const byLot = account.body.data.byLot.find(
          (l: { lotId: string }) => l.lotId === LOT_B,
        );
        expect(byLot).toMatchObject({
          lotCode: LOT_CODE_B,
          counts: { minted: 100, available: 80, burned: 20 },
          anchor: null,
        });
      });

      it('conciliación FULL de la colección tras las quemas → OK (BURN_MISMATCH y BOTTLES_SHORTFALL cuadran)', async () => {
        await extendTtl();
        const done = await reconcile({
          scope: 'COLLECTION',
          subjectId: COLLECTION_B,
          depth: 'FULL',
        });
        expect(done).toMatchObject({
          status: 'OK',
          issuesOpened: 0,
          alerts: [],
        });
      });

      it('otra botella anulada después: el cierre se reabre con un ítem más y vuelve a decidirse', async () => {
        const closure = await prisma.lotClosure.findUniqueOrThrow({
          where: { collectionId: COLLECTION_B },
        });
        expect(await voidBottle(LOT_B, 80, LOT_CODE_B)).toBe(79);
        const reopened = await waitClosure(
          COLLECTION_B,
          (c) => c.status === 'SHORTFALL_OPEN',
        );
        expect(reopened).toMatchObject({
          id: closure.id,
          bottles: 79,
          shortfall: 21,
          unsoldToBurn: 21,
        });
        // El siguiente número más alto sin vender: la botella 80
        const pending = reopened.items.filter((i) => i.outcome === 'PENDING');
        expect(pending.map((i) => i.bottleNumber)).toEqual([80]);
        expect(
          await prisma.auditEvent.count({
            where: { action: 'LOT_SHORTFALL_DETECTED', resourceId: closure.id },
          }),
        ).toBe(2);

        const decided = await post(`${closurePath()}/decide`, 'admin', {
          unsoldPolicy: 'KEEP_ON_SALE',
          ...REASON,
        });
        expect(decided.status).toBe(200);
        await waitClosure(COLLECTION_B, (c) => c.status === 'RESOLVED');
        expect(await ownerOf(FIRST_ID + 79)).toBe('error:200');
        expect(
          await prisma.token.count({
            where: { collectionId: COLLECTION_B, status: 'BURNED' },
          }),
        ).toBe(21);
      });

      it('con el cierre RESOLVED la colección ya se puede cerrar', async () => {
        const closed = await post(
          `/v1/platform/collections/${COLLECTION_B}/close`,
          'operations',
          REASON,
        );
        expect(closed.status).toBe(200);
        expect(closed.body.data.status).toBe('CLOSED');
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    describe('NFT vendidos sin botella y lote descartado (§8.4, A-30)', () => {
      let COLLECTION_C = '';
      let FIRST = 0;

      it('2 vendidos y 1 sin vender para 1 botella: se quema el no vendido y el vendido más reciente se resuelve a mano', async () => {
        const lot = await newLot(`Singani casi vendido ${run}`, 500);
        FIRST = await totalMinted();
        const minted = await mintNow(lot.id, 3, `Casi vendido ${run}`);
        COLLECTION_C = minted.collectionId;
        // Ventas sembradas (la compra llega con la Ola 4): botellas 1 y 2
        const buyer = Keypair.random().publicKey();
        for (const [bottleNumber, soldAt] of [
          [1, '2026-10-01T10:00:00.000Z'],
          [2, '2026-10-05T10:00:00.000Z'],
        ] as const) {
          await prisma.token.updateMany({
            where: { collectionId: COLLECTION_C, bottleNumber },
            data: {
              status: 'SOLD',
              ownerKind: 'CONSUMER',
              ownerAddress: buyer,
              soldAt: new Date(soldAt),
            },
          });
        }
        await bottle(lot.id, 1);
        const closure = await waitClosure(COLLECTION_C, () => true);
        expect(closure).toMatchObject({
          status: 'SHORTFALL_OPEN',
          bottles: 1,
          minted: 3,
          sold: 2,
          unsold: 1,
          shortfall: 2,
          unsoldToBurn: 1,
          soldWithoutBottle: 1,
        });
        // Primero el no vendido (3); después el pedido pagado más reciente (2)
        expect(
          closure.items.map((i) => [i.bottleNumber, i.tokenStatus]).sort(),
        ).toEqual([
          [2, 'SOLD'],
          [3, 'MINTED'],
        ]);
        expect(closure.items.find((i) => i.bottleNumber === 2)?.paidAt).toEqual(
          new Date('2026-10-05T10:00:00.000Z'),
        );

        const base = `/v1/platform/collections/${COLLECTION_C}/closure`;
        const resolve = (tokenId: number, who: string, body: object) =>
          call('post', `${base}/items/${tokenId}/resolve`, who, { body });
        const manual = {
          outcome: 'MANUAL_REFUND',
          note: 'Devolución acordada',
        };
        // Permisos y validación
        expect((await resolve(FIRST + 1, 'support', manual)).status).toBe(403);
        expect((await resolve(FIRST + 1, 'owner', manual)).status).toBe(403);
        expect(
          (
            await resolve(FIRST + 1, 'operations', {
              outcome: 'BURN_UNSOLD',
              note: 'no',
            })
          ).status,
        ).toBe(422);
        expect(
          (await resolve(FIRST + 1, 'operations', { outcome: 'MANUAL_REFUND' }))
            .status,
        ).toBe(422);
        // El que sí tiene botella no es un ítem; el no vendido se quema, no se resuelve
        const notItem = await resolve(FIRST, 'operations', manual);
        expect([notItem.status, notItem.body.error?.code]).toEqual([
          404,
          'NOT_FOUND',
        ]);
        const unsold = await resolve(FIRST + 2, 'operations', manual);
        expect([unsold.status, unsold.body.error?.code]).toEqual([
          409,
          'CONFLICT',
        ]);

        const decided = await post(`${base}/decide`, 'admin', {
          unsoldPolicy: 'KEEP_ON_SALE',
          ...REASON,
        });
        expect(decided.body.data).toMatchObject({ status: 'DECIDED' });
        // El NFT vendido sigue vivo y pendiente hasta que alguien lo resuelva
        await waitFor('la quema del no vendido', async () => {
          const token = await prisma.token.findFirst({
            where: { collectionId: COLLECTION_C, bottleNumber: 3 },
          });
          return token?.status === 'BURNED';
        });
        expect(
          (
            await prisma.lotClosure.findUniqueOrThrow({
              where: { collectionId: COLLECTION_C },
            })
          ).status,
        ).toBe('DECIDED');
        expect(
          (
            await post(
              `/v1/platform/collections/${COLLECTION_C}/close`,
              'admin',
              REASON,
            )
          ).body.error,
        ).toMatchObject({ code: 'TOK_CLOSURE_PENDING' });

        const resolved = await resolve(FIRST + 1, 'operations', manual);
        expect(resolved.status).toBe(200);
        openapi.expectResponse(
          'post',
          '/v1/platform/collections/{id}/closure/items/{tokenId}/resolve',
          resolved,
        );
        expect(resolved.body.data.status).toBe('RESOLVED');
        const item = resolved.body.data.items.find(
          (i: { tokenId: number }) => i.tokenId === FIRST + 1,
        );
        expect(item).toMatchObject({
          status: 'SOLD',
          outcome: 'MANUAL_REFUND',
          note: 'Devolución acordada',
          burnTx: null,
          paidAt: '2026-10-05T10:00:00.000Z',
        });
        expect(item.resolvedAt).not.toBeNull();
        // El NFT vendido no se quema: sigue en la red
        expect(await ownerOf(FIRST + 1)).toBe(ACCOUNT);
        const twice = await resolve(FIRST + 1, 'operations', manual);
        expect([twice.status, twice.body.error?.code]).toEqual([
          409,
          'CONFLICT',
        ]);
        const audit = await prisma.auditEvent.findFirstOrThrow({
          where: { action: 'LOT_CLOSURE_ITEM_RESOLVED' },
        });
        expect(audit.after).toMatchObject({
          tokenId: FIRST + 1,
          outcome: 'MANUAL_REFUND',
          closureStatus: 'RESOLVED',
        });
        // La bodega no ve la nota ni el pedido
        const winery = await get(`/v1/collections/${COLLECTION_C}`, 'owner');
        const seen = winery.body.data.closure.items.find(
          (i: { tokenId: number }) => i.tokenId === FIRST + 1,
        );
        expect(seen).toMatchObject({ note: null, paidAt: null, orderId: null });
      });

      it('lote descartado desde el ERP (lot.discarded): 0 botellas, todos sus NFT pierden la suya', async () => {
        const lot = await newLot(`Singani descartado ${run}`, 500);
        const minted = await mintNow(lot.id, 2, `Descartado ${run}`);
        expect(
          (
            await get(
              `/v1/platform/collections/${minted.collectionId}/closure`,
              'admin',
            )
          ).status,
        ).toBe(409);
        await post(`/v1/lots/${lot.id}/discard`, 'owner', {
          reason: 'Lote contaminado',
        }).expect((res) => expect([200, 201]).toContain(res.status));
        const event = await prisma.outboxEvent.findFirstOrThrow({
          where: { eventType: 'lot.discarded', aggregateId: lot.id },
        });
        expect(event.payload).toMatchObject({
          lotId: lot.id,
          wineryId: WINERY,
          bottles: 0,
        });
        const closure = await waitClosure(minted.collectionId, () => true);
        expect(closure).toMatchObject({
          status: 'SHORTFALL_OPEN',
          bottles: 0,
          minted: 2,
          shortfall: 2,
          unsoldToBurn: 2,
        });
        // BURN (quemar también los que tienen botella): aquí no queda ninguno más
        const decided = await post(
          `/v1/platform/collections/${minted.collectionId}/closure/decide`,
          'admin',
          { unsoldPolicy: 'BURN', ...REASON },
        );
        expect(decided.body.data).toMatchObject({
          status: 'DECIDED',
          unsoldPolicy: 'BURN',
        });
        await waitClosure(minted.collectionId, (c) => c.status === 'RESOLVED');
        expect(
          await prisma.token.count({
            where: { collectionId: minted.collectionId, status: 'BURNED' },
          }),
        ).toBe(2);
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    describe('cabos de la emisión y del anclaje (§2.3, §6.1, §7.1)', () => {
      it('idempotencia por total_minted y lot_minted: la respuesta se pierde, el hash no aparece y no se emite dos veces', async () => {
        await idle();
        const lot = await newLot(`Singani sin respuesta ${run}`, 500);
        const before = await totalMinted();
        const requestId = await requestInReview(
          lot.id,
          4,
          `Sin respuesta ${run}`,
        );
        const sendsBefore = gateway.sends;
        // La transacción entra en la red, pero el worker no recibe la respuesta
        // y `getTransaction` no la encuentra (RPC atrasado)
        gateway.loseNextSendResponse = true;
        gateway.hideLookupsUntilEventsAreRead = true;
        const res = await approve(requestId).expect(201);
        const mintId = res.body.data.mint.id as string;
        const retrying = await waitFor(
          'RETRYING sin saber si entró',
          async () => {
            const [tx] = await mintTxs(mintId);
            return tx?.status === 'RETRYING' && tx.maxTime ? tx : null;
          },
        );
        expect(retrying.txHash).toMatch(/^[0-9a-f]{64}$/);
        expect(retrying.lastError).toMatchObject({
          code: 'CHN_RPC_UNAVAILABLE',
        });
        // En la red ya está emitido; en la base, todavía no
        await waitFor(
          'la emisión en la red',
          async () => (await totalMinted()) === before + 4,
        );
        expect(await prisma.token.count({ where: { mintId } })).toBe(0);
        // Mientras su maxTime no pase, no se reconstruye: sigue esperando
        await sleep(3000);
        expect((await mintTxs(mintId))[0].status).toBe('RETRYING');
        expect(gateway.sends).toBe(sendsBefore + 1);
        // Caducó sin que el hash apareciera: el firmante la va a reconstruir…
        await prisma.chainTransaction.update({
          where: { id: retrying.id },
          data: { maxTime: new Date(Date.now() - 60_000) },
        });
        await waitMint(mintId, 'CONFIRMED');
        // …pero total_minted ya avanzó y hay un lot_minted de un intento propio
        expect(gateway.sends).toBe(sendsBefore + 1);
        expect(await totalMinted()).toBe(before + 4);
        const [tx] = await mintTxs(mintId);
        expect(tx).toMatchObject({
          status: 'CONFIRMED',
          txHash: retrying.txHash,
        });
        const confirmed = tx.attemptsLog.find((a) => a.status === 'CONFIRMED');
        expect(confirmed?.detail).toContain('lot_minted');
        expect(tx.result).toMatchObject({ returnValue: before + 3 });
        const mint = await prisma.mint.findUniqueOrThrow({
          where: { id: mintId },
        });
        expect(mint.ranges).toEqual([
          {
            firstTokenId: before,
            lastTokenId: before + 3,
            firstBottleNumber: 1,
            lastBottleNumber: 4,
          },
        ]);
        expect(await prisma.token.count({ where: { mintId } })).toBe(4);
      });

      it('CHN_ARCHIVED_ENTRY con un RPC simulado (S-25): encadena RESTORE_ENTRIES y la emisión se reintenta', async () => {
        await idle();
        const { instanceKey } =
          await import('../src/modules/chain/ttl/ttl-keys');
        const lot = await newLot(`Singani archivado ${run}`, 500);
        const before = await totalMinted();
        const requestId = await requestInReview(lot.id, 2, `Archivado ${run}`);
        const archived = instanceKey(CONTRACT);
        // La red local no archiva entradas: se simula la respuesta del RPC que
        // pide restaurar la instancia del contrato antes de invocarlo
        gateway.archivedOnce = (tx, real) => {
          const [operation] = tx.operations;
          if (operation.type !== 'invokeHostFunction') return null;
          if (!rpc.Api.isSimulationSuccess(real)) return null;
          return {
            ...real,
            restorePreamble: {
              minResourceFee: '1000',
              transactionData: new SorobanDataBuilder().setReadWrite([
                archived,
              ]),
            },
          } as typeof real;
        };
        const res = await approve(requestId).expect(201);
        const mintId = res.body.data.mint.id as string;
        const [original] = await mintTxs(mintId);
        const restore = await waitTx(
          { intentKey: `restore:${original.id}:1` },
          ['CONFIRMED', 'FAILED'],
        );
        expect(restore).toMatchObject({
          kind: 'RESTORE_ENTRIES',
          status: 'CONFIRMED',
          wineryId: WINERY,
          subjectType: 'MINT',
          subjectId: mintId,
        });
        expect(restore.intent).toEqual({
          forTransactionId: original.id,
          ledgerKeys: [archived.toXDR('base64')],
        });
        // En la red local la entrada está viva: no hay nada que restaurar de verdad
        expect(
          restore.attemptsLog.find((a) => a.status === 'CONFIRMED')?.detail,
        ).toContain('ya están vivas');
        await waitMint(mintId, 'CONFIRMED');
        const [tx] = await mintTxs(mintId);
        expect(tx.attempts).toBe(2);
        expect(
          tx.attemptsLog
            .filter((a) => a.status === 'RETRYING')
            .map((a) => a.errorCode),
        ).toEqual(['CHN_ARCHIVED_ENTRY']);
        // Las claves no quedan en el historial de la transacción original
        expect(JSON.stringify(tx.attemptsLog)).not.toContain(
          archived.toXDR('base64'),
        );
        expect(await totalMinted()).toBe(before + 2);
      });

      it('«el rango no cuadra»: la red emite con otro lote que el de la base → MINT_RANGE_MISMATCH, emisión FAILED y nada publicado', async () => {
        await idle();
        const lot = await newLot(`Singani de rango raro ${run}`, 500);
        const before = await totalMinted();
        const requestId = await requestInReview(lot.id, 2, `Rango raro ${run}`);
        let mintId = '';
        // Justo antes de enviarse, la base cambia el lote que espera
        gateway.beforeSend = async (tx) => {
          const [operation] = tx.operations;
          if (operation.type !== 'invokeHostFunction' || mintId === '') {
            return false;
          }
          await prisma.mint.update({
            where: { id: mintId },
            data: { lotArg: 'OTRO-L2026-999' },
          });
          return true;
        };
        chainSettings.mintEnabled = false;
        const res = await approve(requestId, { publishOnMint: true }).expect(
          201,
        );
        mintId = res.body.data.mint.id as string;
        const collectionId = res.body.data.collection.id as string;
        const held = await waitFor('intención en espera', async () => {
          const [tx] = await mintTxs(mintId);
          return tx?.lastError ? tx : null;
        });
        chainSettings.mintEnabled = true;
        await signer.process(held.id);
        await waitMint(mintId, 'FAILED');
        const [tx] = await mintTxs(mintId);
        // La transacción sí entró en la red…
        expect(tx.status).toBe('CONFIRMED');
        expect(await totalMinted()).toBe(before + 2);
        // …pero su evento no es el que la base esperaba: nada se registra ni se publica
        expect(await prisma.token.count({ where: { mintId } })).toBe(0);
        const collection = await prisma.collection.findUniqueOrThrow({
          where: { id: collectionId },
        });
        expect(collection).toMatchObject({
          status: 'MINTING',
          mintStatus: 'FAILED',
          minted: 0,
          publishedAt: null,
        });
        const [alert] = await openAlerts({ code: 'MINT_RANGE_MISMATCH' });
        expect(alert).toMatchObject({
          level: 'CRITICAL',
          subjectType: 'MINT',
          subjectId: mintId,
          wineryId: WINERY,
        });
        expect(alert.message).toContain('OTRO-L2026-999');
        expect(alert.actual).toMatchObject({
          returnValue: before + 1,
          txHash: tx.txHash,
        });
        // Y la conciliación lo ve como lo que es: la red tiene 2 NFT que la base no
        const done = await reconcile({
          scope: 'CONTRACT',
          subjectId: CONTRACT_ID,
          depth: 'LIGHT',
        });
        expect(done.status).toBe('DIFFERENCES');
        expect(done.alerts.map((a) => a.code)).toEqual(
          expect.arrayContaining(['BALANCE_MISMATCH', 'TOTAL_MINTED_MISMATCH']),
        );
        // Se resuelve a mano, con nota; dos veces no
        const path = `/v1/platform/chain/alerts/${alert.id}/resolve`;
        const note = { note: 'Emisión revisada con la bodega; se repetirá' };
        expect(
          (await call('post', path, 'support', { body: note })).status,
        ).toBe(403);
        expect(
          (await call('post', path, 'operations', { body: {} })).status,
        ).toBe(422);
        const resolved = await call('post', path, 'operations', { body: note });
        expect(resolved.status).toBe(200);
        openapi.expectResponse(
          'post',
          '/v1/platform/chain/alerts/{id}/resolve',
          resolved,
        );
        expect(resolved.body.data).toMatchObject({
          id: alert.id,
          resolution: { note: note.note, auto: false },
        });
        expect(typeof resolved.body.data.resolution.by).toBe('string');
        const twice = await call('post', path, 'admin', { body: note });
        expect([twice.status, twice.body.error?.code]).toEqual([
          409,
          'CHN_ALERT_ALREADY_RESOLVED',
        ]);
        expect(
          (
            await call(
              'post',
              `/v1/platform/chain/alerts/${randomUUID()}/resolve`,
              'admin',
              { body: note },
            )
          ).body.error,
        ).toMatchObject({ code: 'NOT_FOUND' });
        const audit = await prisma.auditEvent.findFirstOrThrow({
          where: { action: 'CHAIN_ALERT_RESOLVED', resourceId: alert.id },
        });
        expect(audit.reason).toBe(note.note);
      });

      it('«el memo no cuadra»: el expediente cambia de huella antes de anclarse → ANCHOR_MISMATCH y el lote sigue CERTIFIED', async () => {
        await idle();
        const lot = await newLot(`Singani de memo raro ${run}`, 500);
        const lotCode = await bottle(lot.id, 10);
        const dossier = await closeDossier(lot.id, lotCode, 'memo raro');
        const otherHash = createHash('sha256')
          .update(`otro ${run}`)
          .digest('hex');
        gateway.beforeSend = async (tx) => {
          if (tx.memo.type !== 'hash') return false;
          // La transacción lleva la huella de antes; la base ya tiene otra
          await prisma.lotDossier.update({
            where: { lotId: lot.id },
            data: { hash: otherHash },
          });
          return true;
        };
        await certify(dossier);
        const anchorTx = await waitTx({ intentKey: `anchor:${lot.id}` }, [
          'CONFIRMED',
          'FAILED',
        ]);
        expect(anchorTx.status).toBe('CONFIRMED');
        const lookup = await gateway.getTransaction(anchorTx.txHash as string);
        if (lookup.status !== 'SUCCESS') throw new Error('sin transacción');
        expect(lookup.memoHashHex).toBe(dossier.hash);
        // El memo de la red no es la huella del expediente: no se da por anclado
        const anchor = await prisma.dossierAnchor.findUniqueOrThrow({
          where: { lotId: lot.id },
        });
        expect(anchor.status).not.toBe('ANCHORED');
        expect(anchor.verifiedAt).toBeNull();
        expect(
          (await prisma.lot.findUniqueOrThrow({ where: { id: lot.id } })).stage,
        ).toBe('CERTIFIED');
        const [alert] = await openAlerts({ code: 'ANCHOR_MISMATCH' });
        expect(alert).toMatchObject({ level: 'CRITICAL', wineryId: WINERY });
        expect(JSON.stringify([alert.expected, alert.actual])).toContain(
          otherHash,
        );
        expect(JSON.stringify([alert.expected, alert.actual])).toContain(
          dossier.hash,
        );
        // En público, un anclaje que no se dio por bueno es «pendiente»
        const verification = await get(
          `/v1/public/lots/${lotCode}/verification`,
          null,
        );
        if (verification.status === 200) {
          expect(verification.body.data.anchor?.status ?? 'PENDING').toBe(
            'PENDING',
          );
        }
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    describe('bodega suspendida y revocada (§3.5, §14; decisión de la coordinación)', () => {
      let W2 = '';
      let W2_CONTRACT_ID = '';
      let W2_CONTRACT = '';
      let COLLECTION_W2 = '';
      let LOT_W2 = '';
      let COVER_W2 = '';
      const status = (action: string) =>
        call('post', `/v1/platform/wineries/${W2}/${action}`, 'admin', {
          body: { reason: 'Prueba de la bodega no activa' },
        });

      it('suspendida con una colección publicada: pasa a PAUSED y su emisión pendiente espera (CHN_WINERY_NOT_ACTIVE)', async () => {
        await idle();
        const second = await provisionWinery('Bodega de la Suspensión', 'SUS');
        W2 = second.wineryId;
        W2_CONTRACT_ID = second.contractId;
        W2_CONTRACT = second.contract;
        await wineryToken('owner2', W2, 'OWNER');
        COVER_W2 = await uploadTraceFile(app, tokens.owner2, {
          folder: 'labels',
          file: Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            Buffer.from(`portada de la suspensión ${run}`),
          ]),
          name: 'portada.png',
          ip: nextIp(),
        });
        LOT_W2 = (await newLot(`Singani suspendido ${run}`, 500, 'owner2')).id;
        const minted = await mintNow(
          LOT_W2,
          5,
          `Suspendido ${run}`,
          { publishOnMint: true },
          'owner2',
          COVER_W2,
        );
        COLLECTION_W2 = minted.collectionId;
        expect(
          (
            await prisma.collection.findUniqueOrThrow({
              where: { id: COLLECTION_W2 },
            })
          ).status,
        ).toBe('PUBLISHED');
        // Otra bodega no ve el cierre ni la colección de esta
        expect(
          (await get(`/v1/collections/${COLLECTION_W2}/closure`, 'owner'))
            .status,
        ).toBe(404);

        // Una ampliación aprobada que aún no ha salido a la red
        const requestId = await requestInReview(
          LOT_W2,
          3,
          'Ampliación',
          'owner2',
          COVER_W2,
        );
        chainSettings.mintEnabled = false;
        const res = await approve(requestId).expect(201);
        const mintId = res.body.data.mint.id as string;
        const held = await waitFor('emisión en espera', async () => {
          const [tx] = await mintTxs(mintId);
          return tx?.lastError ? tx : null;
        });
        expect(held.lastError).toMatchObject({ code: 'CHN_MINT_DISABLED' });

        const suspended = await status('suspend');
        expect(suspended.status).toBe(200);
        expect(suspended.body.data.status).toBe('SUSPENDED');
        // Colección publicada → PAUSED por el sistema; la red no se toca
        const collection = await prisma.collection.findUniqueOrThrow({
          where: { id: COLLECTION_W2 },
          include: { statusHistory: { orderBy: { at: 'desc' }, take: 1 } },
        });
        expect(collection.status).toBe('PAUSED');
        expect(collection.statusHistory[0]).toMatchObject({
          status: 'PAUSED',
          actorSystem: true,
        });
        expect(await readContract(W2_CONTRACT, 'paused')).toBe(false);

        // La emisión se habilita, pero con la bodega suspendida no se envía ni falla
        chainSettings.mintEnabled = true;
        const sendsBefore = gateway.sends;
        expect(await signer.process(held.id)).toBe('HELD');
        const waiting = (await mintTxs(mintId))[0];
        expect(waiting).toMatchObject({
          status: 'PENDING',
          attempts: 0,
          txHash: null,
        });
        expect(waiting.lastError).toMatchObject({
          code: 'CHN_WINERY_NOT_ACTIVE',
          retryable: false,
        });
        expect((waiting.lastError as { message: string }).message).toContain(
          'SUSPENDED',
        );
        expect(gateway.sends).toBe(sendsBefore);
        expect(await totalMinted(W2_CONTRACT)).toBe(5);
        expect(
          (await prisma.mint.findUniqueOrThrow({ where: { id: mintId } }))
            .status,
        ).toBe('PENDING');
        // Ni alerta ni transacción fallida: está en espera
        expect(await openAlerts({ wineryId: W2 })).toEqual([]);

        // Al reactivarse la bodega se reanuda sola (winery.status_changed)
        const reactivated = await status('reactivate');
        expect(reactivated.body.data.status).toBe('ACTIVE');
        // Suspenderla cerró las sesiones de la bodega
        await login('owner2');
        await waitMint(mintId, 'CONFIRMED');
        expect(await totalMinted(W2_CONTRACT)).toBe(8);
        // La colección sigue pausada hasta que operaciones la reanude
        expect(
          (
            await prisma.collection.findUniqueOrThrow({
              where: { id: COLLECTION_W2 },
            })
          ).status,
        ).toBe('PAUSED');
      });

      it('revocada: contrato pausado en la red, colección PAUSED y la emisión pendiente no sale', async () => {
        await idle();
        await post(
          `/v1/platform/collections/${COLLECTION_W2}/resume`,
          'operations',
          REASON,
        ).expect(200);
        const requestId = await requestInReview(
          LOT_W2,
          2,
          'Otra ampliación',
          'owner2',
          COVER_W2,
        );
        chainSettings.mintEnabled = false;
        const res = await approve(requestId).expect(201);
        const mintId = res.body.data.mint.id as string;
        const held = await waitFor('emisión en espera', async () => {
          const [tx] = await mintTxs(mintId);
          return tx?.lastError ? tx : null;
        });

        const revoked = await status('revoke');
        expect(revoked.status).toBe(200);
        expect(revoked.body.data.status).toBe('REVOKED');
        expect(
          (
            await prisma.collection.findUniqueOrThrow({
              where: { id: COLLECTION_W2 },
            })
          ).status,
        ).toBe('PAUSED');
        // El contrato queda pausado en la red, firmado por el operador
        const pause = await waitTx({ kind: 'PAUSE_CONTRACT', wineryId: W2 }, [
          'CONFIRMED',
          'FAILED',
        ]);
        expect(pause.status).toBe('CONFIRMED');
        expect(pause.signers).toEqual([
          { role: 'OPERATIONS', address: operationsAddress, wineryId: null },
        ]);
        expect(await readContract(W2_CONTRACT, 'paused')).toBe(true);
        const contract = await prisma.nftContract.findUniqueOrThrow({
          where: { id: W2_CONTRACT_ID },
          include: { chainAccount: true },
        });
        expect(contract.paused).toBe(true);
        expect(contract.chainAccount.status).toBe('PAUSED');

        // La emisión pendiente no se envía ni se da por fallida
        chainSettings.mintEnabled = true;
        expect(await signer.process(held.id)).toBe('HELD');
        const waiting = (await mintTxs(mintId))[0];
        expect(waiting).toMatchObject({ status: 'PENDING', txHash: null });
        expect(waiting.lastError).toMatchObject({
          code: 'CHN_WINERY_NOT_ACTIVE',
        });
        expect(await totalMinted(W2_CONTRACT)).toBe(8);

        // El indexador ve la pausa como propia; la conciliación del contrato cuadra
        await indexer.poll();
        const paused = await prisma.chainEvent.findFirstOrThrow({
          where: { contractAddress: W2_CONTRACT, type: 'paused' },
        });
        expect(paused).toMatchObject({
          originatedBySystem: true,
          matchedTransactionId: pause.id,
        });
        await extendTtl();
        const done = await reconcile({
          scope: 'CONTRACT',
          subjectId: W2_CONTRACT_ID,
          depth: 'FULL',
        });
        expect(done.alerts.map((a) => a.code)).toEqual([]);
        expect(done.status).toBe('OK');
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    describe('evento no originado por el sistema (§8.1, §14)', () => {
      it('una transferencia firmada fuera del sistema → UNEXPECTED_EVENT CRITICAL; la base no se toca y la conciliación lo confirma', async () => {
        await idle();
        const stranger = Keypair.random().publicKey();
        const txHash = await foreignTransfer(5, stranger);
        expect(await ownerOf(5)).toBe(stranger);
        await indexer.poll();

        const event = await prisma.chainEvent.findFirstOrThrow({
          where: { txHash },
        });
        expect(event).toMatchObject({
          type: 'transfer',
          contractAddress: CONTRACT,
          wineryId: WINERY,
          originatedBySystem: false,
          matchedTransactionId: null,
          topics: [ACCOUNT, stranger],
          data: { token_id: 5 },
        });
        const [alert] = await openAlerts({ code: 'UNEXPECTED_EVENT' });
        expect(alert).toMatchObject({
          level: 'CRITICAL',
          subjectType: 'EVENT',
          subjectId: event.rpcEventId,
          wineryId: WINERY,
        });
        expect(alert.actual).toMatchObject({ type: 'transfer', txHash });
        // El indexador refleja lo que dice la red, pero nunca corrige el negocio
        const token = await prisma.token.findFirstOrThrow({
          where: { contractId: CONTRACT_ID, tokenId: 5 },
        });
        expect(token).toMatchObject({
          status: 'MINTED',
          ownerKind: 'WINERY',
          ownerAddress: ACCOUNT,
          onchainOwner: stranger,
          onchainBurned: false,
        });

        const unmatched = await get(
          '/v1/platform/chain/events?unmatched=true',
          'support',
        );
        expect(unmatched.body.data.total).toBe(1);
        expect(unmatched.body.data.items[0]).toMatchObject({
          txHash,
          originatedBySystem: false,
          matchedTransactionId: null,
        });
        // Correo a operaciones de la alerta crítica
        await waitFor('correo de la alerta', async () => {
          const mails = await prisma.emailMessage.findMany({
            where: { template: 'alerta-cadena' },
          });
          return (
            mails.filter((m) =>
              JSON.stringify([m.variables, m.subject]).includes(
                'UNEXPECTED_EVENT',
              ),
            ).length >= 2
          );
        });
        // Repetir la pasada no duplica ni el evento ni la alerta
        await indexer.poll();
        expect(await openAlerts({ code: 'UNEXPECTED_EVENT' })).toHaveLength(1);
        expect(await prisma.chainEvent.count({ where: { txHash } })).toBe(1);

        const dashboard = await get('/v1/platform/dashboard', 'admin');
        expect(
          dashboard.body.data.chain.openAlerts.critical,
        ).toBeGreaterThanOrEqual(1);
      });

      it('hueco del indexador: el RPC ya no guarda desde el cursor → INDEXER_GAP y conciliación completa', async () => {
        await idle();
        // El cursor queda donde el RPC ya no llega (retención vencida)
        await prisma.chainCursor.update({
          where: { network_name: { network: 'LOCAL', name: 'events' } },
          data: { lastLedger: 0 },
        });
        const window = await gateway.ledgerWindow();
        const result = await indexer.poll();
        if (window.oldest > 1) {
          expect(result.gap).toBe(true);
          const [alert] = await openAlerts({ code: 'INDEXER_GAP' });
          expect(alert).toMatchObject({
            level: 'CRITICAL',
            subjectType: 'NETWORK',
            subjectId: 'LOCAL',
          });
          const gapRun = await waitFor(
            'conciliación por el hueco',
            async () => {
              const row = await prisma.reconciliationRun.findFirst({
                where: { trigger: 'INDEXER_GAP' },
              });
              return row && row.status !== 'RUNNING' ? row : null;
            },
          );
          expect(gapRun).toMatchObject({ scope: 'ALL', depth: 'FULL' });
        } else {
          // La red local aún conserva desde el primer ledger: no hay hueco
          expect(result.gap).toBe(false);
        }
        // El cursor parado más de 6 días también es un hueco: con la alerta
        // anterior ya resuelta, vuelve a abrirse
        await prisma.chainAlert.updateMany({
          where: { code: 'INDEXER_GAP', resolvedAt: null },
          data: {
            resolvedAt: new Date(),
            resolvedBy: 'Prueba',
            resolutionNote: 'Revisado',
          },
        });
        await prisma.$executeRaw`
          UPDATE chain_cursors SET updated_at = now() - interval '7 days'
          WHERE network = 'LOCAL' AND name = 'events'`;
        await indexer.poll();
        const alerts = await openAlerts({ code: 'INDEXER_GAP' });
        expect(alerts).toHaveLength(1);
        expect(alerts[0].message).toContain('días sin avanzar');
        // Releer desde el principio no duplica eventos (único por rpcEventId)
        const ids = await prisma.chainEvent.findMany({
          select: { rpcEventId: true },
        });
        expect(new Set(ids.map((e) => e.rpcEventId)).size).toBe(ids.length);
      });

      it('reinicio de la red: la secuencia de ledgers retrocede → NETWORK_RESET y el cursor no se mueve', async () => {
        const cursor = await prisma.chainCursor.update({
          where: { network_name: { network: 'LOCAL', name: 'events' } },
          data: { lastLedger: 2_000_000_000 },
        });
        const result = await indexer.poll();
        expect(result.status).toBe('NETWORK_RESET');
        const [alert] = await openAlerts({ code: 'NETWORK_RESET' });
        expect(alert).toMatchObject({
          level: 'CRITICAL',
          subjectType: 'NETWORK',
          subjectId: 'LOCAL',
        });
        expect(
          (
            await prisma.chainCursor.findUniqueOrThrow({
              where: { network_name: { network: 'LOCAL', name: 'events' } },
            })
          ).lastLedger,
        ).toBe(cursor.lastLedger);
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    it('permisos de §10 sobre las rutas del paso 3.6', async () => {
      const closure = `/v1/platform/collections/${COLLECTION}/closure`;
      const reads = [
        '/v1/platform/chain/events',
        '/v1/platform/chain/alerts',
        '/v1/platform/chain/reconciliation/runs',
        '/v1/platform/lot-closures',
        closure,
      ];
      for (const path of reads) {
        for (const who of ['admin', 'operations', 'support']) {
          expect([path, who, (await get(path, who)).status]).toEqual([
            path,
            who,
            200,
          ]);
        }
        for (const who of ['owner', 'enologist', 'accountant']) {
          expect([path, who, (await get(path, who)).status]).toEqual([
            path,
            who,
            403,
          ]);
        }
        expect([path, (await get(path, null)).status]).toEqual([path, 401]);
      }
    });
  },
);

// Constante compartida con el backend: un «día» de TTL son 17 280 ledgers
void LEDGERS_PER_DAY;
