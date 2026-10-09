import type { ChainTransaction } from '@prisma/client';
import {
  IntentNotReady,
  IntentOnHold,
  IntentRejected,
} from '@modules/chain/tx/chain-tx.errors';
import { deriveLotStage } from '@modules/lots/domain/lot-stage';
import {
  MAX_STORED_TOKEN_ID,
  applyMintChunkConfirmed,
  applyMintChunkFailed,
  mintIntentParams,
  mintRangeMismatch,
  validateMintChunk,
  type MintVerification,
} from '../mint-effects';

const MINT = '11111111-1111-4111-8111-111111111111';
const COLLECTION = '22222222-2222-4222-8222-222222222222';
const CONTRACT = '33333333-3333-4333-8333-333333333333';
const WINERY = '44444444-4444-4444-8444-444444444444';
const LOT = '55555555-5555-4555-8555-555555555555';
const ACCOUNT = 'GA7IRIRKT5YN5RKGY7B46VPMUICIIUJXBRCOS7TNQ4BPXVRMLM3ZDJBY';
const ADDRESS = 'CDQX4AKGU76O7GH7F6SXPWGQ7YAVQTYPUYCSER67PWHJA3M7GIF6LACH';
const LOT_REF = 'CVJ-L2026-004';

const tx = (
  intent: Record<string, unknown> = {},
  over: Partial<ChainTransaction> = {},
): ChainTransaction =>
  ({
    id: 'tx-1',
    kind: 'MINT_BATCH',
    status: 'PENDING',
    network: 'LOCAL',
    intentKey: `mint:${MINT}:1`,
    subjectType: 'MINT',
    subjectId: MINT,
    wineryId: WINERY,
    txHash: 'ab'.repeat(32),
    confirmedAt: new Date('2026-10-09T12:00:00Z'),
    intent: {
      mintId: MINT,
      collectionId: COLLECTION,
      contractId: CONTRACT,
      chunkIndex: 1,
      amount: 100,
      firstBottleNumber: 1,
      lastBottleNumber: 100,
      ...intent,
    },
    ...over,
  }) as ChainTransaction;

const event = (over: Partial<NonNullable<MintVerification['event']>> = {}) => ({
  lot: LOT_REF,
  to: ACCOUNT,
  minter: ACCOUNT,
  firstTokenId: 0,
  lastTokenId: 99,
  ...over,
});

/** Base simulada con lo mínimo que lee la validación de §2.2. */
function database(
  over: {
    mint?: Record<string, unknown>;
    collection?: Record<string, unknown>;
    contract?: Record<string, unknown>;
    account?: Record<string, unknown>;
    request?: Record<string, unknown>;
    earlier?: { quantity: number; status: string }[];
    lot?: Record<string, unknown> | null;
  } = {},
) {
  const account = {
    address: ACCOUNT,
    custodyKeyRef: `winery-${WINERY}`,
    status: 'ACTIVE',
    ...over.account,
  };
  const contract = {
    id: CONTRACT,
    status: 'ACTIVE',
    address: ADDRESS,
    network: 'LOCAL',
    wineryId: WINERY,
    paused: false,
    chainAccount: account,
    ...over.contract,
  };
  const collection = {
    id: COLLECTION,
    wineryId: WINERY,
    lotId: LOT,
    quota: 100,
    minted: 0,
    status: 'MINTING',
    contract,
    ...over.collection,
  };
  const mint = {
    id: MINT,
    collectionId: COLLECTION,
    sequence: 1,
    quantity: 100,
    status: 'PENDING',
    lotArg: LOT_REF,
    ranges: [],
    request: { status: 'APPROVED', ...over.request },
    collection,
    ...over.mint,
  };
  const lot =
    over.lot === null
      ? null
      : {
          id: LOT,
          wineryId: WINERY,
          reference: LOT_REF,
          name: 'Singani',
          lotCode: null,
          harvestYear: 2026,
          stage: 'ORIGIN',
          productType: 'SINGANI',
          estimatedBottles: 3000,
          bottlingBatch: null,
          collection: null,
          tokenizationRequests: [],
          _count: { bottleUnits: 0 },
          ...over.lot,
        };
  return {
    $queryRaw: jest.fn().mockResolvedValue([]),
    mint: {
      findUnique: jest.fn().mockResolvedValue({ collectionId: COLLECTION }),
      findUniqueOrThrow: jest.fn().mockResolvedValue(mint),
      findMany: jest.fn().mockResolvedValue(over.earlier ?? []),
      update: jest.fn(),
    },
    collection: { update: jest.fn() },
    lot: { findFirst: jest.fn().mockResolvedValue(lot) },
  };
}

describe('MINT_BATCH · parámetros de la intención', () => {
  it('acepta un trozo cuya clave es mint:{mintId}:{trozo}', () => {
    expect(mintIntentParams(tx())).toMatchObject({
      mintId: MINT,
      chunkIndex: 1,
      amount: 100,
    });
  });

  it.each([
    ['otra clave', tx({}, { intentKey: `mint:${MINT}:2` })],
    ['otro sujeto', tx({}, { subjectId: 'otro' })],
    ['sujeto que no es una emisión', tx({}, { subjectType: 'LOT' })],
    ['cantidad no entera', tx({ amount: 1.5 })],
    ['cantidad cero', tx({ amount: 0 })],
    ['sin colección', tx({ collectionId: undefined })],
  ])('rechaza: %s', (_case, transaction) => {
    expect(() => mintIntentParams(transaction)).toThrow(IntentRejected);
  });
});

describe('MINT_BATCH · validación antes de firmar (§2.2)', () => {
  const validate = (
    db: ReturnType<typeof database>,
    transaction = tx(),
    mintEnabled = true,
  ) => validateMintChunk(db as never, transaction, { mintEnabled });

  it('válida: bloquea las filas, deja la emisión IN_PROGRESS y devuelve el plan', async () => {
    const db = database();
    const plan = await validate(db);
    expect(plan).toEqual({
      mintId: MINT,
      collectionId: COLLECTION,
      wineryId: WINERY,
      lotId: LOT,
      chunk: {
        index: 1,
        amount: 100,
        firstBottleNumber: 1,
        lastBottleNumber: 100,
      },
      lotArg: LOT_REF,
      contract: { id: CONTRACT, address: ADDRESS },
      account: { address: ACCOUNT, custodyKeyRef: `winery-${WINERY}` },
    });
    expect(db.$queryRaw).toHaveBeenCalledTimes(2); // emisión y colección
    expect(db.mint.update).toHaveBeenCalledWith({
      where: { id: MINT },
      data: { status: 'IN_PROGRESS' },
    });
    expect(db.collection.update).toHaveBeenCalledWith({
      where: { id: COLLECTION },
      data: { mintStatus: 'IN_PROGRESS' },
    });
  });

  it('un reintento tras FAILED vuelve a validar y a IN_PROGRESS', async () => {
    const db = database({ mint: { status: 'FAILED' } });
    await expect(validate(db)).resolves.toMatchObject({ mintId: MINT });
    expect(db.mint.update).toHaveBeenCalled();
  });

  it.each([
    ['emisión ya confirmada', { mint: { status: 'CONFIRMED' } }],
    ['solicitud no aprobada', { request: { status: 'IN_REVIEW' } }],
    ['colección de otra bodega', { collection: { wineryId: 'otra' } }],
    ['rebasa la cuota', { collection: { quota: 99 } }],
    ['números de botella no continuos', { collection: { minted: 5 } }],
    ['cuota mayor que la estimación', { lot: { estimatedBottles: 80 } }],
    ['lote sin estimación', { lot: { estimatedBottles: null } }],
    [
      'cuota mayor que las botellas del lote embotellado',
      { lot: { bottlingBatch: { id: 'b' }, _count: { bottleUnits: 80 } } },
    ],
    ['contrato pausado', { contract: { paused: true } }],
    ['identidad pausada', { account: { status: 'PAUSED' } }],
    ['contrato no vigente', { contract: { status: 'FAILED' } }],
    ['contrato de otra red', { contract: { network: 'TESTNET' } }],
    ['lote inexistente', { lot: null }],
  ])('rechaza sin firmar: %s', async (_case, over) => {
    const db = database(over as Parameters<typeof database>[0]);
    await expect(validate(db)).rejects.toBeInstanceOf(IntentRejected);
    expect(db.mint.update).not.toHaveBeenCalled();
  });

  it('rechaza un trozo que no es el de la emisión aprobada o que ya se confirmó', async () => {
    await expect(
      validate(database(), tx({ amount: 99, lastBottleNumber: 99 })),
    ).rejects.toBeInstanceOf(IntentRejected);
    const confirmed = database({
      mint: {
        status: 'IN_PROGRESS',
        ranges: [
          {
            firstTokenId: 0,
            lastTokenId: 99,
            firstBottleNumber: 1,
            lastBottleNumber: 100,
          },
        ],
      },
    });
    await expect(validate(confirmed)).rejects.toBeInstanceOf(IntentRejected);
  });

  it('el segundo trozo espera al primero, y una ampliación a la emisión anterior', async () => {
    const twoChunks = database({
      mint: { quantity: 32_001 },
      collection: { quota: 32_001 },
      lot: { estimatedBottles: 40_000 },
    });
    await expect(
      validate(
        twoChunks,
        tx(
          {
            chunkIndex: 2,
            amount: 1,
            firstBottleNumber: 32_001,
            lastBottleNumber: 32_001,
          },
          { intentKey: `mint:${MINT}:2` },
        ),
      ),
    ).rejects.toBeInstanceOf(IntentNotReady);
    const increase = database({
      mint: { sequence: 2, quantity: 50 },
      collection: { quota: 150, minted: 100 },
      earlier: [{ quantity: 100, status: 'IN_PROGRESS' }],
    });
    await expect(
      validate(
        increase,
        tx({ amount: 50, firstBottleNumber: 101, lastBottleNumber: 150 }),
      ),
    ).rejects.toBeInstanceOf(IntentNotReady);
  });

  it('una ampliación continúa los números de botella de la emisión anterior', async () => {
    const increase = database({
      mint: { sequence: 2, quantity: 50 },
      collection: { quota: 150, minted: 100, status: 'PUBLISHED' },
      earlier: [{ quantity: 100, status: 'CONFIRMED' }],
    });
    const plan = await validate(
      increase,
      tx({ amount: 50, firstBottleNumber: 101, lastBottleNumber: 150 }),
    );
    expect(plan.chunk).toEqual({
      index: 1,
      amount: 50,
      firstBottleNumber: 101,
      lastBottleNumber: 150,
    });
  });

  it('CHAIN_MINT_ENABLED apagado: válida pero en espera (CHN_MINT_DISABLED), sin tocar la emisión', async () => {
    const db = database();
    const held = validate(db, tx(), false);
    await expect(held).rejects.toBeInstanceOf(IntentOnHold);
    await expect(held).rejects.toMatchObject({ code: 'CHN_MINT_DISABLED' });
    expect(db.mint.update).not.toHaveBeenCalled();
    // Una intención inválida se rechaza aunque la emisión esté apagada
    await expect(
      validate(database({ contract: { paused: true } }), tx(), false),
    ).rejects.toBeInstanceOf(IntentRejected);
  });
});

describe('MINT_BATCH · rango de la emisión confirmada (§6.1)', () => {
  const expected = { amount: 100, lotArg: LOT_REF, toAddress: ACCOUNT };

  it('cuadra cuando el valor devuelto es el último id del evento y el rango mide lo emitido', () => {
    expect(
      mintRangeMismatch({ returnValue: 99, event: event() }, expected),
    ).toBeNull();
    expect(
      mintRangeMismatch(
        {
          returnValue: 149,
          event: event({ firstTokenId: 50, lastTokenId: 149 }),
        },
        expected,
      ),
    ).toBeNull();
  });

  it.each([
    ['sin evento', { returnValue: 99, event: null }],
    ['sin valor devuelto', { returnValue: null, event: event() }],
    ['valor devuelto ≠ último id', { returnValue: 98, event: event() }],
    [
      'rango de otro tamaño',
      { returnValue: 98, event: event({ lastTokenId: 98 }) },
    ],
    ['otro lote', { returnValue: 99, event: event({ lot: 'CVJ-L2026-005' }) }],
    ['otro destino', { returnValue: 99, event: event({ to: 'GOTRA' }) }],
    ['otro emisor', { returnValue: 99, event: event({ minter: 'GOTRA' }) }],
    [
      'id que no cabe en int4',
      {
        returnValue: MAX_STORED_TOKEN_ID + 1,
        event: event({
          firstTokenId: MAX_STORED_TOKEN_ID - 98,
          lastTokenId: MAX_STORED_TOKEN_ID + 1,
        }),
      },
    ],
  ])('no cuadra: %s', (_case, verification) => {
    expect(mintRangeMismatch(verification, expected)).toEqual(
      expect.any(String),
    );
  });

  it('si no cuadra: alerta CRITICAL, emisión FAILED y ningún NFT ni publicación', async () => {
    const db = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest.fn(),
      mint: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: MINT,
          quantity: 100,
          sequence: 1,
          lotArg: LOT_REF,
          ranges: [],
          request: { publishOnMint: true, kind: 'INITIAL' },
          collection: {
            id: COLLECTION,
            wineryId: WINERY,
            lotId: LOT,
            status: 'MINTING',
            minted: 0,
            pendingMintQuantity: 100,
            contract: { id: CONTRACT, chainAccount: { address: ACCOUNT } },
            images: [],
            lot: { name: 'Singani', reference: LOT_REF, stage: 'ORIGIN' },
            winery: { certificationStatus: 'ACTIVE' },
          },
        }),
        update: jest.fn(),
      },
      collection: { update: jest.fn() },
    };
    const deps = {
      audit: { record: jest.fn() },
      mail: { enqueue: jest.fn() },
      outbox: { add: jest.fn() },
      alerts: { raise: jest.fn().mockResolvedValue(true) },
      erpUrl: 'https://erp.example.test',
      explorerBaseUrl: null,
    };
    const result = await applyMintChunkConfirmed(
      db as never,
      deps as never,
      tx({}, { status: 'CONFIRMED' }),
      { returnValue: 98, event: event() },
    );
    expect(result).toBe('MISMATCH');
    expect(deps.alerts.raise).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        code: 'MINT_RANGE_MISMATCH',
        level: 'CRITICAL',
        subjectType: 'MINT',
        subjectId: MINT,
      }),
    );
    expect(db.mint.update).toHaveBeenCalledWith({
      where: { id: MINT },
      data: { status: 'FAILED' },
    });
    expect(db.collection.update).toHaveBeenCalledWith({
      where: { id: COLLECTION },
      data: { mintStatus: 'FAILED' },
    });
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(deps.outbox.add).not.toHaveBeenCalled();
    expect(deps.mail.enqueue).not.toHaveBeenCalled();
    expect(deps.audit.record).not.toHaveBeenCalled();
  });

  it('una transacción FAILED deja la emisión y la colección en FAILED (salvo si ya se confirmó)', async () => {
    const db = (status: string) => ({
      mint: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: MINT, status, collectionId: COLLECTION }),
        update: jest.fn(),
      },
      collection: { update: jest.fn() },
    });
    const open = db('IN_PROGRESS');
    await applyMintChunkFailed(open as never, tx(), {} as never);
    expect(open.mint.update).toHaveBeenCalledWith({
      where: { id: MINT },
      data: { status: 'FAILED' },
    });
    expect(open.collection.update).toHaveBeenCalledWith({
      where: { id: COLLECTION },
      data: { mintStatus: 'FAILED' },
    });
    const done = db('CONFIRMED');
    await applyMintChunkFailed(done as never, tx(), {} as never);
    expect(done.mint.update).not.toHaveBeenCalled();
  });
});

describe('Etapa del lote con el anclaje (§7.2)', () => {
  const base = {
    discarded: false,
    dossierClosed: true,
    productType: 'SINGANI' as const,
    harvestStatuses: ['APPROVED'],
    tanks: [],
    agings: [],
    distillations: [],
    bottled: true,
  };

  it('expediente cerrado: CERTIFIED hasta que se ancla, luego ANCHORED', () => {
    expect(deriveLotStage(base)).toBe('CERTIFIED');
    expect(deriveLotStage({ ...base, anchored: false })).toBe('CERTIFIED');
    expect(deriveLotStage({ ...base, anchored: true })).toBe('ANCHORED');
    // Sin expediente cerrado el anclaje no cuenta
    expect(
      deriveLotStage({ ...base, dossierClosed: false, anchored: true }),
    ).toBe('BOTTLED');
  });
});
