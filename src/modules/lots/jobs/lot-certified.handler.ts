import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@shared/prisma/prisma.service';
import { HandlesJob, JobHandler } from '@shared/queue/job-handler';
import { QUEUE_CHAIN, QUEUE_DEFAULT } from '@shared/queue/queue.constants';
import type { OutboxJobData } from '@shared/outbox/outbox.types';
import { DossierAnchorService } from '@modules/chain/anchor/dossier-anchor.service';
import {
  LOT_ANCHORED,
  LOT_CERTIFIED,
  LotAnchoredPayload,
  LotCertifiedPayload,
} from '../lots.events';

/**
 * `lot.certified` (contrato O2 §10 y O3 §7.1): el expediente del lote se
 * cerró. Registra la intención `ANCHOR_DOSSIER` para **todo** lote
 * certificado, tenga colección o no (A-22); el firmante del worker ancla la
 * huella. Idempotente (`anchor:{lotId}`): reprocesar el evento no crea otra
 * transacción. Con la cadena deshabilitada solo deja constancia: el relleno
 * `chain.anchor.backfill` lo ancla cuando se habilite.
 */
@Injectable()
@HandlesJob(QUEUE_CHAIN, LOT_CERTIFIED)
export class LotCertifiedHandler implements JobHandler<
  OutboxJobData<LotCertifiedPayload>
> {
  private readonly logger = new Logger(LotCertifiedHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly anchors: DossierAnchorService,
  ) {}

  async handle(data: OutboxJobData<LotCertifiedPayload>): Promise<void> {
    const { lotId, lotCode, hash } = data.payload;
    const result = await this.prisma.$transaction((db) =>
      this.anchors.request(db, lotId),
    );
    this.logger.log({
      message: `Lote ${lotCode} certificado: anclaje ${result}`,
      lotId,
      lotCode,
      hash,
      anchor: result,
    });
  }
}

/** `lot.anchored`: lo consumen el catálogo y los avisos de la Ola 4. */
@Injectable()
@HandlesJob(QUEUE_DEFAULT, LOT_ANCHORED)
export class LotAnchoredHandler implements JobHandler<
  OutboxJobData<LotAnchoredPayload>
> {
  private readonly logger = new Logger(LotAnchoredHandler.name);

  handle(data: OutboxJobData<LotAnchoredPayload>): Promise<void> {
    const { lotId, lotCode, txHash, ledger } = data.payload;
    this.logger.log({
      message: `Lote ${lotCode} anclado en la red`,
      lotId,
      lotCode,
      txHash,
      ledger,
    });
    return Promise.resolve();
  }
}
