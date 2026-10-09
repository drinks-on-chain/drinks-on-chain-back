import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { OutboxService } from '@shared/outbox/outbox.service';
import { QUEUE_CHAIN } from '@shared/queue/queue.constants';
import type { ChainAlertLevel } from '../chain.constants';
import {
  CHAIN_ALERT_RAISED,
  type ChainAlertRaisedPayload,
} from '../chain.events';

export interface ChainAlertInput {
  /** `TX_FAILED`, `LOW_BALANCE`, `CHN_INTENT_REJECTED`… (texto: pueden añadirse). */
  code: string;
  level: ChainAlertLevel;
  subjectType: string;
  subjectId: string;
  wineryId?: string | null;
  message: string;
  expected?: Prisma.InputJsonValue;
  actual?: Prisma.InputJsonValue;
}

/**
 * Escritura de alertas de la cadena (contrato O3 §8.2). Una sola abierta por
 * código y sujeto; cada alerta nueva publica `chain.alert.raised` en la misma
 * transacción. La bandeja y su resolución llegan con el paso 3.6.
 */
@Injectable()
export class ChainAlertsWriter {
  constructor(private readonly outbox: OutboxService) {}

  /** Devuelve `false` si ya había una alerta abierta igual. */
  async raise(
    db: Prisma.TransactionClient,
    input: ChainAlertInput,
  ): Promise<boolean> {
    const open = await db.chainAlert.findFirst({
      where: {
        code: input.code,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        resolvedAt: null,
      },
      select: { id: true },
    });
    if (open) return false;
    const alert = await db.chainAlert.create({
      data: {
        code: input.code,
        level: input.level,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        wineryId: input.wineryId ?? null,
        message: input.message,
        expected: input.expected ?? Prisma.DbNull,
        actual: input.actual ?? Prisma.DbNull,
      },
    });
    await this.outbox.add<ChainAlertRaisedPayload>(db, {
      type: CHAIN_ALERT_RAISED,
      aggregateType: 'chain_alert',
      aggregateId: alert.id,
      queue: QUEUE_CHAIN,
      payload: {
        alertId: alert.id,
        code: alert.code,
        level: alert.level,
        wineryId: alert.wineryId,
      },
    });
    return true;
  }

  /** Cierra sola una alerta cuya causa desapareció (p. ej. saldo recargado). */
  async resolveAuto(
    db: Prisma.TransactionClient,
    where: { code: string; subjectType: string; subjectId: string },
    note: string,
  ): Promise<number> {
    const { count } = await db.chainAlert.updateMany({
      where: { ...where, resolvedAt: null },
      data: {
        resolvedAt: new Date(),
        resolvedBy: 'Sistema',
        resolutionNote: note,
        resolvedAuto: true,
      },
    });
    return count;
  }
}
