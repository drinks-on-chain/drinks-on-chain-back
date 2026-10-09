import { AppException } from '@shared/exceptions/app.exception';
import {
  COLLECTION_TRANSITIONS,
  isOpenRequest,
  lotTokenizationState,
  nextCollectionStatus,
  nextRequestStatus,
  REQUEST_TRANSITIONS,
  saleState,
  type CollectionAction,
  type RequestAction,
} from '../domain/state-machines';
import {
  COLLECTION_STATUSES,
  TOKENIZATION_REQUEST_STATUSES,
  type CollectionStatus,
  type TokenizationRequestStatus,
} from '../tokenization.constants';

function caught(run: () => unknown): AppException {
  try {
    run();
  } catch (error) {
    return error as AppException;
  }
  throw new Error('Se esperaba un error');
}

describe('Máquina de estados de la solicitud (contrato O3 §5.3, §5.4)', () => {
  const allowed: Record<RequestAction, [TokenizationRequestStatus, string][]> =
    {
      EDIT: [
        ['SUBMITTED', 'SUBMITTED'],
        ['CHANGES_REQUESTED', 'CHANGES_REQUESTED'],
      ],
      RESUBMIT: [['CHANGES_REQUESTED', 'SUBMITTED']],
      WITHDRAW: [
        ['SUBMITTED', 'WITHDRAWN'],
        ['IN_REVIEW', 'WITHDRAWN'],
        ['CHANGES_REQUESTED', 'WITHDRAWN'],
      ],
      TAKE: [['SUBMITTED', 'IN_REVIEW']],
      REVIEW: [['IN_REVIEW', 'IN_REVIEW']],
      REQUEST_CHANGES: [['IN_REVIEW', 'CHANGES_REQUESTED']],
      APPROVE: [['IN_REVIEW', 'APPROVED']],
      REJECT: [
        ['SUBMITTED', 'REJECTED'],
        ['IN_REVIEW', 'REJECTED'],
        ['CHANGES_REQUESTED', 'REJECTED'],
      ],
    };

  it('cada acción lleva al estado del contrato desde sus estados de origen', () => {
    for (const action of Object.keys(allowed) as RequestAction[]) {
      for (const [from, to] of allowed[action]) {
        expect({ action, from, to: nextRequestStatus(from, action) }).toEqual({
          action,
          from,
          to,
        });
      }
    }
  });

  it('cualquier otra combinación → 409 TOK_REQUEST_INVALID_TRANSITION con from y to', () => {
    for (const action of Object.keys(allowed) as RequestAction[]) {
      const valid = new Set(allowed[action].map(([from]) => from));
      for (const from of TOKENIZATION_REQUEST_STATUSES) {
        if (valid.has(from)) continue;
        const error = caught(() => nextRequestStatus(from, action));
        expect({
          action,
          from,
          status: error.statusCode,
          code: error.errorCode,
        }).toEqual({
          action,
          from,
          status: 409,
          code: 'TOK_REQUEST_INVALID_TRANSITION',
        });
        const [detail] = error.details as { meta: Record<string, unknown> }[];
        expect(detail.meta).toMatchObject({
          from,
          to: REQUEST_TRANSITIONS[action].to ?? from,
        });
      }
    }
  });

  it('una solicitud decidida o retirada no admite ninguna acción', () => {
    for (const from of ['APPROVED', 'REJECTED', 'WITHDRAWN'] as const) {
      for (const action of Object.keys(allowed) as RequestAction[]) {
        expect(() => nextRequestStatus(from, action)).toThrow(AppException);
      }
    }
  });

  it('abiertas: SUBMITTED, IN_REVIEW y CHANGES_REQUESTED', () => {
    expect(TOKENIZATION_REQUEST_STATUSES.filter(isOpenRequest)).toEqual([
      'SUBMITTED',
      'IN_REVIEW',
      'CHANGES_REQUESTED',
    ]);
  });
});

describe('Máquina de estados de la colección (contrato O3 §6.2)', () => {
  const allowed: Record<CollectionAction, [CollectionStatus, string][]> = {
    PUBLISH: [['READY', 'PUBLISHED']],
    PAUSE: [['PUBLISHED', 'PAUSED']],
    RESUME: [['PAUSED', 'PUBLISHED']],
    CLOSE: [
      ['READY', 'CLOSED'],
      ['PUBLISHED', 'CLOSED'],
      ['PAUSED', 'CLOSED'],
    ],
  };

  it('publicar, pausar, reanudar y cerrar desde sus estados', () => {
    for (const action of Object.keys(allowed) as CollectionAction[]) {
      for (const [from, to] of allowed[action]) {
        expect(nextCollectionStatus(from, action)).toBe(to);
      }
    }
  });

  it('el resto → 409 TOK_COLLECTION_INVALID_TRANSITION con from y to', () => {
    for (const action of Object.keys(allowed) as CollectionAction[]) {
      const valid = new Set(allowed[action].map(([from]) => from));
      for (const from of COLLECTION_STATUSES) {
        if (valid.has(from)) continue;
        const error = caught(() => nextCollectionStatus(from, action));
        expect({ status: error.statusCode, code: error.errorCode }).toEqual({
          status: 409,
          code: 'TOK_COLLECTION_INVALID_TRANSITION',
        });
        const [detail] = error.details as { meta: Record<string, unknown> }[];
        expect(detail.meta).toMatchObject({
          from,
          to: COLLECTION_TRANSITIONS[action].to,
        });
      }
    }
  });

  it('una colección cerrada o emitiéndose no se publica, pausa ni reanuda', () => {
    for (const from of ['CLOSED', 'MINTING'] as const) {
      for (const action of ['PUBLISH', 'PAUSE', 'RESUME'] as const) {
        expect(() => nextCollectionStatus(from, action)).toThrow(AppException);
      }
    }
    expect(() => nextCollectionStatus('MINTING', 'CLOSE')).toThrow(
      AppException,
    );
  });
});

describe('Estado de venta (§6.2, derivado)', () => {
  const base = { redeemable: false, minted: 100, available: 100 };

  it('null si la colección no está publicada', () => {
    for (const status of ['MINTING', 'READY', 'PAUSED', 'CLOSED']) {
      expect(saleState({ ...base, status })).toBeNull();
    }
  });

  it('preventa hasta el anclaje; venta después; agotada sin disponibles', () => {
    expect(saleState({ ...base, status: 'PUBLISHED' })).toBe('PRESALE');
    expect(saleState({ ...base, status: 'PUBLISHED', redeemable: true })).toBe(
      'ON_SALE',
    );
    expect(
      saleState({
        ...base,
        status: 'PUBLISHED',
        available: 0,
        redeemable: true,
      }),
    ).toBe('SOLD_OUT');
  });
});

describe('Marca de tokenización del lote (§5.3)', () => {
  it('sin solicitud ni colección → NONE', () => {
    expect(lotTokenizationState(null, null)).toBe('NONE');
  });

  it('la solicitud abierta manda sobre la colección', () => {
    const collection = { status: 'PUBLISHED', mintStatus: 'CONFIRMED' };
    expect(lotTokenizationState('SUBMITTED', null)).toBe('REQUESTED');
    expect(lotTokenizationState('IN_REVIEW', collection)).toBe('REQUESTED');
    expect(lotTokenizationState('CHANGES_REQUESTED', collection)).toBe(
      'CHANGES_REQUESTED',
    );
  });

  it('sin solicitud abierta, el estado de la colección', () => {
    for (const status of ['MINTING', 'READY', 'PUBLISHED', 'PAUSED']) {
      expect(
        lotTokenizationState(null, { status, mintStatus: 'CONFIRMED' }),
      ).toBe(status);
    }
    // Una solicitud ya decidida no cuenta
    expect(
      lotTokenizationState('APPROVED', {
        status: 'MINTING',
        mintStatus: 'PENDING',
      }),
    ).toBe('MINTING');
  });

  it('emisión fallida → MINT_FAILED; cerrada → CLOSED aunque la última emisión fallara', () => {
    expect(
      lotTokenizationState(null, { status: 'MINTING', mintStatus: 'FAILED' }),
    ).toBe('MINT_FAILED');
    expect(
      lotTokenizationState(null, { status: 'PUBLISHED', mintStatus: 'FAILED' }),
    ).toBe('MINT_FAILED');
    expect(
      lotTokenizationState(null, { status: 'CLOSED', mintStatus: 'FAILED' }),
    ).toBe('CLOSED');
  });
});
