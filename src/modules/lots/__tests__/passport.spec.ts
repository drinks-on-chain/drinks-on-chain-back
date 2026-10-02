import { generateBottleCode } from '../domain/bottle-code';
import { isLateEntry } from '../domain/late-entry';
import {
  bottleLeaf,
  findMerkleVariant,
  MERKLE_VARIANTS,
  merkleLevels,
  merkleProof,
  merkleRoot,
  verifyMerkleProof,
} from '../domain/merkle';
import { LOT_EVENT_TYPES } from '../lot-events';
import { passportLookupLimits } from '../passport/passport-lookup-limiter';
import { publicEventSummary } from '../passport/passport-view';
import {
  classifyPassportCode,
  normalizeLotCode,
} from '../passport/public-passport.service';

describe('código del visor (contrato O2 §12.1)', () => {
  it('código de botella: normalizado (minúsculas, guion, espacios, O/I/L) y con control válido', () => {
    const code = generateBottleCode();
    const typed = `${code.slice(0, 4).toLowerCase()}-${code.slice(4)} `;
    expect(classifyPassportCode(typed)).toEqual({ kind: 'BOTTLE', code });
    expect(classifyPassportCode(code.replace(/0/g, 'O'))).toEqual({
      kind: 'BOTTLE',
      code,
    });
  });

  it('código de lote: mayúsculas y sin espacios, también los anteriores a la Ola 2', () => {
    expect(classifyPassportCode(' cvj-2026-singani-004 ')).toEqual({
      kind: 'LOT',
      code: 'CVJ-2026-SINGANI-004',
    });
    expect(normalizeLotCode('ALT-2024-SINGANI-777')).toBe(
      'ALT-2024-SINGANI-777',
    );
    expect(normalizeLotCode('CVJ-2026')).toBeNull();
    expect(normalizeLotCode('CVJ_2026_SINGANI_004')).toBeNull();
    expect(normalizeLotCode('CVJ-2026-SINGANI-004/../x')).toBeNull();
    expect(normalizeLotCode(`A-B-${'C'.repeat(120)}`)).toBeNull();
  });

  it('forma imposible o control inválido: MALFORMED (nunca llega a la base)', () => {
    const code = generateBottleCode();
    const last = code[code.length - 1];
    const wrong = code.slice(0, -1) + (last === '0' ? '1' : '0');
    for (const input of [
      wrong,
      'UUUUUUUU',
      '',
      '   ',
      'x',
      'K7M2Q9X',
      "'; DROP TABLE lots; --",
      'A'.repeat(101),
    ]) {
      expect(classifyPassportCode(input)).toEqual({ kind: 'MALFORMED' });
    }
  });
});

describe('texto público de la línea de tiempo (S-21, S-22)', () => {
  it('cada tipo de evento tiene un texto propio sin cifras ni nombres', () => {
    for (const type of LOT_EVENT_TYPES) {
      const summary = publicEventSummary(type, {
        decision: 'APPROVED',
        productType: 'SINGANI',
        netKg: 18400,
        reason: 'Motivo interno',
        harvestBatchCode: 'HARV-2026-CINTI02-001',
      });
      expect(summary.length).toBeGreaterThan(5);
      expect(summary).not.toMatch(/\d/);
      expect(summary).not.toContain('Motivo interno');
      expect(summary).not.toContain('HARV-');
    }
  });

  it('el dictamen y el destino se cuentan; un dato desconocido no se inventa', () => {
    expect(
      publicEventSummary('PHYTO_DECIDED', { decision: 'QUARANTINE' }),
    ).toBe('Dictamen fitosanitario: en cuarentena');
    expect(publicEventSummary('PHYTO_DECIDED', { decision: 'OTRO' })).toBe(
      'Dictamen fitosanitario registrado',
    );
    expect(publicEventSummary('PRODUCT_DECIDED', { productType: 'WINE' })).toBe(
      'Destino del lote: vino',
    );
    expect(publicEventSummary('PRODUCT_DECIDED', {})).toBe(
      'Destino del lote decidido',
    );
    expect(
      publicEventSummary('LOT_DISCARDED', { reason: 'Contaminación' }),
    ).toBe('Lote retirado por la bodega');
  });

  it('registro tardío: más de 7 días entre el hecho y el registro (S-9)', () => {
    const recorded = new Date('2026-10-01T12:00:00Z');
    expect(isLateEntry(new Date('2026-09-24T12:00:00Z'), recorded)).toBe(false);
    expect(isLateEntry(new Date('2026-09-24T11:59:59Z'), recorded)).toBe(true);
    expect(isLateEntry(new Date('2026-10-01T12:00:00Z'), recorded)).toBe(false);
  });
});

describe('freno a la enumeración (S-24)', () => {
  it('20 códigos inexistentes en 10 minutos por defecto; ajustable por entorno', () => {
    expect(passportLookupLimits({})).toEqual({
      maxMisses: 20,
      windowSeconds: 600,
    });
    expect(
      passportLookupLimits({
        PASSPORT_MISS_LIMIT: '5',
        PASSPORT_MISS_WINDOW_SECONDS: '60',
      }),
    ).toEqual({ maxMisses: 5, windowSeconds: 60 });
    // Un valor inválido no desactiva el freno
    expect(
      passportLookupLimits({
        PASSPORT_MISS_LIMIT: '0',
        PASSPORT_MISS_WINDOW_SECONDS: 'nunca',
      }),
    ).toEqual({ maxMisses: 20, windowSeconds: 600 });
  });
});

describe('prueba Merkle de una botella (contrato O2 §10 y §12.2)', () => {
  const units = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      serial: i + 1,
      code: generateBottleCode(),
      salt: (i + 1).toString(16).padStart(32, '0'),
    }));
  const leavesOf = (list: ReturnType<typeof units>) =>
    list.map((u) => bottleLeaf(u.serial, u.code, u.salt));

  it('la hoja es SHA-256("{serie}:{código}:{sal}")', () => {
    expect(bottleLeaf(1, 'K7M2Q9XA', '00')).toBe(
      'dde7644dd3aa44be0410cfd76238d2169f97f65217861d8274b5e417c67e3f3a',
    );
    expect(bottleLeaf(1, 'K7M2Q9XA', '00')).not.toBe(
      bottleLeaf(2, 'K7M2Q9XA', '00'),
    );
    expect(bottleLeaf(1, 'K7M2Q9XA', '00')).not.toBe(
      bottleLeaf(1, 'K7M2Q9XA', '01'),
    );
  });

  it.each(MERKLE_VARIANTS)(
    'con $odd/$concat cada botella reproduce la raíz, con cualquier número de hojas',
    (variant) => {
      for (const count of [1, 2, 3, 5, 8, 13, 100]) {
        const list = units(count);
        const leaves = leavesOf(list);
        const levels = merkleLevels(leaves, variant);
        const root = merkleRoot(leaves, variant) as string;
        expect(root).toMatch(/^[0-9a-f]{64}$/);
        list.forEach((_, index) => {
          const path = merkleProof(levels, index, variant);
          expect(
            verifyMerkleProof(leaves[index], path, root, variant.concat),
          ).toBe(true);
        });
      }
    },
  );

  it('una hoja, un camino o una raíz ajenos no verifican', () => {
    const variant = MERKLE_VARIANTS[0];
    const list = units(7);
    const leaves = leavesOf(list);
    const levels = merkleLevels(leaves, variant);
    const root = merkleRoot(leaves, variant) as string;
    const path = merkleProof(levels, 3, variant);
    expect(verifyMerkleProof(leaves[3], path, root, 'BYTES')).toBe(true);
    expect(verifyMerkleProof(leaves[4], path, root, 'BYTES')).toBe(false);
    expect(verifyMerkleProof(leaves[3], path.slice(1), root, 'BYTES')).toBe(
      false,
    );
    expect(
      verifyMerkleProof(
        leaves[3],
        path,
        merkleRoot(leaves.slice(1), variant) as string,
        'BYTES',
      ),
    ).toBe(false);
    // Otro código en la misma serie (una etiqueta falsificada) tampoco
    const forged = bottleLeaf(4, generateBottleCode(), list[3].salt);
    expect(verifyMerkleProof(forged, path, root, 'BYTES')).toBe(false);
  });

  it('reconoce con qué construcción se hizo la raíz y no acepta una raíz ajena', () => {
    const leaves = leavesOf(units(11));
    for (const variant of MERKLE_VARIANTS) {
      const root = merkleRoot(leaves, variant) as string;
      expect(findMerkleVariant(leaves, root.toUpperCase())).toEqual(variant);
    }
    expect(findMerkleVariant(leaves, 'f'.repeat(64))).toBeNull();
    expect(findMerkleVariant([], 'f'.repeat(64))).toBeNull();
    expect(merkleRoot([], MERKLE_VARIANTS[0])).toBeNull();
  });
});
