import { AgingStatusEnum, Prisma, RestStatusEnum } from '@prisma/client';
import { AuditAction } from '@shared/audit/audit.actions';
import type { AuditService } from '@shared/audit/audit.service';
import { dateOnly, laPazDate, toDbDate } from './domain/dates';
import { agingLock, LotLock, restLock } from './domain/locks';
import type { LotRules } from './domain/lot-rules';
import type { LotStage } from './domain/lot-stage';
import { appendLotEvent } from './lot-events';

type Tx = Prisma.TransactionClient;

export interface ReleasedLock {
  lock: LotLock;
  resourceType: 'wine_aging_batch' | 'production_batch';
}

/**
 * Persiste los candados cumplidos de un lote (contrato O2 §5.3 y §15): pasa a
 * `READY` las crianzas `AGING` y las destilaciones `RESTING` cuyo
 * `unlockDate ≤ hoy` según la **instantánea** del lote y el reloj de la base,
 * y escribe `LOCK_RELEASED` en la línea de tiempo y en la bitácora (actor
 * sistema). Idempotente: solo toca lo que sigue bloqueado. Quien llama tiene
 * bloqueada la fila del lote.
 *
 * Solo persiste el estado: el embotellado recalcula siempre los candados y
 * nunca depende de esta marca.
 */
export async function releaseDueLocks(
  tx: Tx,
  lot: { id: string; wineryId: string; stage: LotStage; rules: LotRules },
  clock: { now: Date; today: string },
  audit: AuditService,
): Promise<ReleasedLock[]> {
  const released: ReleasedLock[] = [];
  const agings = await tx.wineAgingBatch.findMany({
    where: {
      lotId: lot.id,
      agingStatus: AgingStatusEnum.AGING,
      discardedAt: null,
    },
    select: {
      id: true,
      startDate: true,
      createdAt: true,
      plannedMonths: true,
      lockUntilDate: true,
    },
  });
  for (const a of agings) {
    const lock = agingLock(
      {
        id: a.id,
        startDate: a.startDate ? dateOnly(a.startDate) : laPazDate(a.createdAt),
        plannedMonths: a.plannedMonths,
        storedUnlockDate: dateOnly(a.lockUntilDate),
      },
      lot.rules,
      clock.today,
    );
    if (!lock.released) continue;
    // Condición en el `where`: dos ejecuciones simultáneas no duplican el evento
    const updated = await tx.wineAgingBatch.updateMany({
      where: { id: a.id, agingStatus: AgingStatusEnum.AGING },
      data: { agingStatus: AgingStatusEnum.READY },
    });
    if (updated.count === 1) {
      released.push({ lock, resourceType: 'wine_aging_batch' });
    }
  }

  const distillations = await tx.productionBatch.findMany({
    where: {
      lotId: lot.id,
      restStatus: RestStatusEnum.RESTING,
      discardedAt: null,
      processEndDate: { not: null },
    },
    select: { id: true, processEndDate: true, mandatoryRestUntil: true },
  });
  for (const p of distillations) {
    const lock = restLock(
      {
        id: p.id,
        processEndDate: p.processEndDate ? dateOnly(p.processEndDate) : null,
        storedUnlockDate: p.mandatoryRestUntil
          ? dateOnly(p.mandatoryRestUntil)
          : null,
      },
      lot.rules,
      clock.today,
    );
    if (!lock || !lock.released) continue;
    const updated = await tx.productionBatch.updateMany({
      where: { id: p.id, restStatus: RestStatusEnum.RESTING },
      data: { restStatus: RestStatusEnum.READY },
    });
    if (updated.count === 1) {
      released.push({ lock, resourceType: 'production_batch' });
    }
  }

  for (const { lock, resourceType } of released) {
    await appendLotEvent(tx, lot.id, {
      type: 'LOCK_RELEASED',
      occurredAt: toDbDate(lock.unlockDate),
      recordedAt: clock.now,
      stage: lot.stage,
      actorMembershipId: null,
      summary:
        lock.kind === 'AGING'
          ? `Crianza de ${lock.rule.applied} meses cumplida el ${lock.unlockDate}: lista para embotellar`
          : `Reposo de ${lock.rule.applied} días cumplido el ${lock.unlockDate}: listo para embotellar`,
      data: {
        kind: lock.kind,
        sourceId: lock.sourceId,
        unlockDate: lock.unlockDate,
        rule: lock.rule.settingKey,
        applied: lock.rule.applied,
        unit: lock.rule.unit,
      },
      resource: { type: resourceType, id: lock.sourceId },
    });
  }
  if (released.length > 0) {
    await tx.lot.update({
      where: { id: lot.id },
      data: { updatedAt: clock.now },
    });
    // La bitácora al final (toma el candado de la cadena hasta confirmar)
    for (const { lock, resourceType } of released) {
      await audit.record(tx, {
        action: AuditAction.LOCK_RELEASED,
        actor: null,
        resource: { type: resourceType, id: lock.sourceId },
        organizationId: lot.wineryId,
        before: { status: lock.kind === 'AGING' ? 'AGING' : 'RESTING' },
        after: {
          status: 'READY',
          lotId: lot.id,
          kind: lock.kind,
          unlockDate: lock.unlockDate,
          rule: lock.rule.settingKey,
        },
      });
    }
  }
  return released;
}
