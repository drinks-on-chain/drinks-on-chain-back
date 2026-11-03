import type { DossierAnchor } from '@prisma/client';
import { StrKey } from '@stellar/stellar-sdk';
import { applyAnchorConfirmed } from '../anchor/anchor-effects';
import {
  toDossierAnchor,
  toPublicDossierAnchor,
  verificationChecks,
} from '../anchor/anchor-view';
import { anchorLedgerFromConfig } from '../anchor/dossier-anchor.port';
import { DossierAnchorService } from '../anchor/dossier-anchor.service';
import {
  SIMULATED_ANCHOR_ACCOUNT,
  isSimulatedAnchor,
  simulatedIntentKey,
  simulatedTxHash,
} from '../anchor/simulated-anchor';
import { SimulatedDossierAnchorLedger } from '../anchor/simulated-dossier-anchor.ledger';
import { assertChainEnvCoherent } from '../chain.config';

jest.mock('../anchor/anchor-effects', () => ({
  ...jest.requireActual('../anchor/anchor-effects'),
  applyAnchorConfirmed: jest.fn().mockResolvedValue('ANCHORED'),
}));

const HASH = 'ab'.repeat(32);
const LOT = '11111111-1111-4111-8111-111111111111';
const WINERY = '22222222-2222-4222-8222-222222222222';
const EXPLORER = 'https://stellar.expert/explorer/testnet';
const REAL_ACCOUNT = 'GA7IRIRKT5YN5RKGY7B46VPMUICIIUJXBRCOS7TNQ4BPXVRMLM3ZDJBY';

const anchorRow = (over: Partial<DossierAnchor> = {}): DossierAnchor => ({
  id: 'anchor-1',
  lotId: LOT,
  status: 'ANCHORED',
  network: 'LOCAL',
  account: SIMULATED_ANCHOR_ACCOUNT,
  memoHashHex: HASH,
  txHash: simulatedTxHash(LOT, HASH),
  ledger: null,
  anchoredAt: new Date('2026-11-01T12:00:00Z'),
  verifiedAt: new Date('2026-11-01T12:00:00Z'),
  transactionId: 'tx-sim',
  createdAt: new Date('2026-11-01T12:00:00Z'),
  updatedAt: new Date('2026-11-01T12:00:00Z'),
  ...over,
});

/** Cliente de base de datos mínimo para `request()`. */
function dbWith(dossier: unknown) {
  return {
    $queryRaw: jest.fn().mockResolvedValue([]),
    lotDossier: { findUnique: jest.fn().mockResolvedValue(dossier) },
    chainTransaction: {
      upsert: jest.fn(({ create }: { create: Record<string, unknown> }) =>
        Promise.resolve({ id: 'tx-sim', ...create }),
      ),
    },
    dossierAnchor: { create: jest.fn(), update: jest.fn() },
  };
}

const closedDossier = (anchor: DossierAnchor | null = null) => ({
  lotId: LOT,
  status: 'CLOSED',
  hash: HASH,
  anchor,
  lot: { wineryId: WINERY },
});

const ledger = () =>
  new SimulatedDossierAnchorLedger(
    {} as never,
    { record: jest.fn() } as never,
    { add: jest.fn() } as never,
    { raise: jest.fn() } as never,
  );

describe('Puerto del anclaje: selección (ANCHOR_LEDGER)', () => {
  const config = (value: unknown) => ({ get: () => value });
  it('STELLAR por defecto; SIMULATED sin importar mayúsculas', () => {
    expect(anchorLedgerFromConfig(config(undefined))).toBe('STELLAR');
    expect(anchorLedgerFromConfig(config(''))).toBe('STELLAR');
    expect(anchorLedgerFromConfig(config('stellar'))).toBe('STELLAR');
    expect(anchorLedgerFromConfig(config('simulated'))).toBe('SIMULATED');
    expect(anchorLedgerFromConfig(config(' SIMULATED '))).toBe('SIMULATED');
  });

  it('la simulación no se admite en la red principal', () => {
    const helpers = { message: jest.fn((m: unknown) => ({ error: m })) };
    expect(
      assertChainEnvCoherent(
        { ANCHOR_LEDGER: 'SIMULATED', STELLAR_NETWORK: 'PUBLIC' },
        helpers as never,
      ),
    ).toEqual({ error: expect.anything() });
    const ok = { ANCHOR_LEDGER: 'SIMULATED', STELLAR_NETWORK: 'TESTNET' };
    expect(assertChainEnvCoherent(ok, helpers as never)).toBe(ok);
  });
});

describe('Identidad del anclaje simulado', () => {
  it('cuenta G… válida y fija; hash de 64 hex determinista por lote y huella', () => {
    expect(StrKey.isValidEd25519PublicKey(SIMULATED_ANCHOR_ACCOUNT)).toBe(true);
    expect(simulatedTxHash(LOT, HASH)).toMatch(/^[0-9a-f]{64}$/);
    expect(simulatedTxHash(LOT, HASH)).toBe(simulatedTxHash(LOT, HASH));
    expect(simulatedTxHash(LOT, HASH)).not.toBe(
      simulatedTxHash(LOT, 'cd'.repeat(32)),
    );
    expect(isSimulatedAnchor({ account: SIMULATED_ANCHOR_ACCOUNT })).toBe(true);
    expect(isSimulatedAnchor({ account: REAL_ACCOUNT })).toBe(false);
    expect(isSimulatedAnchor(null)).toBe(false);
  });
});

describe('SimulatedDossierAnchorLedger.request', () => {
  beforeEach(() => jest.mocked(applyAnchorConfirmed).mockClear());

  it('expediente sin cerrar → NOT_CLOSED, sin escribir nada', async () => {
    const db = dbWith({ ...closedDossier(), status: 'OPEN', hash: null });
    await expect(ledger().request(db as never, LOT)).resolves.toBe(
      'NOT_CLOSED',
    );
    expect(db.chainTransaction.upsert).not.toHaveBeenCalled();
  });

  it('ya anclado → ALREADY_ANCHORED; un anclaje real en curso no se pisa', async () => {
    await expect(
      ledger().request(dbWith(closedDossier(anchorRow())) as never, LOT),
    ).resolves.toBe('ALREADY_ANCHORED');
    const realPending = anchorRow({
      status: 'PENDING',
      network: 'TESTNET',
      account: REAL_ACCOUNT,
    });
    await expect(
      ledger().request(dbWith(closedDossier(realPending)) as never, LOT),
    ).resolves.toBe('IN_PROGRESS');
    expect(applyAnchorConfirmed).not.toHaveBeenCalled();
  });

  it('expediente cerrado: transacción CONFIRMED en LOCAL, anclaje con la cuenta simulada y los efectos reales', async () => {
    const db = dbWith(closedDossier());
    await expect(ledger().request(db as never, LOT)).resolves.toBe('REQUESTED');
    expect(db.chainTransaction.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { intentKey: simulatedIntentKey(LOT) },
        create: expect.objectContaining({
          kind: 'ANCHOR_DOSSIER',
          status: 'CONFIRMED',
          network: 'LOCAL',
          subjectType: 'LOT',
          subjectId: LOT,
          wineryId: WINERY,
          sourceAccount: SIMULATED_ANCHOR_ACCOUNT,
          txHash: simulatedTxHash(LOT, HASH),
        }),
      }),
    );
    // No usa la clave de la intención real: el anclaje real podrá registrarse después
    expect(simulatedIntentKey(LOT)).not.toBe(`anchor:${LOT}`);
    expect(db.dossierAnchor.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        lotId: LOT,
        status: 'PENDING',
        network: 'LOCAL',
        account: SIMULATED_ANCHOR_ACCOUNT,
        memoHashHex: HASH,
        transactionId: 'tx-sim',
      }),
    });
    expect(applyAnchorConfirmed).toHaveBeenCalledWith(
      db,
      expect.anything(),
      expect.objectContaining({ id: 'tx-sim' }),
      {
        ok: true,
        expectedMemoHashHex: HASH,
        memoHashHex: HASH,
        officialAccount: SIMULATED_ANCHOR_ACCOUNT,
        sourceAccount: SIMULATED_ANCHOR_ACCOUNT,
      },
    );
  });
});

describe('Vistas de un anclaje simulado', () => {
  it('sin enlace al explorador (no está en ninguna red), ni en el ERP ni en público', () => {
    const row = { ...anchorRow(), transaction: null };
    const pub = toPublicDossierAnchor(row, EXPLORER);
    expect(pub).toEqual(
      expect.objectContaining({
        status: 'ANCHORED',
        network: 'LOCAL',
        explorerUrl: null,
      }),
    );
    expect(pub?.txHash).toBe(simulatedTxHash(LOT, HASH));
    const erp = toDossierAnchor(
      {
        ...anchorRow(),
        transaction: {
          id: 'tx-sim',
          kind: 'ANCHOR_DOSSIER',
          status: 'CONFIRMED',
          network: 'LOCAL',
          txHash: simulatedTxHash(LOT, HASH),
          attempts: 1,
          lastError: null,
          createdAt: new Date('2026-11-01T12:00:00Z'),
          updatedAt: new Date('2026-11-01T12:00:00Z'),
        } as never,
      },
      EXPLORER,
    );
    expect(erp?.explorerUrl).toBeNull();
  });

  it('las cuatro comprobaciones pasan con la cuenta simulada como oficial', () => {
    const checks = verificationChecks({
      dossierHash: HASH,
      anchor: anchorRow(),
      officialAnchorAccount: SIMULATED_ANCHOR_ACCOUNT,
    });
    expect(checks.map((c) => c.pass)).toEqual([true, true, true, true]);
  });
});

describe('Anclaje real: sustituye al simulado', () => {
  it('un expediente anclado en simulación se vuelve a anclar en la red (fila a PENDING en la red real)', async () => {
    const db = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      lotDossier: {
        findUnique: jest.fn().mockResolvedValue(closedDossier(anchorRow())),
      },
      chainAccount: {
        findFirst: jest.fn().mockResolvedValue({ address: REAL_ACCOUNT }),
      },
      dossierAnchor: { create: jest.fn(), update: jest.fn() },
    };
    const intents = {
      register: jest
        .fn()
        .mockResolvedValue({ transaction: { id: 'tx-real' }, created: true }),
    };
    const service = new DossierAnchorService(
      {} as never,
      intents as never,
      { enabled: true, network: 'TESTNET' } as never,
    );
    await expect(service.request(db as never, LOT)).resolves.toBe('REQUESTED');
    expect(intents.register).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        kind: 'ANCHOR_DOSSIER',
        intentKey: `anchor:${LOT}`,
      }),
    );
    expect(db.dossierAnchor.update).toHaveBeenCalledWith({
      where: { id: 'anchor-1' },
      data: expect.objectContaining({
        status: 'PENDING',
        network: 'TESTNET',
        account: REAL_ACCOUNT,
        txHash: null,
        verifiedAt: null,
        transactionId: 'tx-real',
      }),
    });
  });

  it('un anclaje real ya confirmado no se repite', async () => {
    const db = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      lotDossier: {
        findUnique: jest
          .fn()
          .mockResolvedValue(
            closedDossier(
              anchorRow({ network: 'TESTNET', account: REAL_ACCOUNT }),
            ),
          ),
      },
    };
    const service = new DossierAnchorService(
      {} as never,
      { register: jest.fn() } as never,
      { enabled: true, network: 'TESTNET' } as never,
    );
    await expect(service.request(db as never, LOT)).resolves.toBe(
      'ALREADY_ANCHORED',
    );
  });
});
