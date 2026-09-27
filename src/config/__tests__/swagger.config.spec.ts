import { isSwaggerEnabled } from '../swagger.config';

describe('isSwaggerEnabled (SE-08)', () => {
  it('sin valor: activo fuera de producción, apagado en producción', () => {
    expect(isSwaggerEnabled(undefined, 'development')).toBe(true);
    expect(isSwaggerEnabled('', 'test')).toBe(true);
    expect(isSwaggerEnabled(undefined, 'production')).toBe(false);
  });

  it('el valor explícito manda', () => {
    expect(isSwaggerEnabled('true', 'production')).toBe(true);
    expect(isSwaggerEnabled(true, 'production')).toBe(true);
    expect(isSwaggerEnabled('false', 'development')).toBe(false);
    expect(isSwaggerEnabled(false, 'development')).toBe(false);
  });
});
