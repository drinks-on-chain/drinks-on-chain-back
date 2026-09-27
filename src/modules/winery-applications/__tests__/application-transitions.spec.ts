import { WineryApplicationStatusEnum as Status } from '@prisma/client';
import {
  APPLICATION_TRANSITIONS,
  assertTransition,
  canTransition,
} from '../application-transitions';

describe('transiciones de una solicitud de alta (docs-back/07 §1.2)', () => {
  it('el recorrido del contrato está permitido', () => {
    expect(canTransition(Status.UNVERIFIED, Status.RECEIVED)).toBe(true);
    expect(canTransition(Status.RECEIVED, Status.IN_REVIEW)).toBe(true);
    expect(canTransition(Status.IN_REVIEW, Status.MEETING_SCHEDULED)).toBe(
      true,
    );
    expect(canTransition(Status.MEETING_SCHEDULED, Status.IN_REVIEW)).toBe(
      true,
    );
    expect(canTransition(Status.IN_REVIEW, Status.APPROVED)).toBe(true);
    expect(canTransition(Status.IN_REVIEW, Status.REJECTED)).toBe(true);
  });

  it('lo demás no: aprobar sin revisar, rechazar con reunión pendiente, reabrir', () => {
    expect(canTransition(Status.RECEIVED, Status.APPROVED)).toBe(false);
    expect(canTransition(Status.MEETING_SCHEDULED, Status.REJECTED)).toBe(
      false,
    );
    expect(canTransition(Status.UNVERIFIED, Status.IN_REVIEW)).toBe(false);
    expect(APPLICATION_TRANSITIONS.APPROVED).toEqual([]);
    expect(APPLICATION_TRANSITIONS.REJECTED).toEqual([]);
  });

  it('una transición inválida es 409 APPLICATION_INVALID_TRANSITION', () => {
    let error: unknown;
    try {
      assertTransition(Status.APPROVED, Status.REJECTED);
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({
      statusCode: 409,
      errorCode: 'APPLICATION_INVALID_TRANSITION',
    });
    expect(() =>
      assertTransition(Status.RECEIVED, Status.IN_REVIEW),
    ).not.toThrow();
  });
});
