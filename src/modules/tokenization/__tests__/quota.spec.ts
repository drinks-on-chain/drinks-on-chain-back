import {
  computeLimits,
  estimateBelowMinted,
  lotBlockers,
  mintChunks,
  quantityViolations,
  requestKind,
  submissionBlockers,
  type QuotaLot,
} from '../domain/quota';

const lot = (overrides: Partial<QuotaLot> = {}): QuotaLot => ({
  stage: 'ORIGIN',
  productType: 'SINGANI',
  estimatedBottles: 3000,
  bottled: false,
  activeBottles: 0,
  authorizedQuota: 0,
  pendingQuantity: 0,
  ...overrides,
});

describe('Reglas de la cuota (contrato O3 §5.2, R6)', () => {
  describe('límites', () => {
    it('antes del embotellado el límite es la estimación', () => {
      expect(computeLimits(lot())).toEqual({
        basis: 'ESTIMATE',
        estimatedBottles: 3000,
        bottles: null,
        authorizedQuota: 0,
        pendingQuantity: 0,
        maxQuantity: 3000,
      });
    });

    it('lo que queda = límite − autorizada − pendiente', () => {
      expect(
        computeLimits(lot({ authorizedQuota: 100, pendingQuantity: 50 }))
          .maxQuantity,
      ).toBe(2850);
    });

    it('desde el embotellado el límite son los códigos ACTIVE, aunque la estimación sea mayor', () => {
      expect(
        computeLimits(
          lot({ bottled: true, activeBottles: 2950, authorizedQuota: 100 }),
        ),
      ).toMatchObject({ basis: 'BOTTLES', bottles: 2950, maxQuantity: 2850 });
    });

    it('nunca es negativo (faltante: menos botellas que NFT) y es 0 sin estimación', () => {
      expect(
        computeLimits(
          lot({ bottled: true, activeBottles: 80, authorizedQuota: 100 }),
        ).maxQuantity,
      ).toBe(0);
      expect(computeLimits(lot({ estimatedBottles: null })).maxQuantity).toBe(
        0,
      );
    });
  });

  describe('lote tokenizable', () => {
    it.each(['ORIGIN', 'HARVEST', 'FERMENTING', 'AGING', 'RESTING', 'BOTTLED'])(
      'en %s se puede',
      (stage) => {
        expect(lotBlockers(lot({ stage }))).toEqual([]);
      },
    );

    it.each(['CERTIFIED', 'ANCHORED', 'REJECTED', 'DISCARDED'])(
      'en %s → TOK_LOT_NOT_TOKENIZABLE con la etapa',
      (stage) => {
        expect(lotBlockers(lot({ stage }))).toEqual([
          expect.objectContaining({
            code: 'TOK_LOT_NOT_TOKENIZABLE',
            meta: { stage },
          }),
        ]);
      },
    );

    it('sin tipo de producto ni estimación: un bloqueo por cada uno, en el orden del contrato', () => {
      expect(
        lotBlockers(lot({ productType: null, estimatedBottles: null })).map(
          (b) => b.code,
        ),
      ).toEqual(['TOK_LOT_PRODUCT_UNDEFINED', 'TOK_LOT_ESTIMATE_MISSING']);
    });

    it('con la colección cerrada no admite ampliaciones', () => {
      expect(lotBlockers(lot({ collectionClosed: true }))[0]).toMatchObject({
        code: 'TOK_LOT_NOT_TOKENIZABLE',
        meta: { collectionStatus: 'CLOSED' },
      });
    });
  });

  describe('cantidad', () => {
    it('justo el límite pasa; uno más → TOK_QUOTA_EXCEEDS_ESTIMATE con expected, actual y maxQuantity', () => {
      expect(quantityViolations(lot(), 3000)).toEqual([]);
      expect(quantityViolations(lot(), 3001)).toEqual([
        expect.objectContaining({
          field: 'quantity',
          code: 'TOK_QUOTA_EXCEEDS_ESTIMATE',
          expected: 3000,
          actual: 3001,
          meta: { maxQuantity: 3000, authorizedQuota: 0 },
        }),
      ]);
    });

    it('una ampliación cuenta la cuota ya autorizada y lo explica', () => {
      const [violation] = quantityViolations(
        lot({ authorizedQuota: 100 }),
        2901,
      );
      expect(violation).toMatchObject({
        code: 'TOK_QUOTA_EXCEEDS_ESTIMATE',
        expected: 3000,
        actual: 3001,
        meta: { maxQuantity: 2900 },
      });
      expect(violation.message).toBe(
        'Puedes autorizar hasta 2.900 botellas: la estimación del lote es 3.000 y ya hay 100 autorizadas',
      );
    });

    it('desde el embotellado → TOK_QUOTA_EXCEEDS_BOTTLES', () => {
      expect(
        quantityViolations(
          lot({ bottled: true, activeBottles: 2950, authorizedQuota: 150 }),
          2801,
        )[0],
      ).toMatchObject({
        code: 'TOK_QUOTA_EXCEEDS_BOTTLES',
        expected: 2950,
        actual: 2951,
        meta: { maxQuantity: 2800 },
      });
    });

    it.each([0, -1, 1.5, Number.NaN])(
      '%p no es una cantidad → TOK_QUOTA_INVALID',
      (quantity) => {
        expect(quantityViolations(lot(), quantity)[0].code).toBe(
          'TOK_QUOTA_INVALID',
        );
      },
    );

    it('la solicitud pendiente no cuenta contra sí misma al validarla', () => {
      expect(quantityViolations(lot({ pendingQuantity: 3000 }), 3000)).toEqual(
        [],
      );
    });
  });

  describe('bloqueos de envío', () => {
    it('solicitud abierta → TOK_REQUEST_ALREADY_OPEN con su id', () => {
      expect(submissionBlockers(lot(), 'req-1')).toEqual([
        expect.objectContaining({
          code: 'TOK_REQUEST_ALREADY_OPEN',
          meta: { requestId: 'req-1' },
        }),
      ]);
    });

    it('cuota agotada: lo dice con el código del límite', () => {
      expect(
        submissionBlockers(lot({ authorizedQuota: 3000 }), null)[0],
      ).toMatchObject({
        code: 'TOK_QUOTA_EXCEEDS_ESTIMATE',
        meta: { maxQuantity: 0 },
      });
      expect(submissionBlockers(lot({ authorizedQuota: 2999 }), null)).toEqual(
        [],
      );
    });
  });

  it('el tipo lo deduce el servidor: sin colección INITIAL; con colección QUOTA_INCREASE', () => {
    expect(requestKind(false)).toBe('INITIAL');
    expect(requestKind(true)).toBe('QUOTA_INCREASE');
  });

  describe('la estimación no baja de lo emitido (§5.2.6)', () => {
    it('igual a lo emitido pasa; por debajo → TOK_ESTIMATE_BELOW_MINTED', () => {
      expect(estimateBelowMinted(100, 100)).toBeNull();
      expect(estimateBelowMinted(99, 100)).toMatchObject({
        field: 'estimatedBottles',
        code: 'TOK_ESTIMATE_BELOW_MINTED',
        expected: 100,
        actual: 99,
      });
    });

    it('sin nada emitido se puede bajar a cualquier valor', () => {
      expect(estimateBelowMinted(1, 0)).toBeNull();
    });
  });

  describe('trozos de la emisión (§6.1, DS-13)', () => {
    it('1 y 100 caben en un trozo, numerados desde 1', () => {
      expect(mintChunks(1, 0)).toEqual([
        { index: 1, amount: 1, firstBottleNumber: 1, lastBottleNumber: 1 },
      ]);
      expect(mintChunks(100, 0)).toEqual([
        { index: 1, amount: 100, firstBottleNumber: 1, lastBottleNumber: 100 },
      ]);
    });

    it('32 000 es un trozo; 32 001 son dos, en orden y sin huecos', () => {
      expect(mintChunks(32_000, 0)).toHaveLength(1);
      expect(mintChunks(32_001, 0)).toEqual([
        {
          index: 1,
          amount: 32_000,
          firstBottleNumber: 1,
          lastBottleNumber: 32_000,
        },
        {
          index: 2,
          amount: 1,
          firstBottleNumber: 32_001,
          lastBottleNumber: 32_001,
        },
      ]);
    });

    it('una ampliación sigue la numeración: la primera empieza en la cuota anterior + 1', () => {
      expect(mintChunks(50, 100)).toEqual([
        { index: 1, amount: 50, firstBottleNumber: 101, lastBottleNumber: 150 },
      ]);
    });

    it('los trozos suman la cantidad y ninguno pasa del máximo', () => {
      const chunks = mintChunks(100_000, 7);
      expect(chunks.reduce((sum, c) => sum + c.amount, 0)).toBe(100_000);
      expect(Math.max(...chunks.map((c) => c.amount))).toBe(32_000);
      expect(chunks[0].firstBottleNumber).toBe(8);
      expect(chunks[chunks.length - 1].lastBottleNumber).toBe(100_007);
      for (let i = 1; i < chunks.length; i++) {
        expect(chunks[i].firstBottleNumber).toBe(
          chunks[i - 1].lastBottleNumber + 1,
        );
      }
    });

    it('una cantidad que no es un entero positivo no se trocea', () => {
      expect(() => mintChunks(0, 0)).toThrow(RangeError);
      expect(() => mintChunks(1.5, 0)).toThrow(RangeError);
    });
  });
});
