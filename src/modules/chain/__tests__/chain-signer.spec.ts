import type { ChainTransaction, Prisma } from '@prisma/client';
import type { OutboxService } from '@shared/outbox/outbox.service';
import type { PrismaService } from '@shared/prisma/prisma.service';
import { ChainAlertsWriter } from '../alerts/chain-alerts.writer';
import { CHAIN_DEFAULTS, type ChainSettings } from '../chain.config';
import type { KeyCustody } from '../custody/key-custody';
import type { WineryIdentityService } from '../identity/winery-identity.service';
import type { ChainJobsQueue } from '../jobs/chain-jobs.queue';
import { ChainTxLifecycle } from '../jobs/chain-tx-lifecycle.service';
import type { ChainGateway } from '../jobs/gateway/chain-gateway';
import {
  PauseContractHandler,
  UnpauseContractHandler,
} from '../jobs/handlers/contract-pause.handlers';
import { FundAccountHandler } from '../jobs/handlers/fund-account.handler';
import { CreateWineryAccountHandler } from '../jobs/handlers/winery-identity.handlers';
import { ChainSigner } from '../jobs/signer/chain-signer.service';
import type { IntentEnv, IntentHandler } from '../jobs/signer/intent-handler';
import {
  ChainTxFailure,
  IntentOnHold,
  IntentRejected,
} from '../tx/chain-tx.errors';

const WINERY = '11111111-1111-4111-8111-111111111111';
const CONTRACT = '22222222-2222-4222-8222-222222222222';
const AUDIT = '33333333-3333-4333-8333-333333333333';
const OPERATIONS = `G${'A'.repeat(55)}`;
const WINERY_ACCOUNT = `G${'B'.repeat(55)}`;

const settings = (overrides: Partial<ChainSettings> = {}): ChainSettings => ({
  enabled: true,
  network: 'TESTNET',
  networkPassphrase: 'Test SDF Network ; September 2015',
  rpcUrl: 'https://rpc.e2e.test',
  explorerBaseUrl: null,
  homeDomain: 'api.e2e.test',
  wasmHash: 'a'.repeat(64),
  custodyDriver: 'ENV',
  mintEnabled: false,
  txMaxFeeStroops: CHAIN_DEFAULTS.txMaxFeeStroops,
  operationsMinBalanceXlm: '50',
  anchorMinBalanceXlm: '5',
  wineryStartingBalanceXlm: '2',
  ttlExtendBelowDays: 30,
  consumerSeedCheckAddress: null,
  publicApiBaseUrl: 'https://api.e2e.test',
  deployMaxFeeStroops: CHAIN_DEFAULTS.deployMaxFeeStroops,
  txRetryDelaysMs: CHAIN_DEFAULTS.txRetryDelaysMs,
  friendbotUrl: null,
  environment: 'testnet',
  ...overrides,
});

function tx(overrides: Partial<ChainTransaction> = {}): ChainTransaction {
  const at = new Date('2026-10-09T12:00:00.000Z');
  return {
    id: '44444444-4444-4444-8444-444444444444',
    kind: 'PAUSE_CONTRACT',
    status: 'PENDING',
    network: 'TESTNET',
    intentKey: `pause:${CONTRACT}:${AUDIT}`,
    subjectType: 'CONTRACT',
    subjectId: CONTRACT,
    wineryId: WINERY,
    intent: { auditEventId: AUDIT },
    sourceAccount: null,
    signers: [],
    txHash: null,
    ledger: null,
    confirmedAt: null,
    attempts: 0,
    lastError: null,
    feeChargedStroops: null,
    rentFeeStroops: null,
    maxFeeStroops: null,
    result: null,
    nextAttemptAt: null,
    maxTime: null,
    requestedByUserId: null,
    requestedByName: null,
    requestedSource: 'WORKER',
    abandonedAt: null,
    abandonedBy: null,
    abandonReason: null,
    correlationId: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

type Db = Prisma.TransactionClient;
const asDb = (value: unknown) => value as Db;
const rejects = (work: () => Promise<unknown>, reason: RegExp) =>
  expect(work()).rejects.toMatchObject({
    code: 'CHN_INTENT_REJECTED',
    retryable: false,
    detail: expect.stringMatching(reason),
  });

// ─────────────────────────────────────────────────────────────────────────────
describe('Validación de intenciones antes de firmar (contrato O3 §2.2)', () => {
  describe('PAUSE_CONTRACT / UNPAUSE_CONTRACT: exigen su entrada de bitácora', () => {
    const contract = (overrides: object = {}) => ({
      id: CONTRACT,
      wineryId: WINERY,
      network: 'TESTNET',
      address: `C${'D'.repeat(55)}`,
      status: 'ACTIVE',
      paused: false,
      chainAccountId: 'acc',
      chainAccount: {
        id: 'acc',
        address: WINERY_ACCOUNT,
        custodyKeyRef: `winery-${WINERY}`,
      },
      ...overrides,
    });
    const db = (
      found: object | null,
      audit: { action: string; organizationId: string | null } | null,
    ) =>
      asDb({
        $queryRaw: jest.fn().mockResolvedValue([]),
        nftContract: { findUnique: jest.fn().mockResolvedValue(found) },
        auditEvent: { findUnique: jest.fn().mockResolvedValue(audit) },
      });
    const pause = new PauseContractHandler();
    const unpause = new UnpauseContractHandler();
    const paused = { action: 'CHAIN_CONTRACT_PAUSED', organizationId: WINERY };

    it('con contrato vigente y su entrada de bitácora, pasa', async () => {
      const plan = await pause.validate(db(contract(), paused), tx());
      expect(plan.contract.id).toBe(CONTRACT);
      expect(plan.account.address).toBe(WINERY_ACCOUNT);
      // La revocación de la bodega también respalda la pausa (§3.5)
      await expect(
        pause.validate(
          db(contract(), { action: 'WINERY_REVOKED', organizationId: WINERY }),
          tx(),
        ),
      ).resolves.toBeDefined();
    });

    it('sin entrada de bitácora, de otra bodega o de otra acción: rechazada', async () => {
      await rejects(
        () => pause.validate(db(contract(), null), tx()),
        /bitácora/,
      );
      await rejects(
        () =>
          pause.validate(
            db(contract(), { ...paused, organizationId: 'otra' }),
            tx(),
          ),
        /bitácora/,
      );
      await rejects(
        () =>
          pause.validate(
            db(contract(), {
              action: 'WINERY_SUSPENDED',
              organizationId: WINERY,
            }),
            tx(),
          ),
        /bitácora/,
      );
    });

    it('la clave de la intención debe citar ese contrato y esa entrada', async () => {
      await rejects(
        () =>
          pause.validate(
            db(contract(), paused),
            tx({ intentKey: `pause:${CONTRACT}:otra-entrada` }),
          ),
        /cita/,
      );
      await rejects(
        () => pause.validate(db(contract(), paused), tx({ intent: {} })),
        /cita/,
      );
    });

    it('contrato inexistente, de otra bodega, sin desplegar o ya pausado: rechazada', async () => {
      await rejects(() => pause.validate(db(null, paused), tx()), /vigente/);
      await rejects(
        () => pause.validate(db(contract({ wineryId: 'otra' }), paused), tx()),
        /vigente/,
      );
      await rejects(
        () => pause.validate(db(contract({ status: 'PENDING' }), paused), tx()),
        /vigente/,
      );
      await rejects(
        () => pause.validate(db(contract({ paused: true }), paused), tx()),
        /ya está pausado/,
      );
      await rejects(
        () =>
          pause.validate(db(contract(), paused), tx({ subjectType: 'LOT' })),
        /no es un contrato/,
      );
    });

    it('reanudar: solo un contrato pausado y con la entrada de la reanudación', async () => {
      const unpauseTx = tx({
        kind: 'UNPAUSE_CONTRACT',
        intentKey: `unpause:${CONTRACT}:${AUDIT}`,
      });
      const entry = {
        action: 'CHAIN_CONTRACT_UNPAUSED',
        organizationId: WINERY,
      };
      await expect(
        unpause.validate(db(contract({ paused: true }), entry), unpauseTx),
      ).resolves.toBeDefined();
      await rejects(
        () => unpause.validate(db(contract(), entry), unpauseTx),
        /no está pausado/,
      );
      // La entrada de una pausa (o de una revocación) no autoriza reanudar
      await rejects(
        () =>
          unpause.validate(db(contract({ paused: true }), paused), unpauseTx),
        /bitácora/,
      );
    });

    it('reanudar lo autoriza la cuenta custodiada de la bodega; pausar, nadie más que el origen', async () => {
      const env = {
        operationsAddress: OPERATIONS,
        gateway: { readContract: jest.fn().mockResolvedValue(false) },
      } as unknown as IntentEnv;
      const address =
        'CDQX4AKGU76O7GH7F6SXPWGQ7YAVQTYPUYCSER67PWHJA3M7GIF6LACH';
      const account =
        'GC3YJAM34SF6MV3CL4NY37SAB3UMHQQ2NT24FPDNWRV3FFWLJSDNOP63';
      const plan = {
        contract: { ...contract({ address }), address },
        account: { address: account, custodyKeyRef: `winery-${WINERY}` },
      } as never;
      const prepared = await pause.prepare(plan, tx(), {
        ...env,
        operationsAddress: account,
      });
      expect(prepared).toMatchObject({ type: 'SOROBAN', authSigners: [] });

      (env.gateway.readContract as jest.Mock).mockResolvedValue(true);
      const resumed = await unpause.prepare(plan, tx(), env);
      expect(resumed).toMatchObject({
        type: 'SOROBAN',
        authSigners: [
          {
            role: 'WINERY',
            ref: `winery-${WINERY}`,
            address: account,
            wineryId: WINERY,
          },
        ],
      });
      // La red ya está como se pide: no se envía nada
      (env.gateway.readContract as jest.Mock).mockResolvedValue(false);
      expect((await unpause.prepare(plan, tx(), env)).type).toBe(
        'ALREADY_DONE',
      );
    });
  });

  describe('FUND_ACCOUNT: solo TESTNET y LOCAL, solo cuentas de la plataforma', () => {
    const fund = (subjectId: string, subjectType = 'PLATFORM') =>
      tx({ kind: 'FUND_ACCOUNT', subjectType, subjectId, wineryId: null });

    it('operaciones y anclaje en testnet y en la red local', async () => {
      for (const network of ['TESTNET', 'LOCAL'] as const) {
        const handler = new FundAccountHandler(settings({ network }));
        expect(await handler.validate(null, fund('OPERATIONS'))).toEqual({
          role: 'OPERATIONS',
          ref: 'platform-operations',
        });
        expect(await handler.validate(null, fund('ANCHOR'))).toEqual({
          role: 'ANCHOR',
          ref: 'platform-anchor',
        });
      }
    });

    it('no firma: sin cuenta de origen, y solo conoce direcciones', async () => {
      const handler = new FundAccountHandler(settings());
      expect(handler.source).toBeNull();
      const accountBalance = jest.fn().mockResolvedValue(null);
      const env = {
        keys: { publicKey: jest.fn().mockResolvedValue(OPERATIONS) },
        gateway: { accountBalance },
      } as unknown as IntentEnv;
      const plan = { role: 'OPERATIONS', ref: 'platform-operations' };
      expect(await handler.prepare(plan, fund('OPERATIONS'), env)).toEqual({
        type: 'FRIENDBOT',
        address: OPERATIONS,
      });
      // Por debajo del mínimo (50 XLM) se pide; con saldo, no hace falta
      accountBalance.mockResolvedValue(499_999_999n);
      expect((await handler.prepare(plan, fund('OPERATIONS'), env)).type).toBe(
        'FRIENDBOT',
      );
      accountBalance.mockResolvedValue(500_000_000n);
      expect((await handler.prepare(plan, fund('OPERATIONS'), env)).type).toBe(
        'ALREADY_DONE',
      );
    });

    it('no se da por hecho hasta que el RPC ve la cuenta fondeada', async () => {
      const handler = new FundAccountHandler(settings());
      const accountBalance = jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValue(100_000_000_000n);
      const env = {
        keys: { publicKey: jest.fn().mockResolvedValue(OPERATIONS) },
        gateway: { accountBalance },
      } as unknown as IntentEnv;
      await expect(
        handler.verify(fund('OPERATIONS'), env),
      ).resolves.toBeUndefined();
      expect(accountBalance).toHaveBeenCalledTimes(2);
    });

    it('nunca en la red pública, ni para otra cuenta', () => {
      const mainnet = new FundAccountHandler(settings({ network: 'PUBLIC' }));
      expect(() => mainnet.validate(null, fund('OPERATIONS'))).toThrow(
        IntentRejected,
      );
      const handler = new FundAccountHandler(settings());
      expect(() => handler.validate(null, fund('CONSUMER_SEED'))).toThrow(
        /operaciones y de anclaje/,
      );
      expect(() =>
        handler.validate(null, fund('OPERATIONS', 'WINERY')),
      ).toThrow(IntentRejected);
    });
  });

  describe('CREATE_WINERY_ACCOUNT: bodega ACTIVE con su cuenta registrada', () => {
    const handler = new CreateWineryAccountHandler(
      {} as PrismaService,
      {} as WineryIdentityService,
      settings(),
    );
    const account = {
      id: 'acc',
      role: 'WINERY',
      custodyKeyRef: `winery-${WINERY}`,
      address: null,
      confirmedAt: null,
    };
    const db = (status: string | null, row: object | null = account) =>
      asDb({
        $queryRaw: jest.fn().mockResolvedValue([]),
        winery: {
          findUnique: jest
            .fn()
            .mockResolvedValue(
              status ? { id: WINERY, certificationStatus: status } : null,
            ),
        },
        chainAccount: { findUnique: jest.fn().mockResolvedValue(row) },
      });
    const intent = (overrides: Partial<ChainTransaction> = {}) =>
      tx({
        kind: 'CREATE_WINERY_ACCOUNT',
        intentKey: `identity:${WINERY}:account`,
        subjectType: 'WINERY',
        subjectId: WINERY,
        ...overrides,
      });

    it('pasa con la bodega activa y su fila de cuenta', async () => {
      expect(await handler.validate(db('ACTIVE'), intent())).toMatchObject({
        wineryId: WINERY,
        account: { id: 'acc' },
      });
    });

    it('bodega inexistente, suspendida o revocada: rechazada', async () => {
      await rejects(() => handler.validate(db(null), intent()), /no existe/);
      for (const status of ['INVITED', 'SUSPENDED', 'REVOKED']) {
        await rejects(
          () => handler.validate(db(status), intent()),
          new RegExp(status),
        );
      }
    });

    it('sin cuenta registrada, con la clave de otra bodega o ya confirmada: rechazada', async () => {
      await rejects(
        () => handler.validate(db('ACTIVE', null), intent()),
        /cuenta registrada/,
      );
      await rejects(
        () =>
          handler.validate(
            db('ACTIVE', { ...account, custodyKeyRef: 'winery-otra' }),
            intent(),
          ),
        /cuenta registrada/,
      );
      await rejects(
        () =>
          handler.validate(
            db('ACTIVE', { ...account, confirmedAt: new Date() }),
            intent(),
          ),
        /ya estaba confirmada/,
      );
    });

    it('la clave de la intención debe ser la de su bodega', async () => {
      await rejects(
        () =>
          handler.validate(
            db('ACTIVE'),
            intent({ intentKey: 'identity:otra:account' }),
          ),
        /clave de la intención/,
      );
      await rejects(
        () => handler.validate(db('ACTIVE'), intent({ wineryId: 'otra' })),
        /clave de la intención/,
      );
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Firmante: solo intenciones registradas (contrato O3 §2.2)', () => {
  function build(
    row: ChainTransaction | null,
    options: {
      settings?: Partial<ChainSettings>;
      handler?: Partial<IntentHandler> | null;
      inFlight?: number;
    } = {},
  ) {
    const db = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      chainTransaction: {
        count: jest.fn().mockResolvedValue(options.inFlight ?? 0),
        update: jest
          .fn()
          .mockImplementation(({ data }: { data: object }) =>
            Promise.resolve({ ...row, ...data, attempts: 1 }),
          ),
      },
    };
    const prisma = {
      $transaction: jest.fn((work: (tx: unknown) => unknown) => work(db)),
      chainTransaction: {
        findUnique: jest.fn().mockResolvedValue(row),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue(row),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const handler =
      options.handler === null
        ? null
        : {
            kind: row?.kind,
            source: 'OPERATIONS',
            validate: jest.fn().mockResolvedValue({}),
            prepare: jest.fn(),
            ...options.handler,
          };
    const lifecycle = {
      lock: jest.fn().mockResolvedValue(row),
      handlerOf: jest.fn().mockReturnValue(handler),
      note: jest.fn().mockResolvedValue(undefined),
      fail: jest.fn().mockResolvedValue('FAILED'),
      confirm: jest.fn().mockResolvedValue(true),
    };
    const jobs = {
      process: jest.fn().mockResolvedValue(undefined),
      confirm: jest.fn().mockResolvedValue(undefined),
    };
    const custody = {
      driver: 'ENV',
      publicKey: jest.fn().mockResolvedValue(OPERATIONS),
      ensureKey: jest.fn().mockResolvedValue(OPERATIONS),
      sign: jest.fn(),
    };
    const gateway = {
      networkPassphrase: jest
        .fn()
        .mockResolvedValue('Test SDF Network ; September 2015'),
      loadAccount: jest.fn(),
      simulate: jest.fn(),
      send: jest.fn(),
      getTransaction: jest.fn(),
      fund: jest.fn().mockResolvedValue({ txHash: null }),
    };
    const signer = new ChainSigner(
      prisma as unknown as PrismaService,
      lifecycle as unknown as ChainTxLifecycle,
      jobs as unknown as ChainJobsQueue,
      custody as unknown as KeyCustody,
      gateway as unknown as ChainGateway,
      settings(options.settings),
    );
    return { signer, db, prisma, lifecycle, jobs, custody, gateway, handler };
  }
  const rejected = (lifecycle: { fail: jest.Mock }, reason: RegExp) => {
    expect(lifecycle.fail).toHaveBeenCalledTimes(1);
    const [, failure, options] = lifecycle.fail.mock.calls[0] as [
      string,
      ChainTxFailure,
      { from: string[] },
    ];
    expect(failure).toBeInstanceOf(IntentRejected);
    expect(failure.detail).toMatch(reason);
    expect(options.from).toEqual(['PENDING', 'RETRYING']);
  };

  it('no expone ninguna función que reciba una transacción ya construida', () => {
    const methods = Object.getOwnPropertyNames(ChainSigner.prototype).filter(
      (name) => name !== 'constructor',
    );
    // Lo público solo acepta el id de una intención registrada
    expect(methods).toEqual(
      expect.arrayContaining(['process', 'poll', 'kick', 'env']),
    );
    expect(ChainSigner.prototype.process).toHaveLength(1);
    expect(ChainSigner.prototype.poll).toHaveLength(1);
    expect(methods.join(' ')).not.toMatch(/signXdr|signTransaction|submitXdr/i);
  });

  it('con la cadena deshabilitada no toca nada', async () => {
    const { signer, prisma, custody } = build(tx(), {
      settings: { enabled: false },
    });
    expect(await signer.process('id')).toBe('DISABLED');
    expect(await signer.poll('id')).toBe('DISABLED');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(custody.publicKey).not.toHaveBeenCalled();
  });

  it('una intención de un tipo sin manejador o reservado se rechaza sin firmar', async () => {
    for (const kind of ['OPERATOR_TRANSFER', 'REDEEM_BURN']) {
      const { signer, lifecycle, custody, gateway } = build(tx({ kind }));
      expect(await signer.process('id')).toBe('FAILED');
      rejected(lifecycle, /no admitido/);
      expect(custody.sign).not.toHaveBeenCalled();
      expect(gateway.send).not.toHaveBeenCalled();
    }
    const { signer, lifecycle, custody } = build(tx({ kind: 'MINT_BATCH' }), {
      handler: null,
    });
    expect(await signer.process('id')).toBe('FAILED');
    rejected(lifecycle, /MINT_BATCH/);
    expect(custody.sign).not.toHaveBeenCalled();
  });

  it('nada de la red pública, ni intenciones de otra red', async () => {
    const mainnet = build(tx({ network: 'PUBLIC' }), {
      settings: { network: 'PUBLIC' },
    });
    expect(await mainnet.signer.process('id')).toBe('FAILED');
    rejected(mainnet.lifecycle, /red pública/);
    expect(mainnet.custody.sign).not.toHaveBeenCalled();

    const other = build(tx({ network: 'LOCAL' }));
    expect(await other.signer.process('id')).toBe('FAILED');
    rejected(other.lifecycle, /LOCAL/);
  });

  it('si la validación de la intención falla, pasa a FAILED y nunca se firma', async () => {
    const { signer, lifecycle, custody, gateway, db } = build(tx(), {
      handler: {
        validate: jest
          .fn()
          .mockRejectedValue(new IntentRejected('no hay bitácora')),
      },
    });
    expect(await signer.process('id')).toBe('FAILED');
    rejected(lifecycle, /no hay bitácora/);
    expect(db.chainTransaction.update).not.toHaveBeenCalled();
    expect(custody.sign).not.toHaveBeenCalled();
    expect(gateway.simulate).not.toHaveBeenCalled();
    expect(gateway.send).not.toHaveBeenCalled();
  });

  it('una transacción en vuelo por cuenta de origen: la segunda espera su turno', async () => {
    const { signer, db, lifecycle, handler } = build(tx(), { inFlight: 1 });
    expect(await signer.process('id')).toBe('BUSY');
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    expect(db.chainTransaction.count).toHaveBeenCalledWith({
      where: {
        id: { not: 'id' },
        network: 'TESTNET',
        sourceAccount: OPERATIONS,
        status: { in: ['BUILDING', 'SUBMITTED'] },
      },
    });
    expect(handler?.validate).not.toHaveBeenCalled();
    expect(db.chainTransaction.update).not.toHaveBeenCalled();
    expect(lifecycle.fail).not.toHaveBeenCalled();
  });

  it('con Friendbot en curso para la cuenta que paga, también espera', async () => {
    const { signer, db, handler } = build(tx());
    db.chainTransaction.count
      .mockResolvedValueOnce(0) // nada en vuelo
      .mockResolvedValueOnce(1); // FUND_ACCOUNT de operaciones sin terminar
    expect(await signer.process('id')).toBe('BUSY');
    expect(db.chainTransaction.count).toHaveBeenLastCalledWith({
      where: {
        network: 'TESTNET',
        kind: 'FUND_ACCOUNT',
        subjectType: 'PLATFORM',
        subjectId: 'OPERATIONS',
        status: { in: ['PENDING', 'BUILDING', 'SUBMITTED', 'RETRYING'] },
      },
    });
    expect(handler?.validate).not.toHaveBeenCalled();
    expect(db.chainTransaction.update).not.toHaveBeenCalled();
  });

  it('no toma lo que ya está resuelto, abandonado o aún no toca', async () => {
    for (const row of [
      null,
      tx({ status: 'CONFIRMED' }),
      tx({ status: 'SUBMITTED' }),
      tx({ status: 'FAILED' }),
      tx({ abandonedAt: new Date() }),
    ]) {
      const { signer, db } = build(row);
      expect(await signer.process('id')).toBe('SKIPPED');
      expect(db.chainTransaction.update).not.toHaveBeenCalled();
    }
    const { signer, db } = build(
      tx({
        status: 'RETRYING',
        nextAttemptAt: new Date(Date.now() + 60_000),
      }),
    );
    expect(await signer.process('id')).toBe('WAITING');
    expect(db.chainTransaction.update).not.toHaveBeenCalled();
  });

  it('una intención en espera (CHN_MINT_DISABLED) se queda PENDING con su motivo', async () => {
    const { signer, prisma, lifecycle, custody } = build(tx(), {
      handler: {
        validate: jest
          .fn()
          .mockRejectedValue(new IntentOnHold('CHN_MINT_DISABLED')),
      },
    });
    expect(await signer.process('id')).toBe('HELD');
    expect(prisma.chainTransaction.updateMany).toHaveBeenCalledWith({
      where: { id: 'id', status: 'PENDING' },
      data: {
        lastError: {
          code: 'CHN_MINT_DISABLED',
          message: 'La emisión está deshabilitada en este entorno',
          retryable: false,
        },
      },
    });
    expect(lifecycle.fail).not.toHaveBeenCalled();
    expect(custody.sign).not.toHaveBeenCalled();
  });

  it('Friendbot: se confirma sin pedir ninguna firma al custodio', async () => {
    const row = tx({
      kind: 'FUND_ACCOUNT',
      subjectType: 'PLATFORM',
      subjectId: 'OPERATIONS',
    });
    const { signer, custody, gateway, lifecycle, db } = build(row, {
      handler: {
        source: null,
        prepare: jest
          .fn()
          .mockResolvedValue({ type: 'FRIENDBOT', address: OPERATIONS }),
      },
    });
    expect(await signer.process('id')).toBe('CONFIRMED');
    expect(gateway.fund).toHaveBeenCalledWith(OPERATIONS);
    expect(custody.sign).not.toHaveBeenCalled();
    // Sin cuenta de origen no hay secuencia que serializar
    expect(db.chainTransaction.count).not.toHaveBeenCalled();
    expect(lifecycle.confirm).toHaveBeenCalledTimes(1);
  });

  it('si el RPC es de otra red, no se firma nada', async () => {
    const { signer, gateway, lifecycle, custody } = build(tx());
    gateway.networkPassphrase.mockResolvedValue(
      'Public Global Stellar Network ; September 2015',
    );
    expect(await signer.process('id')).toBe('FAILED');
    const [, failure] = lifecycle.fail.mock.calls[0] as [
      string,
      ChainTxFailure,
    ];
    expect(failure.code).toBe('CHN_INTENT_REJECTED');
    expect(custody.sign).not.toHaveBeenCalled();
    expect(gateway.send).not.toHaveBeenCalled();
  });

  it('un fallo de la red al preparar es transitorio: lo decide el ciclo de reintentos', async () => {
    const { signer, lifecycle, jobs } = build(tx(), {
      handler: {
        prepare: jest
          .fn()
          .mockRejectedValue(new ChainTxFailure('CHN_RPC_UNAVAILABLE')),
      },
    });
    lifecycle.fail.mockResolvedValue('RETRYING');
    expect(await signer.process('id')).toBe('RETRYING');
    const [, failure, options] = lifecycle.fail.mock.calls[0] as [
      string,
      ChainTxFailure,
      { from: string[]; unknownOutcome: boolean },
    ];
    expect(failure.code).toBe('CHN_RPC_UNAVAILABLE');
    expect(options).toEqual({ unknownOutcome: false, from: ['BUILDING'] });
    expect(jobs.process).toHaveBeenCalledWith('id', expect.any(Number));
  });

  it('un intento anterior que pudo entrar se consulta por su hash antes de reconstruir', async () => {
    const previous = tx({
      status: 'RETRYING',
      txHash: 'b'.repeat(64),
      maxTime: new Date(Date.now() + 60_000),
      attempts: 1,
    });
    // Aún puede entrar y la red no lo tiene: espera sin gastar intentos
    const waiting = build(previous);
    waiting.gateway.getTransaction.mockResolvedValue({ status: 'NOT_FOUND' });
    expect(await waiting.signer.process('id')).toBe('WAITING');
    expect(waiting.prisma.$transaction).not.toHaveBeenCalled();
    expect(waiting.gateway.send).not.toHaveBeenCalled();
    expect(waiting.jobs.process).toHaveBeenCalledWith('id', expect.any(Number));

    // Entró: se confirma con ese resultado, sin reenviar
    const landed = build(previous);
    landed.gateway.getTransaction.mockResolvedValue({
      status: 'SUCCESS',
      ledger: 10,
      closedAt: new Date(),
      feeChargedStroops: 100n,
      rentFeeStroops: null,
      returnValue: null,
      contractEvents: [],
    });
    expect(await landed.signer.process('id')).toBe('CONFIRMED');
    expect(landed.lifecycle.confirm.mock.calls[0][1]).toEqual(['RETRYING']);
    expect(landed.gateway.send).not.toHaveBeenCalled();
    expect(landed.custody.sign).not.toHaveBeenCalled();

    // La red no responde: tampoco se reconstruye a ciegas
    const down = build(previous);
    down.gateway.getTransaction.mockRejectedValue(
      new ChainTxFailure('CHN_RPC_UNAVAILABLE'),
    );
    expect(await down.signer.process('id')).toBe('WAITING');
    expect(down.gateway.send).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Fallo de un intento: reintento o FAILED (contrato O3 §2.3)', () => {
  function build(row: ChainTransaction, handler: Partial<IntentHandler> = {}) {
    const db = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      chainTransaction: {
        findUnique: jest.fn().mockResolvedValue(row),
        update: jest
          .fn()
          .mockImplementation(({ data }: { data: object }) =>
            Promise.resolve({ ...row, ...data }),
          ),
      },
      chainTxAttempt: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      $transaction: jest.fn((work: (tx: unknown) => unknown) => work(db)),
    };
    const outbox = { add: jest.fn().mockResolvedValue({}) };
    const alerts = { raise: jest.fn().mockResolvedValue(true) };
    const lifecycle = new ChainTxLifecycle(
      prisma as unknown as PrismaService,
      outbox as unknown as OutboxService,
      alerts as unknown as ChainAlertsWriter,
      settings(),
      [{ kind: row.kind, source: 'OPERATIONS', ...handler } as IntentHandler],
    );
    return { lifecycle, db, outbox, alerts };
  }

  it('transitorio con intentos por delante: RETRYING con su espera y su historial', async () => {
    const { lifecycle, db, outbox, alerts } = build(
      tx({ status: 'BUILDING', attempts: 2, maxTime: new Date() }),
    );
    const before = Date.now();
    expect(
      await lifecycle.fail(
        'id',
        new ChainTxFailure('CHN_BAD_SEQUENCE', 'txBadSeq'),
      ),
    ).toBe('RETRYING');
    const { data } = db.chainTransaction.update.mock.calls[0][0] as {
      data: {
        status: string;
        nextAttemptAt: Date;
        lastError: object;
        maxTime: null;
      };
    };
    expect(data.status).toBe('RETRYING');
    // Segundo intento fallido → 30 s
    expect(data.nextAttemptAt.getTime() - before).toBeGreaterThanOrEqual(
      30_000,
    );
    expect(data.nextAttemptAt.getTime() - before).toBeLessThan(31_000);
    expect(data.lastError).toEqual({
      code: 'CHN_BAD_SEQUENCE',
      message: expect.any(String),
      retryable: true,
    });
    // Rechazada por la red: su hash ya no puede entrar
    expect(data.maxTime).toBeNull();
    expect(db.chainTxAttempt.create.mock.calls[0][0].data).toMatchObject({
      attempt: 2,
      status: 'RETRYING',
      errorCode: 'CHN_BAD_SEQUENCE',
      detail: 'txBadSeq',
    });
    expect(alerts.raise).not.toHaveBeenCalled();
    expect(outbox.add).not.toHaveBeenCalled();
  });

  it('con resultado desconocido conserva maxTime para consultar el hash', async () => {
    const { lifecycle, db } = build(
      tx({ status: 'BUILDING', attempts: 1, maxTime: new Date() }),
    );
    await lifecycle.fail('id', new ChainTxFailure('CHN_RPC_UNAVAILABLE'), {
      unknownOutcome: true,
    });
    const { data } = db.chainTransaction.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(data).not.toHaveProperty('maxTime');
  });

  it('agotados los 6 intentos: FAILED, alerta, evento y efectos del manejador', async () => {
    const onFailed = jest.fn().mockResolvedValue(undefined);
    const { lifecycle, db, outbox, alerts } = build(
      tx({ status: 'SUBMITTED', attempts: 6 }),
      { onFailed },
    );
    expect(
      await lifecycle.fail('id', new ChainTxFailure('CHN_TX_TIMEOUT')),
    ).toBe('FAILED');
    expect(db.chainTransaction.update.mock.calls[0][0].data).toMatchObject({
      status: 'FAILED',
      nextAttemptAt: null,
      lastError: { code: 'CHN_TX_TIMEOUT', retryable: false },
    });
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(alerts.raise.mock.calls[0][1]).toMatchObject({
      code: 'TX_FAILED',
      level: 'WARNING',
      subjectType: 'TRANSACTION',
      wineryId: WINERY,
    });
    expect(outbox.add.mock.calls[0][1]).toMatchObject({
      type: 'chain.tx.failed',
      queue: 'chain',
      payload: { kind: 'PAUSE_CONTRACT', errorCode: 'CHN_TX_TIMEOUT' },
    });
  });

  it('definitivos: FAILED al primer intento; autorización e intención, CRITICAL', async () => {
    const cases: [ChainTxFailure, string, string][] = [
      [new ChainTxFailure('CHN_AUTH_FAILED'), 'TX_FAILED', 'CRITICAL'],
      [new IntentRejected('no cuadra'), 'CHN_INTENT_REJECTED', 'CRITICAL'],
      [new ChainTxFailure('CHN_CONTRACT_ERROR'), 'TX_FAILED', 'WARNING'],
      [
        new ChainTxFailure('CHN_INSUFFICIENT_BALANCE'),
        'LOW_BALANCE',
        'WARNING',
      ],
    ];
    for (const [failure, code, level] of cases) {
      const { lifecycle, alerts } = build(
        tx({ status: 'BUILDING', attempts: 1 }),
      );
      expect(await lifecycle.fail('id', failure)).toBe('FAILED');
      expect(alerts.raise.mock.calls[0][1]).toMatchObject({ code, level });
    }
  });

  it('si otra réplica ya la resolvió, no hace nada', async () => {
    const { lifecycle, db } = build(tx({ status: 'CONFIRMED', attempts: 1 }));
    expect(
      await lifecycle.fail('id', new ChainTxFailure('CHN_RPC_UNAVAILABLE')),
    ).toBe('IGNORED');
    expect(db.chainTransaction.update).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Alertas de la cadena: una sola abierta por código y sujeto', () => {
  const input = {
    code: 'LOW_BALANCE',
    level: 'CRITICAL' as const,
    subjectType: 'PLATFORM_ACCOUNT',
    subjectId: 'OPERATIONS',
    message: 'La cuenta de OPERATIONS no existe en la red',
  };
  function build(open: { id: string } | null) {
    const calls: string[] = [];
    const db = {
      $executeRaw: jest.fn(() => {
        calls.push('lock');
        return Promise.resolve(1);
      }),
      chainAlert: {
        findFirst: jest.fn(() => {
          calls.push('find');
          return Promise.resolve(open);
        }),
        create: jest.fn(({ data }: { data: object }) => {
          calls.push('create');
          return Promise.resolve({ id: 'alert-1', wineryId: null, ...data });
        }),
      },
    };
    const outbox = { add: jest.fn().mockResolvedValue({}) };
    const writer = new ChainAlertsWriter(outbox as unknown as OutboxService);
    return { writer, db, outbox, calls };
  }

  it('toma un candado por alerta antes de mirar si ya existe (dos procesos a la vez)', async () => {
    const { writer, db, outbox, calls } = build(null);
    expect(await writer.raise(asDb(db), input)).toBe(true);
    expect(calls).toEqual(['lock', 'find', 'create']);
    expect(outbox.add.mock.calls[0][1]).toMatchObject({
      type: 'chain.alert.raised',
      payload: { alertId: 'alert-1', code: 'LOW_BALANCE', level: 'CRITICAL' },
    });
  });

  it('con una abierta igual no crea otra ni publica nada', async () => {
    const { writer, db, outbox, calls } = build({ id: 'ya-abierta' });
    expect(await writer.raise(asDb(db), input)).toBe(false);
    expect(calls).toEqual(['lock', 'find']);
    expect(outbox.add).not.toHaveBeenCalled();
  });
});
