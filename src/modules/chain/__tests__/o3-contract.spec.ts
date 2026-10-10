import { notImplementedO3 } from '../contract/o3-contract';

describe('501 de la apertura de la Ola 3 (contrato O3 §12.1)', () => {
  it('lleva el paso de la Etapa 3 en el mensaje y en meta', () => {
    const error = notImplementedO3('3.4');
    expect(error.statusCode).toBe(501);
    expect(error.errorCode).toBe('NOT_IMPLEMENTED');
    expect(error.message).toContain('paso 3.4');
    expect(error.message).toContain('Emisión y preventa');
    expect(error.details).toEqual([
      expect.objectContaining({ field: null, meta: { step: '3.4' } }),
    ]);
  });
});
