import {
  deriveLotPrefix,
  lotPrefixCandidates,
  slugify,
  uniqueSlug,
} from '../winery-identity';

describe('identidad de la bodega (slug y prefijo de lote, ORG-05)', () => {
  it('slugify: minúsculas sin tildes, guiones y sin el prefijo "bodega"', () => {
    expect(slugify('Bodega Altos de Calamuchita')).toBe('altos-de-calamuchita');
    expect(slugify('Bodegas Viñedos Ñandú  S.R.L.')).toBe(
      'vinedos-nandu-s-r-l',
    );
    expect(slugify('Destilería Cinti Viejo')).toBe('destileria-cinti-viejo');
    expect(slugify('¡!')).toBe('bodega');
    expect(slugify('x'.repeat(300))).toHaveLength(100);
  });

  it('uniqueSlug añade -2, -3… si está tomado', () => {
    const taken = new Set(['altos', 'altos-2']);
    expect(uniqueSlug('Altos', taken)).toBe('altos-3');
    expect(uniqueSlug('Otra', taken)).toBe('otra');
  });

  it('prefijo: iniciales de las palabras significativas, completadas con la última', () => {
    expect(lotPrefixCandidates('Altos del Sur')[0]).toBe('ASU');
    expect(lotPrefixCandidates('Casa Uriondo')[0]).toBe('URI');
    expect(lotPrefixCandidates('Viñedos Ñandú')[0]).toBe('NAN');
    expect(lotPrefixCandidates('Bodega Altos de Calamuchita')[0]).toBe('ACA');
    expect(lotPrefixCandidates('Tierra Alta del Valle Central')[0]).toBe('TAV');
    // Sin palabras significativas: las genéricas; sin letras: DOC
    expect(lotPrefixCandidates('Bodega')[0]).toBe('BOD');
    expect(lotPrefixCandidates('123')[0]).toBe('DOC');
    // Una palabra corta se completa con sus letras y, si no alcanza, con X
    expect(lotPrefixCandidates('Yo')[0]).toBe('YOO');
    expect(lotPrefixCandidates('Z')[0]).toBe('ZXX');
  });

  it('desambiguación: 4 y 5 letras y, por último, otra letra final; siempre 3–5 mayúsculas', () => {
    const candidates = lotPrefixCandidates('Altos del Sur');
    expect(candidates.slice(0, 3)).toEqual(['ASU', 'ASUO', 'ASUOS']);
    expect(candidates.every((c) => /^[A-Z]{3,5}$/.test(c))).toBe(true);
    expect(new Set(candidates).size).toBe(candidates.length);
    expect(deriveLotPrefix('Altos del Sur', new Set(['ASU']))).toBe('ASUO');
    expect(
      deriveLotPrefix('Altos del Sur', new Set(['ASU', 'ASUO', 'ASUOS'])),
    ).toBe('ASA');
    const all = new Set(candidates);
    expect(deriveLotPrefix('Altos del Sur', all)).toBeNull();
  });
});
