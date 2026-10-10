import type { ChainTransaction } from '@prisma/client';
import { IntentRejected } from '@modules/chain/tx/chain-tx.errors';
import {
  closureCounts,
  closureSettled,
  planShortfall,
  shortfallOrder,
  type ClosureToken,
} from '../closure/closure.domain';
import { toClosureSummary } from '../closure/closure-view';
import {
  burnIntentParams,
  validateBurnUnsold,
} from '../closure/closure-writes';
import { O3_STEP_3_6_ROUTES } from '../o3-implemented-routes';

const token = (
  bottleNumber: number,
  status = 'MINTED',
  soldAt: string | null = null,
): ClosureToken => ({
  id: `t-${bottleNumber}`,
  tokenId: bottleNumber - 1,
  bottleNumber,
  status,
  soldAt: soldAt ? new Date(soldAt) : null,
});

const minted = (count: number): ClosureToken[] =>
  Array.from({ length: count }, (_, i) => token(i + 1));

describe('Cierre del lote con faltante · cifras (contrato O3 §8.4)', () => {
  it('cuenta por estado: no vendidos, reservados, vendidos y quemados', () => {
    const tokens = [
      token(1),
      token(2),
      token(3, 'RESERVED'),
      token(4, 'SOLD'),
      token(5, 'REDEEMABLE'),
      token(6, 'PASS_ACTIVE'),
      token(7, 'BURNED'),
    ];
    expect(closureCounts(7, tokens)).toEqual({
      minted: 7,
      burned: 1,
      sold: 3,
      reserved: 1,
      unsold: 2,
      alive: 6,
    });
  });

  it('autorizar 100 y embotellar 80: faltan 20 y se van los 20 números más altos sin vender', () => {
    const plan = planShortfall({
      bottles: 80,
      minted: 100,
      tokens: minted(100),
      itemTokenIds: new Set(),
    });
    expect(plan).toMatchObject({
      need: 20,
      extra: 20,
      addedUnsold: 20,
      addedSold: 0,
    });
    expect(plan.added.map((t) => t.bottleNumber)).toEqual(
      Array.from({ length: 20 }, (_, i) => 100 - i),
    );
  });

  it('más botellas que NFT, o las mismas: sin faltante', () => {
    for (const bottles of [100, 2_950]) {
      expect(
        planShortfall({
          bottles,
          minted: 100,
          tokens: minted(100),
          itemTokenIds: new Set(),
        }),
      ).toMatchObject({ need: 0, extra: 0, added: [] });
    }
  });

  it('lote descartado (0 botellas): todos los NFT vivos pierden su botella', () => {
    const plan = planShortfall({
      bottles: 0,
      minted: 5,
      tokens: [...minted(4), token(5, 'BURNED')],
      itemTokenIds: new Set(),
    });
    expect(plan.need).toBe(4);
    expect(plan.added.map((t) => t.bottleNumber)).toEqual([4, 3, 2, 1]);
  });

  it('orden de S-23 y A-30: no vendidos, reservados y, de los vendidos, el pedido más reciente', () => {
    const tokens = [
      token(1, 'SOLD', '2026-10-01T10:00:00Z'),
      token(2, 'SOLD', '2026-10-05T10:00:00Z'),
      token(3, 'REDEEMABLE', '2026-10-03T10:00:00Z'),
      token(4, 'RESERVED'),
      token(5),
      token(6),
      token(7, 'BURNED'),
    ];
    expect(shortfallOrder(tokens).map((t) => t.bottleNumber)).toEqual([
      6, 5, 4, 2, 3, 1,
    ]);
    // 6 vivos y 2 botellas: se van 4; solo 2 sin vender, así que 2 con comprador
    const plan = planShortfall({
      bottles: 2,
      minted: 7,
      tokens,
      itemTokenIds: new Set(),
    });
    expect(plan.added.map((t) => t.bottleNumber)).toEqual([6, 5, 4, 2]);
    expect(plan).toMatchObject({ extra: 4, addedUnsold: 2, addedSold: 2 });
  });

  it('solo crece: los ítems vivos ya cubren su parte y los quemados no cuentan', () => {
    const tokens = minted(100);
    // Primer cálculo: 20 ítems (81–100)
    const first = planShortfall({
      bottles: 80,
      minted: 100,
      tokens,
      itemTokenIds: new Set(),
    });
    const items = new Set(first.added.map((t) => t.id));
    // Mismos datos: nada nuevo
    expect(
      planShortfall({ bottles: 80, minted: 100, tokens, itemTokenIds: items }),
    ).toMatchObject({ need: 20, extra: 0, added: [] });
    // Se anula otro código (79 botellas): un ítem más, el siguiente más alto
    const second = planShortfall({
      bottles: 79,
      minted: 100,
      tokens,
      itemTokenIds: items,
    });
    expect(second.added.map((t) => t.bottleNumber)).toEqual([80]);
    // Ya quemados los 20: quedan 80 vivos para 80 botellas
    const burned = tokens.map((t) =>
      items.has(t.id) ? { ...t, status: 'BURNED' } : t,
    );
    expect(
      planShortfall({
        bottles: 80,
        minted: 100,
        tokens: burned,
        itemTokenIds: items,
      }),
    ).toMatchObject({ need: 0, extra: 0, added: [] });
  });

  it('se resuelve cuando no queda ítem pendiente ni quema sin confirmar', () => {
    const at = new Date();
    expect(closureSettled([])).toBe(true);
    expect(
      closureSettled([
        { outcome: 'BURN_UNSOLD', resolvedAt: at },
        { outcome: 'MANUAL_REFUND', resolvedAt: at },
      ]),
    ).toBe(true);
    expect(closureSettled([{ outcome: 'BURN_UNSOLD', resolvedAt: null }])).toBe(
      false,
    );
    expect(closureSettled([{ outcome: 'PENDING', resolvedAt: null }])).toBe(
      false,
    );
  });

  it('la vista del cierre lleva la decisión solo si la hay', () => {
    const base = {
      id: 'c',
      lotId: 'l',
      collectionId: 'col',
      status: 'SHORTFALL_OPEN',
      computedAt: new Date('2026-10-09T12:00:00Z'),
      bottles: 80,
      minted: 100,
      sold: 0,
      reserved: 0,
      unsold: 100,
      shortfall: 20,
      unsoldToBurn: 20,
      soldWithoutBottle: 0,
      unsoldPolicy: null,
      decisionByUserId: null,
      decisionByName: null,
      decisionAt: null,
      decisionReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(toClosureSummary(base)).toMatchObject({
      status: 'SHORTFALL_OPEN',
      shortfall: 20,
      unsoldToBurn: 20,
      soldWithoutBottle: 0,
      decision: null,
    });
    expect(
      toClosureSummary({
        ...base,
        status: 'DECIDED',
        unsoldPolicy: 'KEEP_ON_SALE',
        decisionByUserId: 'u',
        decisionByName: 'Lic. Marcos Vaca',
        decisionAt: new Date('2026-10-09T13:00:00Z'),
        decisionReason: 'Faltaron 20 botellas',
      }).decision,
    ).toEqual({
      by: { userId: 'u', fullName: 'Lic. Marcos Vaca' },
      at: '2026-10-09T13:00:00.000Z',
      reason: 'Faltaron 20 botellas',
    });
  });
});

describe('BURN_UNSOLD · validación antes de firmar (§2.2)', () => {
  const CLOSURE = '55555555-5555-4555-8555-555555555555';
  const COLLECTION = '66666666-6666-4666-8666-666666666666';
  const CONTRACT = '22222222-2222-4222-8222-222222222222';
  const TOKEN = '77777777-7777-4777-8777-777777777777';
  const WINERY = '11111111-1111-4111-8111-111111111111';
  const ADDRESS = 'CDQX4AKGU76O7GH7F6SXPWGQ7YAVQTYPUYCSER67PWHJA3M7GIF6LACH';

  const tx = (
    intent: Record<string, unknown> = {},
    over: Partial<ChainTransaction> = {},
  ): ChainTransaction =>
    ({
      id: 'tx',
      kind: 'BURN_UNSOLD',
      network: 'LOCAL',
      intentKey: `burn-unsold:${CLOSURE}:99`,
      subjectType: 'TOKEN',
      subjectId: TOKEN,
      wineryId: WINERY,
      intent: {
        closureId: CLOSURE,
        collectionId: COLLECTION,
        contractId: CONTRACT,
        tokenRowId: TOKEN,
        tokenId: 99,
        ...intent,
      },
      ...over,
    }) as unknown as ChainTransaction;

  function database(
    over: {
      closure?: Record<string, unknown> | null;
      item?: Record<string, unknown> | null;
      token?: Record<string, unknown> | null;
      contract?: Record<string, unknown>;
      account?: Record<string, unknown>;
      admin?: number;
    } = {},
  ) {
    const item =
      over.item === null
        ? []
        : [{ outcome: 'BURN_UNSOLD', resolvedAt: null, ...over.item }];
    return {
      $queryRaw: jest.fn().mockResolvedValue([]),
      lotClosure: {
        findUnique: jest.fn().mockResolvedValue(
          over.closure === null
            ? null
            : {
                id: CLOSURE,
                collectionId: COLLECTION,
                status: 'DECIDED',
                decisionByUserId: 'admin-1',
                items: item,
                ...over.closure,
              },
        ),
      },
      token: {
        findUnique: jest.fn().mockResolvedValue(
          over.token === null
            ? null
            : {
                id: TOKEN,
                collectionId: COLLECTION,
                wineryId: WINERY,
                tokenId: 99,
                status: 'MINTED',
                contract: {
                  id: CONTRACT,
                  status: 'ACTIVE',
                  address: ADDRESS,
                  network: 'LOCAL',
                  paused: false,
                  chainAccount: { status: 'ACTIVE', ...over.account },
                  ...over.contract,
                },
                ...over.token,
              },
        ),
      },
      membership: { count: jest.fn().mockResolvedValue(over.admin ?? 1) },
    };
  }
  const validate = (db: ReturnType<typeof database>, transaction = tx()) =>
    validateBurnUnsold(db as never, transaction);

  it('la clave es burn-unsold:{closureId}:{tokenId} y el sujeto, el NFT', () => {
    expect(burnIntentParams(tx())).toMatchObject({ tokenId: 99 });
    for (const bad of [
      tx({}, { intentKey: `burn-unsold:${CLOSURE}:98` }),
      tx({}, { subjectId: 'otro' }),
      tx({}, { subjectType: 'MINT' }),
      tx({ tokenId: -1 }),
      tx({ tokenId: 1.5 }),
      tx({ closureId: undefined }),
    ]) {
      expect(() => burnIntentParams(bad)).toThrow(IntentRejected);
    }
  });

  it('válida: NFT sin vender de un cierre decidido por administración', async () => {
    const db = database();
    await expect(validate(db)).resolves.toEqual({
      closureId: CLOSURE,
      collectionId: COLLECTION,
      wineryId: WINERY,
      tokenRowId: TOKEN,
      tokenId: 99,
      contract: { id: CONTRACT, address: ADDRESS },
    });
    expect(db.membership.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ userId: 'admin-1', role: 'ADMIN' }),
    });
  });

  it.each([
    ['cierre inexistente', { closure: null }],
    ['cierre de otra colección', { closure: { collectionId: 'otra' } }],
    ['cierre sin decidir', { closure: { status: 'SHORTFALL_OPEN' } }],
    ['cierre ya resuelto', { closure: { status: 'RESOLVED' } }],
    ['decisión sin autor', { closure: { decisionByUserId: null } }],
    ['decisión de alguien que no es administración', { admin: 0 }],
    ['el NFT no es un ítem del cierre', { item: null }],
    ['ítem que no es una quema', { item: { outcome: 'PENDING' } }],
    ['quema ya confirmada', { item: { resolvedAt: new Date() } }],
    ['NFT vendido', { token: { status: 'SOLD' } }],
    ['NFT reservado', { token: { status: 'RESERVED' } }],
    ['NFT ya quemado', { token: { status: 'BURNED' } }],
    ['NFT de otra bodega', { token: { wineryId: 'otra' } }],
    ['NFT con otro id en la red', { token: { tokenId: 98 } }],
    ['NFT inexistente', { token: null }],
    ['contrato pausado', { contract: { paused: true } }],
    ['identidad pausada', { account: { status: 'PAUSED' } }],
    ['contrato no vigente', { contract: { status: 'RETIRED' } }],
    ['contrato de otra red', { contract: { network: 'TESTNET' } }],
  ])('rechaza sin firmar: %s', async (_case, over) => {
    await expect(
      validate(database(over as Parameters<typeof database>[0])),
    ).rejects.toBeInstanceOf(IntentRejected);
  });
});

describe('Rutas del paso 3.6', () => {
  it('son las once que quedaban con 501', () => {
    expect(O3_STEP_3_6_ROUTES).toHaveLength(11);
    expect(new Set(O3_STEP_3_6_ROUTES).size).toBe(11);
  });
});
