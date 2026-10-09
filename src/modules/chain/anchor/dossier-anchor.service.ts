import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '@shared/prisma/prisma.service';
import { CHAIN_SETTINGS, type ChainSettings } from '../chain.config';
import { intentKeys } from '../chain.constants';
import {
  ChainIntentsService,
  type ChainIntentInput,
} from '../tx/chain-intents.service';

export type AnchorRequestResult =
  /** Intención `ANCHOR_DOSSIER` registrada. */
  | 'REQUESTED'
  /** Ya había una intención para ese expediente. */
  | 'IN_PROGRESS'
  | 'ALREADY_ANCHORED'
  /** El expediente no está cerrado (o no existe). */
  | 'NOT_CLOSED'
  /** La cuenta de anclaje aún no está registrada: lo recoge el relleno. */
  | 'NO_ANCHOR_ACCOUNT'
  | 'DISABLED';

type RequestedBy = NonNullable<ChainIntentInput['requestedBy']>;

const SYSTEM: RequestedBy = { userId: null, fullName: null, source: 'WORKER' };

/** Lotes por pasada del relleno (cada anclaje va en su propia transacción). */
export const ANCHOR_BACKFILL_BATCH = 25;

/**
 * Anclaje del expediente (contrato O3 §7.1, CHN-10): registra la intención
 * `ANCHOR_DOSSIER` de **todo** lote certificado, tenga colección o no (A-22),
 * y su fila `dossier_anchors`. Solo escribe en la base; el firmante del
 * worker construye la transacción con el memo. Lo usan el procesador de
 * `lot.certified` y el relleno `chain.anchor.backfill`.
 */
@Injectable()
export class DossierAnchorService {
  private readonly logger = new Logger(DossierAnchorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly intents: ChainIntentsService,
    @Inject(CHAIN_SETTINGS) private readonly settings: ChainSettings,
  ) {}

  /** Idempotente por `anchor:{lotId}`: reprocesar el evento no crea otra transacción. */
  async request(
    db: Prisma.TransactionClient,
    lotId: string,
    requestedBy: RequestedBy = SYSTEM,
  ): Promise<AnchorRequestResult> {
    if (!this.settings.enabled) return 'DISABLED';
    const { network } = this.settings;
    await db.$queryRaw`SELECT lot_id FROM lot_dossiers WHERE lot_id = ${lotId}::uuid FOR UPDATE`;
    const dossier = await db.lotDossier.findUnique({
      where: { lotId },
      include: { anchor: true, lot: { select: { wineryId: true } } },
    });
    if (!dossier || dossier.status !== 'CLOSED' || !dossier.hash) {
      return 'NOT_CLOSED';
    }
    if (dossier.anchor?.status === 'ANCHORED') return 'ALREADY_ANCHORED';
    const account = await db.chainAccount.findFirst({
      where: { role: 'ANCHOR', network, address: { not: null } },
      select: { address: true },
    });
    if (!account?.address) return 'NO_ANCHOR_ACCOUNT';

    const { transaction, created } = await this.intents.register(db, {
      kind: 'ANCHOR_DOSSIER',
      intentKey: intentKeys.anchor(lotId),
      subject: { type: 'LOT', id: lotId },
      wineryId: dossier.lot.wineryId,
      params: { lotId, memoHashHex: dossier.hash },
      requestedBy,
    });
    if (!dossier.anchor) {
      await db.dossierAnchor.create({
        data: {
          lotId,
          status: 'PENDING',
          network,
          account: account.address,
          memoHashHex: dossier.hash,
          transactionId: transaction.id,
        },
      });
    } else if (dossier.anchor.transactionId !== transaction.id) {
      await db.dossierAnchor.update({
        where: { id: dossier.anchor.id },
        data: { transactionId: transaction.id },
      });
    }
    return created ? 'REQUESTED' : 'IN_PROGRESS';
  }

  /**
   * `chain.anchor.backfill` (§7.1): lotes con el expediente cerrado y sin
   * anclaje (los certificados antes de este paso, o mientras la cadena estaba
   * deshabilitada). Devuelve cuántos pidió y si quedan más.
   */
  async backfill(
    limit: number = ANCHOR_BACKFILL_BATCH,
  ): Promise<{ requested: number; more: boolean }> {
    if (!this.settings.enabled) return { requested: 0, more: false };
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
      if (result === 'NO_ANCHOR_ACCOUNT') {
        this.logger.warn(
          'Relleno de anclajes aplazado: la cuenta de anclaje aún no está registrada',
        );
        return { requested, more: false };
      }
      if (result === 'REQUESTED') requested += 1;
    }
    if (requested > 0) {
      this.logger.log(`Relleno de anclajes: ${requested} expediente(s)`);
    }
    return { requested, more: pending.length > limit };
  }
}
