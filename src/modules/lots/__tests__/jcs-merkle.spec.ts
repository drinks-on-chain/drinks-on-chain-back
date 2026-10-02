import { createHash } from 'node:crypto';
import { canonicalBytes, canonicalize } from '../domain/jcs';
import {
  bottleLeafHash,
  bottleLeafPreimage,
  merkleProof,
  merkleRoot,
  verifyMerkleProof,
} from '../domain/merkle';

const sha256 = (data: Buffer | string) =>
  createHash('sha256').update(data).digest();

describe('JSON canónico RFC 8785 (§10)', () => {
  it('serializa el ejemplo de la RFC (números ES, escapes de cadena, literales)', () => {
    const input = JSON.parse(
      '{ "numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],' +
        ' "string": "\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",' +
        ' "literals": [null, true, false] }',
    ) as unknown;
    expect(canonicalize(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it('ordena las propiedades por unidades de código UTF-16 (ejemplo de la RFC)', () => {
    const input = {
      '€': 'Euro Sign',
      '\r': 'Carriage Return',
      דּ: 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      '😀': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      ö: 'Latin Small Letter O With Diaeresis',
    };
    // En el texto (un objeto de JS enumeraría antes la clave "1")
    const values = [...canonicalize(input).matchAll(/:"([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(values).toEqual([
      'Carriage Return',
      'One',
      'Control',
      'Latin Small Letter O With Diaeresis',
      'Euro Sign',
      'Emoji: Grinning Face',
      'Hebrew Letter Dalet With Dagesh',
    ]);
  });

  it('es determinista: el orden de inserción no cambia los bytes', () => {
    const a = { b: [1, { z: 'ñ', a: null }], a: '18400.000', c: true };
    const b = { c: true, a: '18400.000', b: [1, { a: null, z: 'ñ' }] };
    expect(canonicalize(a)).toBe(
      '{"a":"18400.000","b":[1,{"a":null,"z":"ñ"}],"c":true}',
    );
    expect(canonicalBytes(a).equals(canonicalBytes(b))).toBe(true);
    // UTF-8: la ñ ocupa dos bytes
    expect(canonicalBytes({ a: 'ñ' }).length).toBe('{"a":"ñ"}'.length + 1);
  });

  it('-0 es 0 y los enteros no llevan decimales', () => {
    expect(canonicalize([-0, 0, 10, 1.5, 1e21])).toBe('[0,0,10,1.5,1e+21]');
  });

  it('rechaza lo que no es JSON: undefined, no finitos, fechas, decimales, bigint, Unicode roto', () => {
    expect(() => canonicalize({ a: undefined })).toThrow(/undefined/);
    expect(() => canonicalize([undefined])).toThrow(/undefined/);
    expect(() => canonicalize({ a: NaN })).toThrow(/no finito/);
    expect(() => canonicalize({ a: Infinity })).toThrow(/no finito/);
    expect(() => canonicalize({ a: new Date(0) })).toThrow(/no literal/);
    expect(() => canonicalize({ a: { toFixed: () => '1.0' } })).toThrow(
      /function/,
    );
    expect(() => canonicalize({ a: 10n })).toThrow(/bigint/);
    expect(() => canonicalize({ a: '\ud800' })).toThrow(/Unicode/);
    expect(() => canonicalize({ a: new Map() })).toThrow(/no literal/);
  });
});

describe('raíz Merkle de los códigos de botella (§10, §20)', () => {
  const leaves = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      bottleLeafHash(
        i + 1,
        `CODE${String(i).padStart(4, '0')}`,
        'ab'.repeat(16),
      ),
    );

  it('la hoja es SHA-256("{serie}:{código}:{sal}")', () => {
    const salt = '00112233445566778899aabbccddeeff';
    expect(bottleLeafPreimage(1234, 'K7M2Q9XA', salt)).toBe(
      `1234:K7M2Q9XA:${salt}`,
    );
    expect(bottleLeafHash(1234, 'K7M2Q9XA', salt)).toBe(
      sha256(`1234:K7M2Q9XA:${salt}`).toString('hex'),
    );
    // La sal cambia la hoja: sin ella no se pueden probar códigos vecinos
    expect(bottleLeafHash(1234, 'K7M2Q9XA', 'ff'.repeat(16))).not.toBe(
      bottleLeafHash(1234, 'K7M2Q9XA', salt),
    );
  });

  it('una hoja: la raíz es la hoja; sin hojas: SHA-256 de la cadena vacía', () => {
    const [only] = leaves(1);
    expect(merkleRoot([only])).toBe(only);
    expect(merkleRoot([])).toBe(sha256('').toString('hex'));
  });

  it('empareja de izquierda a derecha sobre los bytes y sube el nodo sin pareja', () => {
    const [a, b, c] = leaves(3).map((h) => Buffer.from(h, 'hex'));
    const ab = sha256(Buffer.concat([a, b]));
    expect(merkleRoot(leaves(2))).toBe(ab.toString('hex'));
    // Tres hojas: la tercera sube tal cual (no se duplica)
    expect(merkleRoot(leaves(3))).toBe(
      sha256(Buffer.concat([ab, c])).toString('hex'),
    );
    expect(merkleRoot(leaves(3))).not.toBe(
      merkleRoot([...leaves(3), leaves(3)[2]]),
    );
  });

  it('el orden de las hojas importa (van por número de serie)', () => {
    const list = leaves(4);
    expect(merkleRoot(list)).not.toBe(merkleRoot([...list].reverse()));
  });

  it('cada hoja tiene una prueba que lleva a la raíz, para cualquier tamaño', () => {
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 31, 100]) {
      const list = leaves(n);
      const root = merkleRoot(list);
      for (let i = 0; i < n; i++) {
        const path = merkleProof(list, i);
        expect(verifyMerkleProof(list[i], path, root)).toBe(true);
        expect(path.length).toBeLessThanOrEqual(Math.ceil(Math.log2(n)) + 0);
      }
    }
  });

  it('una prueba no sirve para otra hoja, otra raíz ni con un paso alterado', () => {
    const list = leaves(7);
    const root = merkleRoot(list);
    const path = merkleProof(list, 2);
    expect(verifyMerkleProof(list[3], path, root)).toBe(false);
    expect(verifyMerkleProof(list[2], path, merkleRoot(leaves(8)))).toBe(false);
    const flipped = path.map((s, i) =>
      i === 0
        ? { ...s, side: s.side === 'L' ? ('R' as const) : ('L' as const) }
        : s,
    );
    expect(verifyMerkleProof(list[2], flipped, root)).toBe(false);
    expect(verifyMerkleProof('no-es-un-hash', path, root)).toBe(false);
    expect(() => merkleProof(list, 7)).toThrow();
    expect(() => merkleRoot(['zz'])).toThrow();
  });

  it('5.000 botellas: raíz y prueba de 13 pasos como mucho', () => {
    const list = leaves(5000);
    const root = merkleRoot(list);
    const path = merkleProof(list, 4999);
    expect(verifyMerkleProof(list[4999], path, root)).toBe(true);
    expect(path.length).toBeLessThanOrEqual(13);
  });
});
