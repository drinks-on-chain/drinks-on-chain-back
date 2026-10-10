import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '@shared/audit/audit.service';
import { OutboxService } from '@shared/outbox/outbox.service';
import type { OutboxJobData } from '@shared/outbox/outbox.types';
import { PrismaService } from '@shared/prisma/prisma.service';
import { HandlesJob, JobHandler } from '@shared/queue/job-handler';
import { QUEUE_DEFAULT } from '@shared/queue/queue.constants';
import {
  LOT_BOTTLED,
  LOT_BOTTLE_CODE_VOIDED,
  LOT_DISCARDED,
  type LotBottlesChangedPayload,
} from '@modules/lots/lots.events';
import { AppLinks } from '@modules/mail/app-links';
import { MailService } from '@modules/mail/mail.service';
import { recomputeClosure } from '../closure/closure-writes';
import {
  LOT_SHORTFALL_DETECTED,
  type LotShortfallDetectedPayload,
} from '../tokenization.events';

/** Calcular el cierre puede recorrer los NFT de toda una colección. */
const TX_OPTIONS = { timeout: 60_000, maxWait: 15_000 } as const;

/**
 * Cierre del lote con faltante (contrato O3 §8.4): se calcula al consumir
 * `lot.bottled`, `lot.bottle_code_voided` y `lot.discarded`. Los tres hacen
 * lo mismo, con los datos de ese momento y la fila del lote bloqueada, así
 * que reprocesar un evento o recibirlos desordenados no cambia el resultado.
 * Un lote sin colección no tiene cierre.
 */
@Injectable()
export class LotClosureRecalculator {
  private readonly logger = new Logger(LotClosureRecalculator.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly outbox: OutboxService,
    private readonly links: AppLinks,
  ) {}

  async recalculate(lotId: string, eventType: string): Promise<void> {
    const change = await this.prisma.$transaction(
      (tx) =>
        recomputeClosure(
          tx,
          {
            audit: this.audit,
            mail: this.mail,
            outbox: this.outbox,
            erpUrl: this.links.erpHome(),
            backofficeUrl: this.links.base('BACKOFFICE'),
            fromWorker: true,
          },
          lotId,
        ),
      TX_OPTIONS,
    );
    if (!change.applicable) return;
    const { closure } = change;
    this.logger.log({
      message: `Cierre del lote ${closure.status}${change.shortfallOpened ? ' (faltante detectado)' : ''}`,
      eventType,
      lotId,
      closureId: closure.id,
      bottles: closure.bottles,
      minted: closure.minted,
      shortfall: closure.shortfall,
    });
  }
}

@Injectable()
@HandlesJob(QUEUE_DEFAULT, LOT_BOTTLED)
export class LotBottledHandler implements JobHandler<
  OutboxJobData<LotBottlesChangedPayload>
> {
  constructor(private readonly closures: LotClosureRecalculator) {}

  handle(data: OutboxJobData<LotBottlesChangedPayload>): Promise<void> {
    return this.closures.recalculate(data.payload.lotId, data.eventType);
  }
}

@Injectable()
@HandlesJob(QUEUE_DEFAULT, LOT_BOTTLE_CODE_VOIDED)
export class LotBottleCodeVoidedHandler implements JobHandler<
  OutboxJobData<LotBottlesChangedPayload>
> {
  constructor(private readonly closures: LotClosureRecalculator) {}

  handle(data: OutboxJobData<LotBottlesChangedPayload>): Promise<void> {
    return this.closures.recalculate(data.payload.lotId, data.eventType);
  }
}

@Injectable()
@HandlesJob(QUEUE_DEFAULT, LOT_DISCARDED)
export class LotDiscardedHandler implements JobHandler<
  OutboxJobData<LotBottlesChangedPayload>
> {
  constructor(private readonly closures: LotClosureRecalculator) {}

  handle(data: OutboxJobData<LotBottlesChangedPayload>): Promise<void> {
    return this.closures.recalculate(data.payload.lotId, data.eventType);
  }
}

/** `lot.shortfall_detected`: lo consumirá el catálogo de la Ola 4. */
@Injectable()
@HandlesJob(QUEUE_DEFAULT, LOT_SHORTFALL_DETECTED)
export class LotShortfallDetectedHandler implements JobHandler<
  OutboxJobData<LotShortfallDetectedPayload>
> {
  private readonly logger = new Logger(LotShortfallDetectedHandler.name);

  handle(data: OutboxJobData<LotShortfallDetectedPayload>): Promise<void> {
    const { collectionId, lotId, shortfall, unsoldToBurn, soldWithoutBottle } =
      data.payload;
    this.logger.warn({
      message: `Faltante de ${shortfall} botellas en la colección ${collectionId}`,
      eventType: data.eventType,
      lotId,
      collectionId,
      shortfall,
      unsoldToBurn,
      soldWithoutBottle,
    });
    return Promise.resolve();
  }
}

export const CLOSURE_JOB_HANDLERS = [
  LotClosureRecalculator,
  LotBottledHandler,
  LotBottleCodeVoidedHandler,
  LotDiscardedHandler,
  LotShortfallDetectedHandler,
];
