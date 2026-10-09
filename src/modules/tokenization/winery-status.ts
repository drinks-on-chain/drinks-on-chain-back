import type { Prisma } from '@prisma/client';
import { AuditAction } from '@shared/audit/audit.actions';
import type { AuditService } from '@shared/audit/audit.service';
import type { OutboxService } from '@shared/outbox/outbox.service';
import { lockLotRow } from '@modules/lots/trace-db';
import type { MailService } from '@modules/mail/mail.service';
import { rejectRequestInTx } from './request-writes';
import { OPEN_TOKENIZATION_REQUEST_STATUSES } from './tokenization.constants';
import {
  COLLECTION_AGGREGATE,
  COLLECTION_PAUSED,
  type CollectionEventPayload,
} from './tokenization.events';

/**
 * Efectos en la base de datos de suspender o revocar una bodega (contrato O3
 * §3.5, S-8), dentro de la transacción que cambia su estado:
 *
 * - `SUSPENDED` y `REVOKED`: sus colecciones `PUBLISHED` pasan a `PAUSED` por
 *   el sistema, con el motivo. Al reactivarla siguen `PAUSED` hasta que
 *   operaciones las reanude.
 * - `REVOKED`: además, sus solicitudes abiertas quedan `REJECTED` por el
 *   sistema (se avisa al dueño).
 *
 * La pausa del contrato en la red al revocar (`PAUSE_CONTRACT`) es del módulo
 * `chain` (paso 3.2); aquí no sale nada a la red.
 */
export async function applyWineryStatusToTokenization(
  tx: Prisma.TransactionClient,
  deps: { audit: AuditService; mail: MailService; outbox: OutboxService },
  winery: { id: string },
  to: 'SUSPENDED' | 'REVOKED',
  reason: string,
): Promise<{ pausedCollections: number; rejectedRequests: number }> {
  const at = new Date();
  const label = to === 'REVOKED' ? 'Bodega revocada' : 'Bodega suspendida';
  const note = reason ? `${label}: ${reason}` : label;

  const collections = await tx.collection.findMany({
    where: { wineryId: winery.id, status: 'PUBLISHED' },
    select: { id: true, lotId: true, slug: true },
    orderBy: { createdAt: 'asc' },
  });
  for (const collection of collections) {
    await lockLotRow(tx, collection.lotId);
    const changed = await tx.collection.updateMany({
      where: { id: collection.id, status: 'PUBLISHED' },
      data: { status: 'PAUSED' },
    });
    if (changed.count === 0) continue;
    await tx.collectionStatusHistory.create({
      data: {
        collectionId: collection.id,
        status: 'PAUSED',
        reason: note,
        actorSystem: true,
        at,
      },
    });
    await deps.audit.record(tx, {
      action: AuditAction.COLLECTION_PAUSED,
      resource: { type: 'collection', id: collection.id },
      organizationId: winery.id,
      before: { status: 'PUBLISHED' },
      after: { status: 'PAUSED', wineryStatus: to },
      reason: note,
      actor: null,
    });
    await deps.outbox.add<CollectionEventPayload>(tx, {
      type: COLLECTION_PAUSED,
      aggregateType: COLLECTION_AGGREGATE,
      aggregateId: collection.id,
      payload: {
        collectionId: collection.id,
        wineryId: winery.id,
        lotId: collection.lotId,
        slug: collection.slug,
        status: 'PAUSED',
        system: true,
      },
    });
  }

  let rejectedRequests = 0;
  if (to === 'REVOKED') {
    const requests = await tx.tokenizationRequest.findMany({
      where: {
        wineryId: winery.id,
        status: { in: [...OPEN_TOKENIZATION_REQUEST_STATUSES] },
      },
      select: {
        id: true,
        wineryId: true,
        lotId: true,
        kind: true,
        quantity: true,
        status: true,
        lot: { select: { name: true } },
      },
      orderBy: { submittedAt: 'asc' },
    });
    for (const request of requests) {
      await lockLotRow(tx, request.lotId);
      const current = await tx.tokenizationRequest.findUniqueOrThrow({
        where: { id: request.id },
        select: { status: true },
      });
      if (
        !(OPEN_TOKENIZATION_REQUEST_STATUSES as readonly string[]).includes(
          current.status,
        )
      ) {
        continue;
      }
      await rejectRequestInTx(
        tx,
        deps,
        { ...request, status: current.status, lotName: request.lot.name },
        { reason: note, actor: null, at },
      );
      rejectedRequests += 1;
    }
  }
  return { pausedCollections: collections.length, rejectedRequests };
}
