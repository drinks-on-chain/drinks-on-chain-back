import { AppException } from '@shared/exceptions/app.exception';
import { ValidationException } from '@shared/exceptions/validation.exception';
import { SETTINGS_CATALOG, settingEntry } from '../settings.catalog';
import {
  isLaxerThanLegalMinimum,
  validateSettingValue,
} from '../settings.validation';
import type { SettingCatalogEntry } from '../settings.types';

function entry(key: string): SettingCatalogEntry {
  const found = settingEntry(key);
  if (!found) throw new Error(`falta ${key}`);
  return found;
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppException) return error.errorCode;
    throw error;
  }
  return undefined;
}

describe('catálogo de parámetros (docs-back/05 §4)', () => {
  it('tiene las 27 claves del catálogo, sin repetir', () => {
    const keys = SETTINGS_CATALOG.map((e) => e.key);
    expect(keys).toHaveLength(27);
    expect(new Set(keys).size).toBe(27);
  });

  it('mínimos legales de A-31: altitud 1600, Moscatel de Alejandría, reposo 180', () => {
    expect(entry('trazabilidad.singani.altitudMinimaMsnm').legalMinimum).toBe(
      1600,
    );
    expect(
      entry('trazabilidad.singani.variedadesExigidas').legalMinimum,
    ).toEqual(['Moscatel de Alejandría']);
    expect(entry('trazabilidad.singani.reposoMinimoDias').legalMinimum).toBe(
      180,
    );
  });

  it('cada valor por defecto es válido para su definición', () => {
    for (const def of SETTINGS_CATALOG) {
      const scope = def.levels === 'WINERY' ? 'WINERY' : 'GLOBAL';
      expect(() =>
        validateSettingValue(def, def.default, { scope }),
      ).not.toThrow();
    }
  });
});

describe('validateSettingValue', () => {
  const altitude = entry('trazabilidad.singani.altitudMinimaMsnm');
  const varieties = entry('trazabilidad.singani.variedadesExigidas');

  it('tipo y límites → 422 VALIDATION_ERROR en value', () => {
    expect(() =>
      validateSettingValue(altitude, 'alto', { scope: 'GLOBAL' }),
    ).toThrow(ValidationException);
    expect(() =>
      validateSettingValue(altitude, 1700.5, { scope: 'GLOBAL' }),
    ).toThrow(/entero/);
    expect(() =>
      validateSettingValue(altitude, 6000, { scope: 'GLOBAL' }),
    ).toThrow(/menor o igual/);
    expect(() =>
      validateSettingValue(entry('compra.minutosReserva'), null, {
        scope: 'GLOBAL',
      }),
    ).toThrow(/vacío/);
    expect(() =>
      validateSettingValue(entry('canje.ventanaVencida.accion'), 'QUEMAR', {
        scope: 'GLOBAL',
      }),
    ).toThrow(/BURN, EXTEND, COMPENSATE/);
    expect(() =>
      validateSettingValue(varieties, ['A', 'a'], { scope: 'GLOBAL' }),
    ).toThrow(/repetidos/);
    expect(() =>
      validateSettingValue(entry('trazabilidad.laboratorio.limites'), [1], {
        scope: 'GLOBAL',
      }),
    ).toThrow(/objeto/);
    expect(() =>
      validateSettingValue(altitude, undefined, { scope: 'GLOBAL' }),
    ).toThrow(/Falta/);
  });

  it('número o ilimitado admite null', () => {
    expect(
      validateSettingValue(entry('compra.maxBotellasPorCompra'), null, {
        scope: 'GLOBAL',
      }).value,
    ).toBeNull();
  });

  it('nivel no permitido → 422 SETTING_LEVEL_NOT_ALLOWED', () => {
    expect(
      codeOf(() =>
        validateSettingValue(entry('compra.minutosReserva'), 20, {
          scope: 'WINERY',
        }),
      ),
    ).toBe('SETTING_LEVEL_NOT_ALLOWED');
    expect(
      codeOf(() =>
        validateSettingValue(entry('trazabilidad.excepcionMinimoLegal'), true, {
          scope: 'GLOBAL',
        }),
      ),
    ).toBe('SETTING_LEVEL_NOT_ALLOWED');
  });

  it('más laxo que el mínimo legal → 422 SETTING_BELOW_LEGAL_MINIMUM', () => {
    expect(
      codeOf(() => validateSettingValue(altitude, 1500, { scope: 'GLOBAL' })),
    ).toBe('SETTING_BELOW_LEGAL_MINIMUM');
    expect(
      codeOf(() => validateSettingValue(altitude, 1500, { scope: 'WINERY' })),
    ).toBe('SETTING_BELOW_LEGAL_MINIMUM');
    expect(
      codeOf(() =>
        validateSettingValue(
          varieties,
          ['Moscatel de Alejandría', 'Torrontés'],
          { scope: 'WINERY' },
        ),
      ),
    ).toBe('SETTING_BELOW_LEGAL_MINIMUM');
    // El estándar general nunca baja del mínimo, ni con excepción
    expect(
      codeOf(() =>
        validateSettingValue(altitude, 1500, {
          scope: 'GLOBAL',
          legalException: true,
        }),
      ),
    ).toBe('SETTING_BELOW_LEGAL_MINIMUM');
  });

  it('un ajuste por bodega con excepción legal pasa y queda marcado', () => {
    expect(
      validateSettingValue(altitude, 1500, {
        scope: 'WINERY',
        legalException: true,
      }),
    ).toEqual({ value: 1500, belowLegalMinimum: true });
    // Más estricto que el mínimo: sin marca aunque se pida la excepción
    expect(
      validateSettingValue(altitude, 1800, {
        scope: 'WINERY',
        legalException: true,
      }),
    ).toEqual({ value: 1800, belowLegalMinimum: false });
  });

  it('isLaxerThanLegalMinimum: número menor o lista con elementos de fuera', () => {
    expect(isLaxerThanLegalMinimum(altitude, 1599)).toBe(true);
    expect(isLaxerThanLegalMinimum(altitude, 1600)).toBe(false);
    expect(isLaxerThanLegalMinimum(varieties, ['moscatel de alejandría'])).toBe(
      false,
    );
    expect(isLaxerThanLegalMinimum(varieties, ['Malbec'])).toBe(true);
    expect(isLaxerThanLegalMinimum(entry('canje.ventanaDias'), 1)).toBe(false);
  });
});
