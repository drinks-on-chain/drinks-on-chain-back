import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@shared/prisma/prisma.service';
import { HandlesJob, JobHandler } from '@shared/queue/job-handler';
import { QUEUE_CHAIN, QUEUE_DEFAULT } from '@shared/queue/queue.constants';
import type { OutboxJobData } from '@shared/outbox/outbox.types';
import {
  DOSSIER_ANCHOR_LEDGER,
  type DossierAnchorLedger,
} from '@modules/chain/anchor/dossier-anchor.port';
import {
  LOT_ANCHORED,
  LOT_CERTIFIED,
  LotAnchoredPayload,
  LotCertifiedPayload,
} from '../lots.events';

/**
 * `lot.certified` (contrato O2 §10 y O3 §7.1): el expediente del lote se
 * cerró. Pide el anclaje de la huella para **todo** lote certificado, tenga
 * colección o no (A-22), por el puerto `DOSSIER_ANCHOR_LEDGER`: en Stellar
 * registra la intención `ANCHOR_DOSSIER` y el firmante del worker la envía;
 * con `ANCHOR_LEDGER=SIMULATED` el anclaje queda confirmado sin red. Idempotente (`anchor:{lotId}`): reprocesar el evento no crea otra
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
    @Inject(DOSSIER_ANCHOR_LEDGER)
    private readonly anchors: DossierAnchorLedger,
  ) {}

  async handle(data: OutboxJobData<LotCertifiedPayload>): Promise<void> {
    const { lotId, lotCode, hash } = data.payload;
    const result = await this.prisma.$transaction((db) =>
      this.anchors.request(db, lotId),
    );
    this.logger.log({
      message: `Lote ${lotCode} certificado: anclaje ${result} (${this.anchors.kind})`,
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
