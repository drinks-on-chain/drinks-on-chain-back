import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChainTransaction } from '@prisma/client';
import { xdr } from '@stellar/stellar-sdk';
import { CHAIN_DEFAULTS, type ChainSettings } from '../chain.config';
import { LEDGERS_PER_DAY, intentKeys } from '../chain.constants';
import { decodeEvent } from '../jobs/gateway/stellar-chain-gateway';
import {
  ExtendTtlHandler,
  RestoreEntriesHandler,
} from '../jobs/handlers/ttl.handlers';
import type { IntentEnv } from '../jobs/signer/intent-handler';
import type { ChainTtlService, TtlEntry } from '../jobs/ttl/chain-ttl.service';
import { ArchivedEntriesFailure, IntentRejected } from '../tx/chain-tx.errors';
import { codeTtlDays } from '../ttl/code-ttl';
import {
  balanceKey,
  bucketOf,
  codeKey,
  contractTtlKeys,
  daysLeft,
  instanceKey,
  keyXdr,
  ledgerKeyOwner,
  ownerCandidateIds,
  ownerKey,
  ownershipBucketKey,
} from '../ttl/ttl-keys';

/**
 * Claves reales de la red local (pista SC, `integracion/claves-ttl.json` del
 * repo de contratos, commit `3eb9ece`): `LedgerKey` en XDR base64 tal como las
 * acepta `getLedgerEntries`.
 */
const CONTRACT = 'CDQX4AKGU76O7GH7F6SXPWGQ7YAVQTYPUYCSER67PWHJA3M7GIF6LACH';
const WINERY = 'GA7IRIRKT5YN5RKGY7B46VPMUICIIUJXBRCOS7TNQ4BPXVRMLM3ZDJBY';
const WASM_HASH =
  'eb9f75b2a17117cab0c44d318ffd2f0f7642c488f56b31167998795ce22089d8';
const REAL_KEYS = {
  instance: 'AAAABgAAAAHhfgFGp/zvmP8vpXfY0P4BWE8PpgUiR999jpBtnzIL5QAAABQAAAAB',
  code: 'AAAAB+ufdbKhcRfKsMRNMY/9Lw92QsSI9WsxFnmYeVziIInY',
  owner2:
    'AAAABgAAAAHhfgFGp/zvmP8vpXfY0P4BWE8PpgUiR999jpBtnzIL5QAAABAAAAABAAAAAgAAAA8AAAAFT3duZXIAAAAAAAADAAAAAgAAAAE=',
  owner99:
    'AAAABgAAAAHhfgFGp/zvmP8vpXfY0P4BWE8PpgUiR999jpBtnzIL5QAAABAAAAABAAAAAgAAAA8AAAAFT3duZXIAAAAAAAADAAAAYwAAAAE=',
  bucket0:
    'AAAABgAAAAHhfgFGp/zvmP8vpXfY0P4BWE8PpgUiR999jpBtnzIL5QAAABAAAAABAAAAAgAAAA8AAAAPT3duZXJzaGlwQnVja2V0AAAAAAMAAAAAAAAAAQ==',
  balanceWinery:
    'AAAABgAAAAHhfgFGp/zvmP8vpXfY0P4BWE8PpgUiR999jpBtnzIL5QAAABAAAAABAAAAAgAAAA8AAAAHQmFsYW5jZQAAAAASAAAAAAAAAAA+iKIqn3DexUbHw89V7KIEhFE3DETpfm2HAvvWLFs3kQAAAAE=',
};

const settings = (overrides: Partial<ChainSettings> = {}): ChainSettings => ({
  enabled: true,
  network: 'LOCAL',
  networkPassphrase: 'Standalone Network ; February 2017',
  rpcUrl: 'http://rpc.test',
  explorerBaseUrl: null,
  homeDomain: null,
  wasmHash: WASM_HASH,
  custodyDriver: 'ENV',
  mintEnabled: true,
  txMaxFeeStroops: CHAIN_DEFAULTS.txMaxFeeStroops,
  operationsMinBalanceXlm: '50',
  anchorMinBalanceXlm: '5',
  wineryStartingBalanceXlm: '2',
  ttlExtendBelowDays: 30,
  consumerSeedCheckAddress: null,
  publicApiBaseUrl: null,
  deployMaxFeeStroops: CHAIN_DEFAULTS.deployMaxFeeStroops,
  codeTtlMaxFeeStroops: CHAIN_DEFAULTS.codeTtlMaxFeeStroops,
  txRetryDelaysMs: CHAIN_DEFAULTS.txRetryDelaysMs,
  friendbotUrl: null,
  environment: 'local',
  ...overrides,
});

const CONTRACT_ID = '22222222-2222-4222-8222-222222222222';
const WINERY_ID = '11111111-1111-4111-8111-111111111111';

function tx(overrides: Partial<ChainTransaction>): ChainTransaction {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    kind: 'EXTEND_TTL',
    status: 'PENDING',
    network: 'LOCAL',
    intentKey: intentKeys.ttlContract(CONTRACT_ID, '2026-10-09'),
    subjectType: 'CONTRACT',
    subjectId: CONTRACT_ID,
    wineryId: WINERY_ID,
    intent: { target: 'CONTRACT', contractId: CONTRACT_ID },
    attempts: 1,
    ...overrides,
  } as ChainTransaction;
}

describe('Claves de TTL (contrato O3 §8.3 corregido)', () => {
  it('son las que el RPC acepta: instancia, código, Owner, OwnershipBucket y Balance', () => {
    expect(keyXdr(instanceKey(CONTRACT))).toBe(REAL_KEYS.instance);
    expect(keyXdr(codeKey(WASM_HASH))).toBe(REAL_KEYS.code);
    expect(keyXdr(ownerKey(CONTRACT, 2))).toBe(REAL_KEYS.owner2);
    expect(keyXdr(ownerKey(CONTRACT, 99))).toBe(REAL_KEYS.owner99);
    expect(keyXdr(ownershipBucketKey(CONTRACT, 0))).toBe(REAL_KEYS.bucket0);
    expect(keyXdr(balanceKey(CONTRACT, WINERY))).toBe(REAL_KEYS.balanceWinery);
  });

  it('un cubo por cada 3 200 ids', () => {
    expect(bucketOf(0)).toBe(0);
    expect(bucketOf(3_199)).toBe(0);
    expect(bucketOf(3_200)).toBe(1);
    expect(bucketOf(32_000)).toBe(10);
  });

  it('Owner(último id de cada emisión); nunca el «id siguiente»', () => {
    expect(
      ownerCandidateIds(
        [
          { firstTokenId: 0, lastTokenId: 99 },
          { firstTokenId: 100, lastTokenId: 149 },
        ],
        [],
      ),
    ).toEqual([99, 149]);
  });

  it('tras quemar del 80 al 99 queda Owner(79): el id anterior a la quema', () => {
    const burned = Array.from({ length: 20 }, (_, i) => 80 + i);
    expect(
      ownerCandidateIds([{ firstTokenId: 0, lastTokenId: 99 }], burned),
    ).toEqual([79]);
    // Una emisión quemada entera no deja ninguna entrada que cuidar
    expect(
      ownerCandidateIds([{ firstTokenId: 0, lastTokenId: 2 }], [0, 1, 2]),
    ).toEqual([]);
    // Quemas sueltas: el anterior a cada una, sin repetir ni incluir quemados
    expect(
      ownerCandidateIds([{ firstTokenId: 0, lastTokenId: 9 }], [3, 4, 7]),
    ).toEqual([2, 6, 9]);
  });

  it('las claves de un contrato: instancia, dueños, cubos y saldo de la bodega', () => {
    const keys = contractTtlKeys({
      contractAddress: CONTRACT,
      wineryAccount: WINERY,
      ranges: [
        { firstTokenId: 0, lastTokenId: 99 },
        { firstTokenId: 100, lastTokenId: 32_099 },
      ],
      burnedIds: [],
    });
    expect(keys.map((k) => k.name)).toEqual([
      'instance',
      'Owner(99)',
      'Owner(32099)',
      'OwnershipBucket(0)',
      'OwnershipBucket(10)',
      'Balance(bodega)',
    ]);
    expect(keyXdr(keys[1].key)).toBe(REAL_KEYS.owner99);
    // Sin emisiones solo existe la instancia
    expect(
      contractTtlKeys({
        contractAddress: CONTRACT,
        wineryAccount: WINERY,
        ranges: [],
        burnedIds: [],
      }).map((k) => k.name),
    ).toEqual(['instance']);
  });

  it('días de vida: 17 280 ledgers por día', () => {
    expect(daysLeft(1_000 + 30 * LEDGERS_PER_DAY, 1_000)).toBe(30);
    expect(daysLeft(500, 1_000)).toBeLessThan(0);
    expect(daysLeft(null, 1_000)).toBeNull();
  });

  it('de quién es una clave: el código o un contrato', () => {
    const decode = (b64: string) => xdr.LedgerKey.fromXDR(b64, 'base64');
    expect(ledgerKeyOwner(decode(REAL_KEYS.code))).toEqual({
      type: 'CODE',
      wasmHash: WASM_HASH,
    });
    expect(ledgerKeyOwner(codeKey(WASM_HASH))).toEqual({
      type: 'CODE',
      wasmHash: WASM_HASH,
    });
    expect(ledgerKeyOwner(decode(REAL_KEYS.owner99))).toEqual({
      type: 'CONTRACT',
      address: CONTRACT,
    });
  });

  it('codeTtlDays: la lectura menos los días transcurridos, nunca negativo', () => {
    const at = new Date('2026-10-09T07:00:00.000Z');
    const reading = {
      cursor: String(5_000 + 120 * LEDGERS_PER_DAY),
      lastLedger: 5_000,
      updatedAt: at,
    };
    expect(codeTtlDays(reading, at)).toBe(120);
    expect(codeTtlDays(reading, new Date('2026-10-19T19:00:00.000Z'))).toBe(
      109,
    );
    expect(codeTtlDays(reading, new Date('2027-10-09T07:00:00.000Z'))).toBe(0);
    expect(codeTtlDays(null)).toBeNull();
    expect(codeTtlDays({ ...reading, cursor: null })).toBeNull();
    expect(codeTtlDays({ ...reading, lastLedger: null })).toBeNull();
  });
});

describe('Eventos del contrato: los 14 ejemplos reales (§8.1)', () => {
  const fixture = JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'contract-events.json'), 'utf8'),
  ) as {
    eventos: Record<
      string,
      {
        contractId: string;
        topic: string[];
        value: string;
        decodificado: { topics: unknown[]; value: Record<string, unknown> };
      }
    >;
  };

  it('están los 14 de docs/funciones.md', () => {
    expect(Object.keys(fixture.eventos).sort()).toEqual([
      'admin_transfer_completed',
      'admin_transfer_initiated',
      'approve',
      'approve_for_all',
      'base_uri_updated',
      'burn',
      'consecutive_mint',
      'lot_minted',
      'paused',
      'role_admin_changed',
      'role_granted',
      'role_revoked',
      'transfer',
      'unpaused',
    ]);
  });

  it.each(Object.keys(fixture.eventos))(
    '%s: el XDR del RPC se decodifica como su ejemplo',
    (name) => {
      const example = fixture.eventos[name];
      const decoded = decodeEvent(
        example.topic.map((t) => xdr.ScVal.fromXDR(t, 'base64')),
        xdr.ScVal.fromXDR(example.value, 'base64'),
        example.contractId,
      );
      const [first, ...topics] = example.decodificado.topics;
      expect(decoded).toEqual({
        name: first,
        contractAddress: example.contractId,
        topics,
        data: example.decodificado.value,
      });
      expect(decoded.name).toBe(name);
    },
  );
});

describe('EXTEND_TTL y RESTORE_ENTRIES · validación y preparación (§2.2, §8.3)', () => {
  const entry = (
    name: string,
    days: number | null,
    archived = false,
  ): TtlEntry => ({
    name,
    key: name === 'code' ? codeKey(WASM_HASH) : ownerKey(CONTRACT, 99),
    keyXdr: name === 'code' ? REAL_KEYS.code : REAL_KEYS.owner99,
    liveUntilLedger: days === null ? null : 1_000 + days * LEDGERS_PER_DAY,
    daysLeft: days,
    archived,
  });
  const ttl = (entries: TtlEntry[]) =>
    ({
      readCode: jest.fn().mockResolvedValue({ latestLedger: 1_000, entries }),
      readContract: jest
        .fn()
        .mockResolvedValue({ latestLedger: 1_000, entries }),
      below: (reading: { entries: TtlEntry[] }, days: number) =>
        reading.entries.filter((e) => e.daysLeft !== null && e.daysLeft < days),
    }) as unknown as ChainTtlService;
  const contractDb = (row: Record<string, unknown> | null) =>
    ({
      nftContract: {
        findUnique: jest.fn().mockResolvedValue(row),
        count: jest.fn().mockResolvedValue(row ? 1 : 0),
      },
    }) as never;
  const activeContract = {
    address: CONTRACT,
    status: 'ACTIVE',
    network: 'LOCAL',
    wineryId: WINERY_ID,
  };

  it('valida la extensión de un contrato vigente y la del código vigente', async () => {
    const handler = new ExtendTtlHandler(ttl([]), settings());
    await expect(
      handler.validate(contractDb(activeContract), tx({})),
    ).resolves.toEqual({ target: 'CONTRACT', contractId: CONTRACT_ID });
    await expect(
      handler.validate(
        contractDb(null),
        tx({
          intentKey: intentKeys.ttlCode(WASM_HASH, '2026-10-09'),
          subjectType: 'PLATFORM',
          subjectId: 'CODE',
          wineryId: null,
          intent: { target: 'CODE', wasmHash: WASM_HASH },
        }),
      ),
    ).resolves.toEqual({ target: 'CODE' });
  });

  it.each([
    ['contrato inexistente', contractDb(null), tx({})],
    [
      'contrato no vigente',
      contractDb({ ...activeContract, status: 'FAILED' }),
      tx({}),
    ],
    [
      'contrato de otra bodega',
      contractDb({ ...activeContract, wineryId: 'otra' }),
      tx({}),
    ],
    [
      'clave de otro contrato',
      contractDb(activeContract),
      tx({ intentKey: 'ttl:otro:2026-10-09' }),
    ],
    [
      'código que no es el vigente',
      contractDb(null),
      tx({
        intentKey: intentKeys.ttlCode('f'.repeat(64), '2026-10-09'),
        subjectType: 'PLATFORM',
        subjectId: 'CODE',
        intent: { target: 'CODE', wasmHash: 'f'.repeat(64) },
      }),
    ],
    ['sin objetivo', contractDb(activeContract), tx({ intent: {} })],
  ])('rechaza sin firmar: %s', async (_case, db, transaction) => {
    const handler = new ExtendTtlHandler(ttl([]), settings());
    await expect(handler.validate(db, transaction)).rejects.toBeInstanceOf(
      IntentRejected,
    );
  });

  it('extiende a 120 días solo lo que baja del umbral; el código, con su tope propio', async () => {
    const handler = new ExtendTtlHandler(
      ttl([entry('Owner(99)', 7), entry('instance', 119), entry('x', null)]),
      settings(),
    );
    const prepared = await handler.prepare({
      target: 'CONTRACT',
      contractId: CONTRACT_ID,
    });
    expect(prepared).toMatchObject({
      type: 'FOOTPRINT',
      action: 'EXTEND',
      extendTo: 120 * LEDGERS_PER_DAY,
    });
    if (prepared.type !== 'FOOTPRINT') throw new Error('sin huella');
    expect(prepared.keys.map(keyXdr)).toEqual([REAL_KEYS.owner99]);
    expect(prepared.maxFeeStroops).toBeUndefined();

    const code = await new ExtendTtlHandler(
      ttl([entry('code', 20)]),
      settings({ codeTtlMaxFeeStroops: '777' }),
    ).prepare({ target: 'CODE' });
    expect(code).toMatchObject({
      type: 'FOOTPRINT',
      action: 'EXTEND',
      maxFeeStroops: '777',
    });
  });

  it('sin nada bajo el umbral se da por hecha; con algo archivado pide restaurar', async () => {
    const done = await new ExtendTtlHandler(
      ttl([entry('instance', 100)]),
      settings(),
    ).prepare({ target: 'CONTRACT', contractId: CONTRACT_ID });
    expect(done.type).toBe('ALREADY_DONE');

    const archived = new ExtendTtlHandler(
      ttl([entry('Owner(99)', -2, true)]),
      settings(),
    ).prepare({ target: 'CONTRACT', contractId: CONTRACT_ID });
    await expect(archived).rejects.toBeInstanceOf(ArchivedEntriesFailure);
    await expect(archived).rejects.toMatchObject({
      code: 'CHN_ARCHIVED_ENTRY',
      retryable: true,
      ledgerKeys: [REAL_KEYS.owner99],
    });
  });

  const restoreTx = (ledgerKeys: unknown, intentKey = 'restore:tx-1:1') =>
    tx({
      kind: 'RESTORE_ENTRIES',
      intentKey,
      intent: { forTransactionId: 'tx-1', ledgerKeys },
    } as Partial<ChainTransaction>);

  it('RESTORE_ENTRIES solo acepta entradas de contratos propios o el código vigente', async () => {
    const handler = new RestoreEntriesHandler(settings());
    const plan = await handler.validate(
      contractDb(activeContract),
      restoreTx([REAL_KEYS.owner99, REAL_KEYS.code]),
    );
    expect(plan.keys.map(keyXdr)).toEqual([REAL_KEYS.owner99, REAL_KEYS.code]);

    for (const [db, transaction] of [
      // El contrato de la clave no es de la plataforma
      [contractDb(null), restoreTx([REAL_KEYS.owner99])],
      // Otro código
      [
        contractDb(activeContract),
        restoreTx([keyXdr(codeKey('f'.repeat(64)))]),
      ],
      // Una cuenta clásica no es una entrada de contrato
      [contractDb(activeContract), restoreTx(['AAAAAAAAAAA='])],
      [contractDb(activeContract), restoreTx([])],
      [contractDb(activeContract), restoreTx('no-es-una-lista')],
      [contractDb(activeContract), restoreTx([REAL_KEYS.code], 'otra:clave')],
    ] as const) {
      await expect(handler.validate(db, transaction)).rejects.toBeInstanceOf(
        IntentRejected,
      );
    }
  });

  it('restaura solo lo que la red no da por vivo', async () => {
    const handler = new RestoreEntriesHandler(settings());
    const keys = [ownerKey(CONTRACT, 99), instanceKey(CONTRACT)];
    const env = (liveUntil: Map<string, number>) =>
      ({
        gateway: {
          entriesTtl: jest
            .fn()
            .mockResolvedValue({ latestLedger: 1_000, liveUntil }),
        },
      }) as unknown as IntentEnv;
    const prepared = await handler.prepare(
      { keys },
      restoreTx([]),
      // La instancia vive; Owner(99) no aparece (archivada y desalojada)
      env(new Map([[REAL_KEYS.instance, 5_000]])),
    );
    expect(prepared).toMatchObject({ type: 'FOOTPRINT', action: 'RESTORE' });
    if (prepared.type !== 'FOOTPRINT') throw new Error('sin huella');
    expect(prepared.keys.map(keyXdr)).toEqual([REAL_KEYS.owner99]);

    const live = await handler.prepare(
      { keys },
      restoreTx([]),
      env(
        new Map([
          [REAL_KEYS.instance, 5_000],
          [REAL_KEYS.owner99, 5_000],
        ]),
      ),
    );
    expect(live.type).toBe('ALREADY_DONE');
  });
});
