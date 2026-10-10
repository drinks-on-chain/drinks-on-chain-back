import type { ChainTransaction, DossierAnchor } from '@prisma/client';
import { Memo, Operation } from '@stellar/stellar-sdk';
import {
  applyAnchorConfirmed,
  redeemWindowDays,
} from '../anchor/anchor-effects';
import {
  anchorStatus,
  toDossierAnchor,
  toPublicDossierAnchor,
  verificationChecks,
} from '../anchor/anchor-view';
import { intentKeys } from '../chain.constants';
import { memoHashFromHex } from '../explorer';
import { AnchorDossierHandler } from '../jobs/handlers/anchor-dossier.handler';
import { IntentRejected } from '../tx/chain-tx.errors';

const HASH = 'ab'.repeat(32);
const ANCHOR_ACCOUNT =
  'GA7IRIRKT5YN5RKGY7B46VPMUICIIUJXBRCOS7TNQ4BPXVRMLM3ZDJBY';
const OTHER_ACCOUNT =
  'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI';
const TX_HASH = 'cd'.repeat(32);
const EXPLORER = 'https://stellar.expert/explorer/testnet';
const LOT = '11111111-1111-4111-8111-111111111111';
const WINERY = '22222222-2222-4222-8222-222222222222';

const anchorRow = (over: Partial<DossierAnchor> = {}): DossierAnchor => ({
  id: 'anchor-1',
  lotId: LOT,
  status: 'ANCHORED',
  network: 'TESTNET',
  account: ANCHOR_ACCOUNT,
  memoHashHex: HASH,
  txHash: TX_HASH,
  ledger: 1234,
  anchoredAt: new Date('2026-10-09T12:00:00Z'),
  verifiedAt: new Date('2026-10-09T12:00:02Z'),
  transactionId: 'tx-1',
  createdAt: new Date('2026-10-09T11:59:00Z'),
  updatedAt: new Date('2026-10-09T12:00:02Z'),
  ...over,
});

const txRow = (over: Partial<ChainTransaction> = {}): ChainTransaction =>
  ({
    id: 'tx-1',
    kind: 'ANCHOR_DOSSIER',
    status: 'CONFIRMED',
    network: 'TESTNET',
    intentKey: intentKeys.anchor(LOT),
    subjectType: 'LOT',
    subjectId: LOT,
    wineryId: WINERY,
    intent: { lotId: LOT, memoHashHex: HASH },
    txHash: TX_HASH,
    ledger: 1234,
    confirmedAt: new Date('2026-10-09T12:00:00Z'),
    attempts: 1,
    lastError: null,
    createdAt: new Date('2026-10-09T11:59:00Z'),
    updatedAt: new Date('2026-10-09T12:00:00Z'),
    ...over,
  }) as ChainTransaction;

describe('Memo del anclaje (§7.1)', () => {
  it('hex ↔ 32 bytes ↔ base64, y es un MEMO_HASH válido', () => {
    const memo = memoHashFromHex(HASH.toUpperCase());
    expect(memo.hex).toBe(HASH);
    expect(memo.bytes).toHaveLength(32);
    expect(Buffer.from(memo.base64, 'base64').toString('hex')).toBe(HASH);
    const built = Memo.hash(memo.hex);
    expect(built.type).toBe('hash');
    expect(Buffer.from(built.value as Buffer).toString('hex')).toBe(HASH);
    expect(() => memoHashFromHex('abc')).toThrow(RangeError);
  });
});

describe('Vista del anclaje (§7.1, §7.3)', () => {
  it('SUBMITTED es la fila pendiente con su transacción ya enviada', () => {
    const pending = anchorRow({ status: 'PENDING', txHash: null });
    expect(
      anchorStatus({ ...pending, transaction: txRow({ status: 'PENDING' }) }),
    ).toBe('PENDING');
    expect(
      anchorStatus({ ...pending, transaction: txRow({ status: 'SUBMITTED' }) }),
    ).toBe('SUBMITTED');
    expect(anchorStatus({ ...anchorRow(), transaction: txRow() })).toBe(
      'ANCHORED',
    );
  });

  it('DossierAnchor para el ERP: enlace al explorador construido en el backend', () => {
    expect(toDossierAnchor(null, EXPLORER)).toBeNull();
    expect(
      toDossierAnchor({ ...anchorRow(), transaction: null }, EXPLORER),
    ).toBeNull();
    expect(
      toDossierAnchor({ ...anchorRow(), transaction: txRow() }, EXPLORER),
    ).toMatchObject({
      status: 'ANCHORED',
      account: ANCHOR_ACCOUNT,
      memoHashHex: HASH,
      memoHashBase64: Buffer.from(HASH, 'hex').toString('base64'),
      txHash: TX_HASH,
      explorerUrl: `${EXPLORER}/tx/${TX_HASH}`,
      verifiedAt: '2026-10-09T12:00:02.000Z',
      transaction: { kind: 'ANCHOR_DOSSIER', status: 'CONFIRMED' },
    });
  });

  it('en público solo hay PENDING o ANCHORED: FAILED y lo no verificado se publican como PENDING, sin transacción (S-17)', () => {
    expect(toPublicDossierAnchor(null, EXPLORER)).toBeNull();
    expect(toPublicDossierAnchor(anchorRow(), EXPLORER)).toEqual({
      status: 'ANCHORED',
      network: 'TESTNET',
      account: ANCHOR_ACCOUNT,
      memoHashHex: HASH,
      memoHashBase64: Buffer.from(HASH, 'hex').toString('base64'),
      txHash: TX_HASH,
      ledger: 1234,
      anchoredAt: '2026-10-09T12:00:00.000Z',
      explorerUrl: `${EXPLORER}/tx/${TX_HASH}`,
    });
    for (const row of [
      anchorRow({ status: 'FAILED' }),
      anchorRow({ status: 'PENDING', txHash: null }),
      // Confirmado pero sin la lectura de vuelta: no se enseña como anclado
      anchorRow({ status: 'ANCHORED', verifiedAt: null }),
    ]) {
      expect(toPublicDossierAnchor(row, EXPLORER)).toMatchObject({
        status: 'PENDING',
        txHash: null,
        ledger: null,
        anchoredAt: null,
        explorerUrl: null,
        memoHashHex: HASH,
      });
    }
  });

  it('las cuatro comprobaciones, en orden y con null cuando aún no aplican', () => {
    const passes = (input: Parameters<typeof verificationChecks>[0]) =>
      verificationChecks(input).map((c) => [c.key, c.pass]);
    expect(
      passes({
        dossierHash: null,
        anchor: null,
        officialAnchorAccount: ANCHOR_ACCOUNT,
      }),
    ).toEqual([
      ['DOSSIER_CLOSED', false],
      ['ANCHOR_CONFIRMED', null],
      ['MEMO_MATCHES_HASH', null],
      ['ANCHOR_ACCOUNT_OFFICIAL', null],
    ]);
    expect(
      passes({
        dossierHash: HASH,
        anchor: anchorRow({ status: 'FAILED' }),
        officialAnchorAccount: ANCHOR_ACCOUNT,
      }),
    ).toEqual([
      ['DOSSIER_CLOSED', true],
      ['ANCHOR_CONFIRMED', false],
      ['MEMO_MATCHES_HASH', null],
      ['ANCHOR_ACCOUNT_OFFICIAL', null],
    ]);
    expect(
      passes({
        dossierHash: HASH,
        anchor: anchorRow(),
        officialAnchorAccount: ANCHOR_ACCOUNT,
      }),
    ).toEqual([
      ['DOSSIER_CLOSED', true],
      ['ANCHOR_CONFIRMED', true],
      ['MEMO_MATCHES_HASH', true],
      ['ANCHOR_ACCOUNT_OFFICIAL', true],
    ]);
    // Memo de otro expediente o cuenta que no es la oficial: en rojo
    expect(
      passes({
        dossierHash: 'ef'.repeat(32),
        anchor: anchorRow(),
        officialAnchorAccount: OTHER_ACCOUNT,
      }),
    ).toEqual([
      ['DOSSIER_CLOSED', true],
      ['ANCHOR_CONFIRMED', true],
      ['MEMO_MATCHES_HASH', false],
      ['ANCHOR_ACCOUNT_OFFICIAL', false],
    ]);
    for (const check of verificationChecks({
      dossierHash: HASH,
      anchor: null,
      officialAnchorAccount: null,
    })) {
      expect(check.message.length).toBeGreaterThan(10);
    }
  });
});

describe('ANCHOR_DOSSIER (§2.2, §7.1)', () => {
  const env = (anchorAddress = ANCHOR_ACCOUNT, sequence = '41') =>
    ({
      keys: { publicKey: jest.fn().mockResolvedValue(anchorAddress) },
      gateway: {
        loadAccount: jest
          .fn()
          .mockResolvedValue({ sequenceNumber: () => sequence }),
      },
    }) as never;

  const db = (dossier: unknown) => ({
    $queryRaw: jest.fn().mockResolvedValue([]),
    lotDossier: { findUnique: jest.fn().mockResolvedValue(dossier) },
    dossierAnchor: { update: jest.fn() },
  });
  const closed = (
    anchor: Partial<DossierAnchor> | null = { status: 'PENDING' },
  ) => ({
    lotId: LOT,
    status: 'CLOSED',
    hash: HASH,
    lot: { wineryId: WINERY },
    anchor: anchor ? anchorRow(anchor) : null,
  });
  const handler = (prisma: unknown = {}) =>
    new AnchorDossierHandler(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
    );

  it('origina y firma la cuenta de anclaje, no la de operaciones', () => {
    expect(handler().source).toBe('ANCHOR');
    expect(handler().kind).toBe('ANCHOR_DOSSIER');
  });

  it('valida: expediente cerrado, memo = huella, sin anclaje confirmado y cuenta oficial', async () => {
    const plan = await handler().validate(
      db(closed()) as never,
      txRow({ status: 'PENDING' }),
      env(),
    );
    expect(plan).toEqual({
      lotId: LOT,
      memoHashHex: HASH,
      anchorAddress: ANCHOR_ACCOUNT,
    });
  });

  it.each([
    ['expediente abierto', { ...closed(), status: 'OPEN' }, txRow()],
    ['expediente inexistente', null, txRow()],
    ['lote de otra bodega', closed(), txRow({ wineryId: 'otra' })],
    [
      'memo distinto de la huella',
      closed(),
      txRow({ intent: { lotId: LOT, memoHashHex: 'ef'.repeat(32) } }),
    ],
    ['sin fila de anclaje', closed(null), txRow()],
    ['anclaje ya confirmado', closed({ status: 'ANCHORED' }), txRow()],
    [
      'cuenta que no es la oficial',
      closed({ status: 'PENDING', account: OTHER_ACCOUNT }),
      txRow(),
    ],
    ['clave de otra intención', closed(), txRow({ intentKey: 'anchor:otro' })],
    ['sujeto que no es un lote', closed(), txRow({ subjectType: 'MINT' })],
  ])('rechaza sin firmar: %s', async (_case, dossier, transaction) => {
    await expect(
      handler().validate(db(dossier) as never, transaction, env()),
    ).rejects.toBeInstanceOf(IntentRejected);
  });

  it('un reintento tras FAILED devuelve el anclaje a PENDING', async () => {
    const client = db(closed({ status: 'FAILED' }));
    await handler().validate(client as never, txRow(), env());
    expect(client.dossierAnchor.update).toHaveBeenCalledWith({
      where: { id: 'anchor-1' },
      data: { status: 'PENDING' },
    });
  });

  it('prepara una transacción clásica con bumpSequence a la secuencia actual y el memo', async () => {
    const prepared = await handler().prepare(
      { lotId: LOT, memoHashHex: HASH, anchorAddress: ANCHOR_ACCOUNT },
      txRow(),
      env(ANCHOR_ACCOUNT, '41'),
    );
    if (prepared.type !== 'CLASSIC') throw new Error('debe ser clásica');
    expect(prepared.memoHashHex).toBe(HASH);
    expect(prepared.extraSigners).toEqual([]);
    expect(prepared.operations).toHaveLength(1);
    expect(prepared.operations[0].toXDR('base64')).toBe(
      Operation.bumpSequence({ bumpTo: '41' }).toXDR('base64'),
    );
  });

  it('lectura de vuelta: solo cuadra con el memo y la cuenta de origen esperados', async () => {
    const prisma = {
      lotDossier: { findUnique: jest.fn().mockResolvedValue({ hash: HASH }) },
    };
    const verify = (lookup: unknown) =>
      handler(prisma).verify(txRow(), env(), lookup as never);
    expect(
      await verify({ memoHashHex: HASH, sourceAccount: ANCHOR_ACCOUNT }),
    ).toMatchObject({ ok: true });
    expect(
      await verify({
        memoHashHex: 'ef'.repeat(32),
        sourceAccount: ANCHOR_ACCOUNT,
      }),
    ).toMatchObject({ ok: false, expectedMemoHashHex: HASH });
    expect(
      await verify({ memoHashHex: HASH, sourceAccount: OTHER_ACCOUNT }),
    ).toMatchObject({ ok: false, officialAccount: ANCHOR_ACCOUNT });
    expect(
      await verify({ memoHashHex: null, sourceAccount: null }),
    ).toMatchObject({ ok: false });
    expect(await verify(null)).toMatchObject({ ok: false });
  });
});

describe('Efectos del anclaje (§7.2)', () => {
  it('si la lectura de vuelta no cuadra: alerta CRITICAL, anclaje FAILED y el lote no cambia', async () => {
    const client = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: LOT }]),
      dossierAnchor: {
        findUnique: jest
          .fn()
          .mockResolvedValue(anchorRow({ status: 'PENDING' })),
        update: jest.fn(),
      },
      lot: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: LOT,
          wineryId: WINERY,
          stage: 'CERTIFIED',
          lotCode: 'CVJ-2026-SINGANI-004',
          collection: null,
        }),
        update: jest.fn(),
      },
      bottlingBatch: { updateMany: jest.fn() },
    };
    const deps = {
      audit: { record: jest.fn() },
      outbox: { add: jest.fn() },
      alerts: { raise: jest.fn().mockResolvedValue(true) },
    };
    const result = await applyAnchorConfirmed(
      client as never,
      deps as never,
      txRow(),
      {
        ok: false,
        expectedMemoHashHex: HASH,
        memoHashHex: 'ef'.repeat(32),
        officialAccount: ANCHOR_ACCOUNT,
        sourceAccount: ANCHOR_ACCOUNT,
      },
    );
    expect(result).toBe('MISMATCH');
    expect(deps.alerts.raise).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        code: 'ANCHOR_MISMATCH',
        level: 'CRITICAL',
        subjectType: 'LOT',
        subjectId: LOT,
      }),
    );
    expect(client.dossierAnchor.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED' }),
      }),
    );
    // Nada se da por anclado
    expect(client.lot.update).not.toHaveBeenCalled();
    expect(client.bottlingBatch.updateMany).not.toHaveBeenCalled();
    expect(deps.outbox.add).not.toHaveBeenCalled();
    expect(deps.audit.record).not.toHaveBeenCalled();
  });

  it('ventana de canje: ajuste de la bodega, estándar general o el valor por defecto (S-16)', async () => {
    const client = (override: unknown, global: unknown) =>
      ({
        settingOverride: {
          findUnique: jest
            .fn()
            .mockResolvedValue(
              override === undefined ? null : { value: override },
            ),
        },
        settingGlobalValue: {
          findUnique: jest
            .fn()
            .mockResolvedValue(global === undefined ? null : { value: global }),
        },
      }) as never;
    expect(await redeemWindowDays(client(45, 60), WINERY)).toBe(45);
    expect(await redeemWindowDays(client(undefined, 60), WINERY)).toBe(60);
    expect(await redeemWindowDays(client(undefined, undefined), WINERY)).toBe(
      30,
    );
    expect(await redeemWindowDays(client('mal', null), WINERY)).toBe(30);
  });
});
