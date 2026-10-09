import type { Prisma } from '@prisma/client';
import { AuditAction } from '@shared/audit/audit.actions';
import type { AuditService } from '@shared/audit/audit.service';
import type { OutboxService } from '@shared/outbox/outbox.service';
import type { MailService } from '@modules/mail/mail.service';
import { nextRequestStatus } from './domain/state-machines';
import { SYSTEM_ACTOR_NAME, wineryOwners } from './tokenization-data';
import type { TokenizationRequestStatus } from './tokenization.constants';
import {
  TOKENIZATION_REQUEST_AGGREGATE,
  TOKENIZATION_REQUEST_REJECTED,
  type TokenizationRequestEventPayload,
} from './tokenization.events';

type Tx = Prisma.TransactionClient;

/** Persona del back office que actúa. */
export interface StaffActor {
  userId: string;
  fullName: string;
}

/** Entrada del historial de estados de la solicitud (solo inserción). */
export async function recordStatusChange(
  tx: Tx,
  requestId: string,
  status: TokenizationRequestStatus,
  by: {
    userId?: string | null;
    membershipId?: string | null;
    name?: string | null;
    system?: boolean;
    note?: string | null;
    at: Date;
  },
): Promise<void> {
  await tx.tokenizationRequestChange.create({
    data: {
      requestId,
      type: 'STATUS',
      status,
      message: by.note ?? null,
      actorUserId: by.userId ?? null,
      actorMembershipId: by.membershipId ?? null,
      actorName: by.system ? SYSTEM_ACTOR_NAME : (by.name ?? null),
      actorSystem: by.system ?? false,
      createdAt: by.at,
    },
  });
}

/**
 * Rechaza una solicitud abierta dentro de `tx` (con el lote ya bloqueado):
 * estado, decisión, historial, bitácora, evento y correo al dueño. `actor:
 * null` = el sistema (bodega revocada, §3.5). 409 si no está abierta.
 */
export async function rejectRequestInTx(
  tx: Tx,
  deps: { audit: AuditService; mail: MailService; outbox: OutboxService },
  request: {
    id: string;
    wineryId: string;
    lotId: string;
    kind: string;
    quantity: number;
    status: string;
    lotName: string;
  },
  by: { reason: string; actor: StaffActor | null; at: Date },
): Promise<void> {
  const to = nextRequestStatus(
    request.status as TokenizationRequestStatus,
    'REJECT',
  );
  await tx.tokenizationRequest.update({
    where: { id: request.id },
    data: {
      status: to,
      decisionOutcome: 'REJECTED',
      decisionAt: by.at,
      decisionReason: by.reason,
      decisionByUserId: by.actor?.userId ?? null,
      decisionBySystem: by.actor === null,
    },
  });
  await recordStatusChange(tx, request.id, to, {
    userId: by.actor?.userId ?? null,
    name: by.actor?.fullName ?? null,
    system: by.actor === null,
    note: by.reason,
    at: by.at,
  });
  await deps.audit.record(tx, {
    action: AuditAction.TOKENIZATION_REJECTED,
    resource: { type: 'tokenization_request', id: request.id },
    organizationId: request.wineryId,
    before: { status: request.status },
    after: { status: to },
    reason: by.reason,
    ...(by.actor === null && { actor: null }),
  });
  await deps.outbox.add<TokenizationRequestEventPayload>(tx, {
    type: TOKENIZATION_REQUEST_REJECTED,
    aggregateType: TOKENIZATION_REQUEST_AGGREGATE,
    aggregateId: request.id,
    payload: {
      requestId: request.id,
      wineryId: request.wineryId,
      lotId: request.lotId,
      kind: request.kind,
      quantity: request.quantity,
    },
  });
  for (const owner of await wineryOwners(tx, request.wineryId)) {
    await deps.mail.enqueue(tx, {
      template: 'tokenizacion-rechazada',
      to: owner.email,
      organizationId: request.wineryId,
      variables: {
        nombre: owner.fullName,
        lote: request.lotName,
        motivo: by.reason,
      },
    });
  }
}
