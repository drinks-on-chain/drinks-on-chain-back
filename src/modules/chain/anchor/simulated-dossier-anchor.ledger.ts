import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AuditService } from '@shared/audit/audit.service';
import { OutboxService } from '@shared/outbox/outbox.service';
import { PrismaService } from '@shared/prisma/prisma.service';
import { ChainAlertsWriter } from '../alerts/chain-alerts.writer';
import { applyAnchorConfirmed } from './anchor-effects';
import {
  ANCHOR_BACKFILL_BATCH,
  type AnchorRequestedBy,
  type AnchorRequestResult,
  type DossierAnchorLedger,
} from './dossier-anchor.port';
import {
  SIMULATED_ANCHOR_ACCOUNT,
  SIMULATED_ANCHOR_NETWORK,
  isSimulatedAnchor,
  simulatedIntentKey,
  simulatedTxHash,
} from './simulated-anchor';

const SYSTEM: AnchorRequestedBy = {
  userId: null,
  fullName: null,
  source: 'WORKER',
};

/**
 * Anclaje **simulado** del expediente (`ANCHOR_LEDGER=SIMULATED`): da por
 * confirmada la publicación de la huella sin salir a ninguna red, en la misma
 * transacción de base de datos, y aplica los mismos efectos que el anclaje
 * real (`applyAnchorConfirmed`): lote `CERTIFIED → ANCHORED`, evento
 * `DOSSIER_ANCHORED` en la línea de tiempo, bitácora, colección canjeable y
 * `lot.anchored` en el outbox.
 *
 * Deja una fila en `chain_transactions` (`CONFIRMED`, red `LOCAL`, intención
 * `simulated-anchor:{lotId}`) para que el ERP, el back office y el pasaporte
 * pinten el anclaje igual que uno real, y una en `dossier_anchors` con la
 * cuenta simulada fija. El anclaje real (`DossierAnchorService`) reconoce esa
 * cuenta y vuelve a anclar el expediente en la red cuando se habilite.
 *
 * Nunca para producción con una red real: la validación del entorno lo
 * rechaza con `STELLAR_NETWORK=PUBLIC`.
 */
@Injectable()
export class SimulatedDossierAnchorLedger implements DossierAnchorLedger {
  readonly kind = 'SIMULATED' as const;
  private readonly logger = new Logger(SimulatedDossierAnchorLedger.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly alerts: ChainAlertsWriter,
  ) {}

  async request(
    db: Prisma.TransactionClient,
    lotId: string,
    requestedBy: AnchorRequestedBy = SYSTEM,
  ): Promise<AnchorRequestResult> {
    await db.$queryRaw`SELECT lot_id FROM lot_dossiers WHERE lot_id = ${lotId}::uuid FOR UPDATE`;
    const dossier = await db.lotDossier.findUnique({
      where: { lotId },
      include: { anchor: true, lot: { select: { wineryId: true } } },
    });
    if (!dossier || dossier.status !== 'CLOSED' || !dossier.hash) {
      return 'NOT_CLOSED';
    }
    if (dossier.anchor?.status === 'ANCHORED') return 'ALREADY_ANCHORED';
    // Un anclaje real ya en curso (Stellar habilitado antes): no se pisa
    if (dossier.anchor && !isSimulatedAnchor(dossier.anchor)) {
      return 'IN_PROGRESS';
    }

    const now = new Date();
    const txHash = simulatedTxHash(lotId, dossier.hash);
    const transaction = await db.chainTransaction.upsert({
      where: { intentKey: simulatedIntentKey(lotId) },
      update: {},
      create: {
        kind: 'ANCHOR_DOSSIER',
        status: 'CONFIRMED',
        network: SIMULATED_ANCHOR_NETWORK,
        intentKey: simulatedIntentKey(lotId),
        subjectType: 'LOT',
        subjectId: lotId,
        wineryId: dossier.lot.wineryId,
        intent: { lotId, memoHashHex: dossier.hash, simulated: true },
        sourceAccount: SIMULATED_ANCHOR_ACCOUNT,
        signers: [
          { role: 'ANCHOR', address: SIMULATED_ANCHOR_ACCOUNT, wineryId: null },
        ],
        txHash,
        ledger: null,
        confirmedAt: now,
        attempts: 1,
        result: { simulated: true },
        requestedByUserId: requestedBy.userId,
        requestedByName: requestedBy.fullName,
        requestedSource: requestedBy.source,
      },
    });

    if (!dossier.anchor) {
      await db.dossierAnchor.create({
        data: {
          lotId,
          status: 'PENDING',
          network: SIMULATED_ANCHOR_NETWORK,
          account: SIMULATED_ANCHOR_ACCOUNT,
          memoHashHex: dossier.hash,
          transactionId: transaction.id,
        },
      });
    } else {
      await db.dossierAnchor.update({
        where: { id: dossier.anchor.id },
        data: { memoHashHex: dossier.hash, transactionId: transaction.id },
      });
    }

    // Lectura de vuelta "perfecta": el memo es la huella y la cuenta es la oficial
    const result = await applyAnchorConfirmed(
      db,
      { audit: this.audit, outbox: this.outbox, alerts: this.alerts },
      transaction,
      {
        ok: true,
        expectedMemoHashHex: dossier.hash,
        memoHashHex: dossier.hash,
        officialAccount: SIMULATED_ANCHOR_ACCOUNT,
        sourceAccount: SIMULATED_ANCHOR_ACCOUNT,
      },
    );
    return result === 'ANCHORED' ? 'REQUESTED' : 'ALREADY_ANCHORED';
  }

  async backfill(
    limit: number = ANCHOR_BACKFILL_BATCH,
  ): Promise<{ requested: number; more: boolean }> {
    const pending = await this.prisma.lotDossier.findMany({
      where: { status: 'CLOSED', hash: { not: null }, anchor: null },
      orderBy: { closedAt: 'asc' },
      select: { lotId: true },
      take: limit + 1,
    });
    let requested = 0;
    for (const { lotId } of pending.slice(0, limit)) {
      const result = await this.prisma.$transaction((db) =>
        this.request(db, lotId),
      );
      if (result === 'REQUESTED') requested += 1;
    }
    if (requested > 0) {
      this.logger.log(
        `Anclaje simulado: ${requested} expediente(s) dados por anclados (sin red)`,
      );
    }
    return { requested, more: pending.length > limit };
  }
}
