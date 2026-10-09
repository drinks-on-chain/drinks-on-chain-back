import { Injectable } from '@nestjs/common';
import { PrismaService } from '@shared/prisma/prisma.service';
import { AuditService } from '@shared/audit/audit.service';
import { AuditAction } from '@shared/audit/audit.actions';
import { OutboxService } from '@shared/outbox/outbox.service';
import { QUEUE_CHAIN } from '@shared/queue/queue.constants';
import { ErrorCode } from '@shared/exceptions/error-codes';
import type { DossierAnchorDto } from '@modules/chain/dto/chain-common.dto';
import {
  DOSSIER_HASH_ALGORITHM,
  DOSSIER_SCHEMA,
  DossierRequirement,
} from './domain/dossier';
import { BOTTLE_MERKLE_ALGORITHM } from './domain/merkle';
import { lotNotFound, ruleError, violation } from './domain/trace-errors';
import {
  assertDossierOpen,
  DossierData,
  loadDossierData,
  lockedClock,
  sealLotDossier,
} from './lot-dossier';
import { appendLotEvent, formatQuantity } from './lot-events';
import { assertWritable, lockLot, refreshLotStage } from './lot-records';
import { LOT_CERTIFIED, LotCertifiedPayload } from './lots.events';
import { actorOf, resolveTraceActors, TraceActor } from './trace-actors';
import { actorMembership } from './trace-db';

/** El cierre lee toda la cadena y hashea hasta 100 000 códigos de botella. */
const DOSSIER_TX_OPTIONS = { maxWait: 10_000, timeout: 60_000 } as const;

export interface LotDossierView {
  lotId: string;
  schema: typeof DOSSIER_SCHEMA;
  status: 'OPEN' | 'CLOSED';
  hash: string | null;
  algorithm: typeof DOSSIER_HASH_ALGORITHM;
  closedAt: string | null;
  closedBy: TraceActor | null;
  bottleCodes: {
    count: number;
    merkleRoot: string;
    algorithm: typeof BOTTLE_MERKLE_ALGORITHM;
  } | null;
  /** `DossierAnchor` (contrato O3 §7.1); `null` sin anclaje (paso 3.5). */
  anchor: DossierAnchorDto | null;
}

export interface DossierPreviewView {
  ready: boolean;
  requirements: DossierRequirement[];
  hashPreview: string | null;
}

export interface CanonicalDossier {
  /** JSON canónico (sus bytes UTF-8 son los que se hashean). */
  canonical: string;
  hash: string;
  status: 'OPEN' | 'CLOSED';
  lotCode: string | null;
  reference: string;
}

/**
 * Expediente del lote y hash canónico (contrato O2 §10, ERP-19). El cierre
 * calcula la huella SHA-256 del contenido canónico (`domain/dossier.ts`),
 * fija la raíz Merkle de los códigos de botella y pasa el lote a `CERTIFIED`.
 * Lo que se guarda en `lot_dossiers` (`canonical`, `hash`,
 * `bottle_merkle_root`, `bottle_count`) no cambia nunca más.
 */
@Injectable()
export class DossierService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  private async load(
    wineryId: string | undefined,
    lotId: string,
  ): Promise<DossierData> {
    const data = await loadDossierData(this.prisma, lotId, wineryId);
    if (!data) throw lotNotFound();
    return data;
  }

  /** Requisitos del cierre y la huella que tendría el expediente ahora. */
  async preview(
    wineryId: string | undefined,
    lotId: string,
  ): Promise<DossierPreviewView> {
    const data = await this.load(wineryId, lotId);
    let hashPreview: string | null = null;
    if (data.lot.dossier?.status === 'CLOSED') {
      hashPreview = data.lot.dossier.hash;
    } else if (data.lot.bottlingBatch) {
      hashPreview = (
        await sealLotDossier(this.prisma, data, {
          closedAt: null,
          closedByMembershipId: null,
        })
      ).hash;
    }
    return {
      ready: data.ready,
      requirements: data.requirements,
      hashPreview,
    };
  }

  async get(
    wineryId: string | undefined,
    lotId: string,
  ): Promise<LotDossierView> {
    const lot = await this.prisma.lot.findFirst({
      where: { id: lotId, ...(wineryId && { wineryId }) },
      select: { id: true, dossier: true },
    });
    if (!lot) throw lotNotFound();
    const dossier = lot.dossier;
    if (!dossier || dossier.status !== 'CLOSED') {
      return {
        lotId: lot.id,
        schema: DOSSIER_SCHEMA,
        status: 'OPEN',
        hash: null,
        algorithm: DOSSIER_HASH_ALGORITHM,
        closedAt: null,
        closedBy: null,
        bottleCodes: null,
        anchor: null,
      };
    }
    const actors = await resolveTraceActors(this.prisma, [
      dossier.closedByMembershipId,
    ]);
    return {
      lotId: lot.id,
      schema: DOSSIER_SCHEMA,
      status: 'CLOSED',
      hash: dossier.hash,
      algorithm: DOSSIER_HASH_ALGORITHM,
      closedAt: dossier.closedAt ? dossier.closedAt.toISOString() : null,
      closedBy: actorOf(actors, dossier.closedByMembershipId),
      bottleCodes:
        dossier.bottleMerkleRoot !== null
          ? {
              count: dossier.bottleCount ?? 0,
              merkleRoot: dossier.bottleMerkleRoot,
              algorithm: BOTTLE_MERKLE_ALGORITHM,
            }
          : null,
      anchor: null,
    };
  }

  /**
   * Los bytes exactos que se hashearon; con el expediente abierto, los que se
   * hashearían ahora (con `closedAt` y `closedBy` en `null`).
   */
  async canonical(
    wineryId: string | undefined,
    lotId: string,
  ): Promise<CanonicalDossier> {
    const lot = await this.prisma.lot.findFirst({
      where: { id: lotId, ...(wineryId && { wineryId }) },
      select: { id: true, lotCode: true, reference: true, dossier: true },
    });
    if (!lot) throw lotNotFound();
    if (
      lot.dossier?.status === 'CLOSED' &&
      lot.dossier.canonical !== null &&
      lot.dossier.hash !== null
    ) {
      return {
        canonical: lot.dossier.canonical,
        hash: lot.dossier.hash,
        status: 'CLOSED',
        lotCode: lot.lotCode,
        reference: lot.reference,
      };
    }
    const data = await this.load(wineryId, lotId);
    const sealed = await sealLotDossier(this.prisma, data, {
      closedAt: null,
      closedByMembershipId: null,
    });
    return {
      ...sealed,
      status: 'OPEN',
      lotCode: lot.lotCode,
      reference: lot.reference,
    };
  }

  /** Cierra el expediente: huella, raíz Merkle, lote `CERTIFIED` y `lot.certified`. */
  async close(
    wineryId: string,
    lotId: string,
    userId: string,
  ): Promise<LotDossierView> {
    await this.prisma.$transaction(async (tx) => {
      const lot = await lockLot(tx, lotId, wineryId);
      await assertDossierOpen(tx, lot.id);
      // `REJECTED` y `DISCARDED` no se certifican
      assertWritable(lot.stage);
      const data = await loadDossierData(tx, lot.id, wineryId);
      if (!data) throw lotNotFound();
      if (!data.ready) {
        const missing = data.requirements.filter((r) => !r.met);
        throw ruleError(
          ErrorCode.TRC_DOSSIER_NOT_READY,
          `El expediente no se puede cerrar: ${missing.length === 1 ? 'falta 1 requisito' : `faltan ${missing.length} requisitos`}`,
          missing.map((r) =>
            violation(ErrorCode.TRC_DOSSIER_NOT_READY, r.message, {
              meta: {
                requirement: r.key,
                ...(r.key === 'LAB_CONFORMING' && {
                  labStatus: data.labStatus,
                }),
                ...(r.key === 'NO_OPEN_COMPLIANCE_ISSUES' && {
                  issueIds: data.openIssueIds,
                }),
                ...(r.key === 'NO_OPEN_SOURCES' && {
                  sourceIds: data.openSourceIds,
                }),
              },
            }),
          ),
        );
      }
      // Reloj tras el bloqueo: un código anulado después tiene fecha posterior
      const clock = await lockedClock(tx);
      const membership = await actorMembership(tx, userId, wineryId);
      const closedByMembershipId = membership?.id ?? null;
      const sealed = await sealLotDossier(tx, data, {
        closedAt: clock.now,
        closedByMembershipId,
      });
      const bottleCodes = data.bottleCodes as {
        count: number;
        merkleRoot: string;
      };
      const row = {
        schema: DOSSIER_SCHEMA,
        status: 'CLOSED',
        hash: sealed.hash,
        canonical: sealed.canonical,
        bottleCount: bottleCodes.count,
        bottleMerkleRoot: bottleCodes.merkleRoot,
        closedAt: clock.now,
        closedByMembershipId,
      };
      await tx.lotDossier.upsert({
        where: { lotId: lot.id },
        create: { lotId: lot.id, ...row },
        update: row,
      });
      const stage = await refreshLotStage(tx, lot.id, clock.now);
      const lotCode = data.lot.lotCode ?? lot.lotCode ?? '';
      await appendLotEvent(tx, lot.id, {
        type: 'DOSSIER_CLOSED',
        occurredAt: clock.now,
        stage,
        actorMembershipId: closedByMembershipId,
        summary: `Expediente cerrado con la huella ${sealed.hash.slice(0, 12)}… (${formatQuantity(bottleCodes.count)} códigos de botella)`,
        data: {
          schema: DOSSIER_SCHEMA,
          algorithm: DOSSIER_HASH_ALGORITHM,
          hash: sealed.hash,
          bottleCount: bottleCodes.count,
          bottleMerkleRoot: bottleCodes.merkleRoot,
        },
        resource: { type: 'lot_dossier', id: lot.id },
      });
      await this.outbox.add<LotCertifiedPayload>(tx, {
        type: LOT_CERTIFIED,
        aggregateType: 'lot',
        aggregateId: lot.id,
        queue: QUEUE_CHAIN,
        payload: {
          lotId: lot.id,
          wineryId,
          lotCode,
          hash: sealed.hash,
          bottleMerkleRoot: bottleCodes.merkleRoot,
          bottleCount: bottleCodes.count,
          closedAt: clock.now.toISOString(),
        },
      });
      await this.audit.record(tx, {
        action: AuditAction.DOSSIER_CLOSED,
        resource: { type: 'lot_dossier', id: lot.id },
        organizationId: wineryId,
        before: { stage: lot.stage, dossierStatus: 'OPEN' },
        after: {
          stage,
          dossierStatus: 'CLOSED',
          lotCode,
          schema: DOSSIER_SCHEMA,
          algorithm: DOSSIER_HASH_ALGORITHM,
          hash: sealed.hash,
          bottleCount: bottleCodes.count,
          bottleMerkleRoot: bottleCodes.merkleRoot,
          closedAt: clock.now.toISOString(),
        },
      });
    }, DOSSIER_TX_OPTIONS);
    return this.get(wineryId, lotId);
  }
}
