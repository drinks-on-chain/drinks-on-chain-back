import { WineryApplicationStatusEnum as Status } from '@prisma/client';
import { AppException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';

/**
 * Estados de una solicitud de alta y sus transiciones (docs-back/07 §1.2,
 * contrato O1 §3; igual que `APPLICATION_TRANSITIONS` de los mocks):
 *
 * ```
 * UNVERIFIED → RECEIVED → IN_REVIEW ⇄ MEETING_SCHEDULED
 *                          IN_REVIEW → APPROVED | REJECTED
 * ```
 *
 * Cualquier otra → 409 `APPLICATION_INVALID_TRANSITION`.
 */
export const APPLICATION_TRANSITIONS: Readonly<
  Record<Status, readonly Status[]>
> = {
  UNVERIFIED: [Status.RECEIVED],
  RECEIVED: [Status.IN_REVIEW],
  IN_REVIEW: [Status.MEETING_SCHEDULED, Status.APPROVED, Status.REJECTED],
  MEETING_SCHEDULED: [Status.IN_REVIEW],
  APPROVED: [],
  REJECTED: [],
};

export function canTransition(from: Status, to: Status): boolean {
  return APPLICATION_TRANSITIONS[from].includes(to);
}

export function invalidTransition(message: string): AppException {
  return new AppException(
    409,
    ErrorCode.APPLICATION_INVALID_TRANSITION,
    message,
  );
}

export function assertTransition(from: Status, to: Status): void {
  if (!canTransition(from, to)) {
    throw invalidTransition(`La solicitud no puede pasar de ${from} a ${to}`);
  }
}
