import { Keypair } from '@stellar/stellar-sdk';
import {
  CUSTODY_REF_ANCHOR,
  CUSTODY_REF_CONSUMER_SEED,
  CUSTODY_REF_OPERATIONS,
  wineryCustodyRef,
} from '../chain.constants';
import type { ChainSettings } from '../chain.config';
import { createKeyCustody } from '../custody/custody.factory';
import { EnvKeyCustody } from '../custody/env-key-custody';
import { CustodyError, DisabledKeyCustody } from '../custody/key-custody';
import { LocalKeyCustody } from '../custody/local-key-custody';
import {
  deriveSep5Address,
  deriveSep5Keypair,
  masterSeedFromSecret,
  sep5Path,
} from '../custody/sep5';

/**
 * Vector de prueba 1 de SEP-0005 (frase de 12 palabras, pública en la
 * especificación): solo se comparan direcciones `G…`.
 */
const SEP5_MNEMONIC =
  'illness spike retreat truth genius clock brain pass fit cave bargain toe';
const SEP5_BIP39_SEED_HEX =
  'e4a5a632e70943ae7f07659df1332160937fad82587216a4c64315a0fb39497e' +
  'e4a01f76ddab4cba68147977f3a147b6ad584c41808e8238a07f6cc4b582f186';
const SEP5_ADDRESSES = [
  'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6',
  'GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX',
  'GAY5PRAHJ2HIYBYCLZXTHID6SPVELOOYH2LBPH3LD4RUMXUW3DOYTLXW',
  'GAOD5NRAEORFE34G5D4EOSKIJB6V4Z2FGPBCJNQI6MNICVITE6CSYIAE',
  'GBCUXLFLSL2JE3NWLHAWXQZN6SQC6577YMAU3M3BEMWKYPFWXBSRCWV4',
];

const WINERY_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const PAYLOAD = new Uint8Array(32).fill(7);

async function custodyError(work: Promise<unknown>): Promise<CustodyError> {
  const error = await work.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(CustodyError);
  return error as CustodyError;
}

describe('SEP-0005 (SLIP-0010 Ed25519)', () => {
  it('la frase mnemónica da la semilla BIP-39 del vector', () => {
    expect(masterSeedFromSecret(SEP5_MNEMONIC).toString('hex')).toBe(
      SEP5_BIP39_SEED_HEX,
    );
    // Espacios de más y saltos de línea no cambian la semilla
    expect(
      masterSeedFromSecret(`  ${SEP5_MNEMONIC.replace(/ /g, '  ')}\n`).toString(
        'hex',
      ),
    ).toBe(SEP5_BIP39_SEED_HEX);
  });

  it("deriva m/44'/148'/{i}' como los vectores de la especificación", () => {
    const seed = masterSeedFromSecret(SEP5_MNEMONIC);
    SEP5_ADDRESSES.forEach((address, index) => {
      expect({ index, address: deriveSep5Address(seed, index) }).toEqual({
        index,
        address,
      });
    });
    expect(sep5Path(4)).toBe("m/44'/148'/4'");
  });

  it('una semilla en hexadecimal equivale a su frase', () => {
    expect(
      deriveSep5Address(masterSeedFromSecret(SEP5_BIP39_SEED_HEX), 0),
    ).toBe(SEP5_ADDRESSES[0]);
  });

  it('rechaza índices fuera de rango', () => {
    const seed = masterSeedFromSecret(SEP5_MNEMONIC);
    for (const index of [-1, 1.5, 2 ** 31, Number.NaN]) {
      expect(() => deriveSep5Keypair(seed, index)).toThrow(RangeError);
    }
  });
});

describe('Custodio LOCAL (claves en memoria)', () => {
  it('ensureKey crea la clave una vez y firma con ella', async () => {
    const custody = new LocalKeyCustody();
    const ref = wineryCustodyRef(WINERY_ID);
    const address = await custody.ensureKey(ref);
    expect(address).toMatch(/^G[A-Z2-7]{55}$/);
    expect(await custody.ensureKey(ref)).toBe(address);
    expect(await custody.publicKey(ref)).toBe(address);

    const signature = await custody.sign(ref, PAYLOAD);
    expect(signature).toHaveLength(64);
    expect(
      Keypair.fromPublicKey(address).verify(
        Buffer.from(PAYLOAD),
        Buffer.from(signature),
      ),
    ).toBe(true);
  });

  it('cada referencia tiene su clave, y cada instancia las suyas', async () => {
    const custody = new LocalKeyCustody();
    const operations = await custody.ensureKey(CUSTODY_REF_OPERATIONS);
    expect(await custody.ensureKey(CUSTODY_REF_ANCHOR)).not.toBe(operations);
    expect(
      await new LocalKeyCustody().ensureKey(CUSTODY_REF_OPERATIONS),
    ).not.toBe(operations);
  });

  it('una clave que no existe no se firma ni se inventa', async () => {
    const custody = new LocalKeyCustody();
    for (const work of [
      custody.publicKey('winery-desconocida'),
      custody.sign('winery-desconocida', PAYLOAD),
    ]) {
      expect((await custodyError(work)).code).toBe('CUSTODY_KEY_NOT_FOUND');
    }
  });
});

describe('Custodio ENV (solo testnet y red local)', () => {
  const operations = Keypair.random();
  const anchor = Keypair.random();
  const indexes = new Map<string, number>([[wineryCustodyRef(WINERY_ID), 3]]);
  const lookup = jest.fn((ref: string) =>
    Promise.resolve(indexes.get(ref) ?? null),
  );
  const custody = new EnvKeyCustody(
    {
      operations: operations.secret(),
      anchor: anchor.secret(),
      winerySeed: SEP5_MNEMONIC,
    },
    lookup,
  );

  beforeEach(() => lookup.mockClear());

  it('operaciones y anclaje salen de sus secretos del entorno', async () => {
    expect(await custody.publicKey(CUSTODY_REF_OPERATIONS)).toBe(
      operations.publicKey(),
    );
    expect(await custody.ensureKey(CUSTODY_REF_ANCHOR)).toBe(
      anchor.publicKey(),
    );
    const signature = await custody.sign(CUSTODY_REF_ANCHOR, PAYLOAD);
    expect(anchor.verify(Buffer.from(PAYLOAD), Buffer.from(signature))).toBe(
      true,
    );
    expect(lookup).not.toHaveBeenCalled();
  });

  it('la clave de una bodega se deriva de la semilla por su derivationIndex', async () => {
    const ref = wineryCustodyRef(WINERY_ID);
    expect(await custody.publicKey(ref)).toBe(SEP5_ADDRESSES[3]);
    expect(lookup).toHaveBeenCalledWith(ref);
    const signature = await custody.sign(ref, PAYLOAD);
    expect(
      Keypair.fromPublicKey(SEP5_ADDRESSES[3]).verify(
        Buffer.from(PAYLOAD),
        Buffer.from(signature),
      ),
    ).toBe(true);
  });

  it('una bodega sin índice asignado no tiene clave', async () => {
    const error = await custodyError(
      custody.ensureKey(
        wineryCustodyRef('11111111-1111-4111-8111-111111111111'),
      ),
    );
    expect(error.code).toBe('CUSTODY_INDEX_NOT_ALLOCATED');
  });

  it('la semilla maestra de consumidores nunca firma', async () => {
    const error = await custodyError(
      custody.sign(CUSTODY_REF_CONSUMER_SEED, PAYLOAD),
    );
    expect(error.code).toBe('CUSTODY_KEY_NOT_SIGNABLE');
  });

  it('una referencia desconocida no resuelve ninguna clave', async () => {
    const error = await custodyError(custody.publicKey('sign-anything'));
    expect(error.code).toBe('CUSTODY_KEY_NOT_FOUND');
  });

  it('sin secretos falla con un error que no repite ningún valor', async () => {
    const empty = new EnvKeyCustody({}, lookup);
    const missing = await custodyError(empty.publicKey(CUSTODY_REF_OPERATIONS));
    expect(missing.code).toBe('CUSTODY_SECRET_MISSING');
    expect(missing.message).toBe('Falta CHAIN_SECRET_OPERATIONS en el entorno');

    const noSeed = await custodyError(
      empty.publicKey(wineryCustodyRef(WINERY_ID)),
    );
    expect(noSeed.message).toBe('Falta CHAIN_DEV_WINERY_SEED en el entorno');

    const badValue = 'SNOESUNASEMILLAVALIDA';
    const invalid = await custodyError(
      new EnvKeyCustody({ operations: badValue }, lookup).publicKey(
        CUSTODY_REF_OPERATIONS,
      ),
    );
    expect(invalid.code).toBe('CUSTODY_SECRET_MISSING');
    expect(invalid.message).not.toContain(badValue);
  });

  it('las claves no aparecen al serializar el custodio ni en sus errores', async () => {
    const error = await custodyError(custody.publicKey('otra-cosa'));
    for (const text of [String(error), JSON.stringify(error)]) {
      expect(text).not.toContain(operations.secret());
      expect(text).not.toContain(anchor.secret());
      expect(text).not.toContain('illness');
    }
  });
});

describe('Custodio deshabilitado y elección del driver', () => {
  const settings = (custodyDriver: ChainSettings['custodyDriver']) =>
    ({ custodyDriver, network: 'TESTNET' }) as ChainSettings;
  const config = { get: jest.fn() } as never;
  const prisma = { chainAccount: { findUnique: jest.fn() } };

  it('sin CHAIN_CUSTODY_DRIVER no hay claves: todo falla con CUSTODY_DISABLED', async () => {
    const custody = createKeyCustody(settings(null), config, prisma as never);
    expect(custody).toBeInstanceOf(DisabledKeyCustody);
    expect(custody.driver).toBe('DISABLED');
    for (const work of [
      custody.publicKey(CUSTODY_REF_OPERATIONS),
      custody.ensureKey(CUSTODY_REF_OPERATIONS),
      custody.sign(CUSTODY_REF_OPERATIONS, PAYLOAD),
    ]) {
      expect((await custodyError(work)).code).toBe('CUSTODY_DISABLED');
    }
  });

  it('LOCAL y ENV crean su custodio', () => {
    expect(
      createKeyCustody(settings('LOCAL'), config, prisma as never),
    ).toBeInstanceOf(LocalKeyCustody);
    expect(
      createKeyCustody(settings('ENV'), config, prisma as never),
    ).toBeInstanceOf(EnvKeyCustody);
  });

  it('el custodio ENV lee el índice de derivación de chain_accounts', async () => {
    const reader = {
      get: jest.fn((key: string) =>
        key === 'CHAIN_DEV_WINERY_SEED' ? SEP5_MNEMONIC : undefined,
      ),
    };
    prisma.chainAccount.findUnique.mockResolvedValue({ derivationIndex: 1 });
    const custody = createKeyCustody(
      settings('ENV'),
      reader as never,
      prisma as never,
    );
    const ref = wineryCustodyRef(WINERY_ID);
    expect(await custody.publicKey(ref)).toBe(SEP5_ADDRESSES[1]);
    expect(prisma.chainAccount.findUnique).toHaveBeenCalledWith({
      where: {
        network_custodyKeyRef: { network: 'TESTNET', custodyKeyRef: ref },
      },
      select: { derivationIndex: true },
    });
  });
});
