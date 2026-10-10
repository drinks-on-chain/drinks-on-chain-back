import { LotProductTypeEnum, LotStageEnum, Prisma } from '@prisma/client';
import { ErrorCode } from '@shared/exceptions/error-codes';
import { readSettingsSnapshot } from '@modules/settings/settings.resolve';
import {
  buildLotRules,
  LotRules,
  LotRulesOrigin,
  parseLotRules,
} from './domain/lot-rules';
import {
  deriveLotStage,
  LotProductType,
  LotStage,
  TERMINAL_STAGES,
} from './domain/lot-stage';
import { lotNotFound, stateError } from './domain/trace-errors';
import { appendLotEvent } from './lot-events';
import { lockLotRow, nextLotReference } from './trace-db';
import { toDbDate } from './domain/dates';

type Tx = Prisma.TransactionClient;

export interface NewLotInput {
  wineryId: string;
  /** Id fijo (UUID v5 del pesaje en la migración); por defecto, uno nuevo. */
  id?: string;
  name: string;
  harvestYear: number;
  productType?: LotProductType | null;
  estimatedBottles?: number | null;
  plannedFormatCl?: number | null;
  targetAbvPercent?: number | null;
  plannedTerroirIds?: string[];
  targetReadyDate?: string | null;
  notes?: string | null;
  createdByMembershipId: string | null;
  origin: LotRulesOrigin;
  /** Fecha de creación (la del pesaje en la migración); por defecto, ahora. */
  createdAt?: Date;
  /** Momento de la instantánea (reloj de la base). */
  takenAt: Date;
  /** Texto del evento `LOT_CREATED`. */
  summary?: string;
}

/**
 * Crea el lote con su instantánea de reglas (CFG-06), su referencia interna
 * sin carreras y el evento `LOT_CREATED`, en la transacción `tx`. No
 * comprueba permisos ni la D.O. (lo hace quien llama).
 */
export async function createLotRecord(
  tx: Tx,
  input: NewLotInput,
): Promise<{ id: string; rules: LotRules; reference: string }> {
  const snapshot = await readSettingsSnapshot(
    tx,
    input.wineryId,
    input.takenAt,
  );
  const rules = buildLotRules(snapshot, input.origin);
  const reference = await nextLotReference(
    tx,
    input.wineryId,
    input.harvestYear,
  );
  const lot = await tx.lot.create({
    data: {
      ...(input.id && { id: input.id }),
      wineryId: input.wineryId,
      reference,
      name: input.name,
      productType: (input.productType ?? null) as LotProductTypeEnum | null,
      stage: LotStageEnum.ORIGIN,
      stageChangedAt: input.createdAt ?? input.takenAt,
      harvestYear: input.harvestYear,
      estimatedBottles: input.estimatedBottles ?? null,
      plannedFormatCl: input.plannedFormatCl ?? null,
      targetAbvPercent:
        input.targetAbvPercent !== null && input.targetAbvPercent !== undefined
          ? new Prisma.Decimal(input.targetAbvPercent)
          : null,
      targetReadyDate: input.targetReadyDate
        ? toDbDate(input.targetReadyDate)
        : null,
      plannedTerroirIds: input.plannedTerroirIds ?? [],
      rules: rules as unknown as Prisma.InputJsonObject,
      rulesOrigin: input.origin,
      notes: input.notes ?? null,
      createdByMembershipId: input.createdByMembershipId,
      ...(input.createdAt && { createdAt: input.createdAt }),
    },
    select: { id: true },
  });
  await lockLotRow(tx, lot.id);
  await appendLotEvent(tx, lot.id, {
    type: 'LOT_CREATED',
    occurredAt: input.createdAt ?? input.takenAt,
    recordedAt: input.takenAt,
    stage: 'ORIGIN',
    actorMembershipId: input.createdByMembershipId,
    summary:
      input.summary ??
      `Lote "${input.name}" creado (${reference}) con las reglas vigentes`,
    data: {
      reference,
      productType: input.productType ?? null,
      estimatedBottles: input.estimatedBottles ?? null,
      rulesOrigin: input.origin,
    },
    resource: { type: 'lot', id: lot.id },
  });
  return { id: lot.id, rules, reference };
}

export interface LockedLot {
  id: string;
  wineryId: string;
  stage: LotStage;
  productType: LotProductType | null;
  harvestYear: number;
  rules: LotRules;
  lotCode: string | null;
  name: string;
}

/**
 * Bloquea el lote (de la bodega) y lo devuelve; 404 si no existe o es de
 * otra bodega. Con `writable`, un lote terminal responde 409
 * `TRC_LOT_TERMINAL`.
 */
export async function lockLot(
  tx: Tx,
  lotId: string,
  wineryId: string,
  options: { writable?: boolean } = {},
): Promise<LockedLot> {
  await lockLotRow(tx, lotId);
  const lot = await tx.lot.findFirst({
    where: { id: lotId, wineryId },
    select: {
      id: true,
      wineryId: true,
      stage: true,
      productType: true,
      harvestYear: true,
      rules: true,
      lotCode: true,
      name: true,
    },
  });
  if (!lot) throw lotNotFound();
  if (options.writable) assertWritable(lot.stage as LotStage);
  return {
    ...lot,
    stage: lot.stage as LotStage,
    productType: lot.productType as LotProductType | null,
    rules: parseLotRules(lot.rules),
  };
}

export function assertWritable(stage: LotStage): void {
  if (TERMINAL_STAGES.includes(stage)) {
    throw stateError(
      ErrorCode.TRC_LOT_TERMINAL,
      `El lote está en etapa ${stage}: no admite más registros`,
      [
        {
          field: null,
          message: `Etapa terminal: ${stage}`,
          code: ErrorCode.TRC_LOT_TERMINAL,
          meta: { stage },
        },
      ],
    );
  }
}

/**
 * Recalcula la etapa del lote a partir de sus registros (§2.2) y la guarda
 * si cambió. Devuelve la etapa resultante.
 */
export async function refreshLotStage(
  tx: Tx,
  lotId: string,
  at: Date,
): Promise<LotStage> {
  const lot = await tx.lot.findUniqueOrThrow({
    where: { id: lotId },
    select: {
      stage: true,
      productType: true,
      discardedAt: true,
      dossier: {
        select: { status: true, anchor: { select: { status: true } } },
      },
      bottlingBatch: { select: { id: true } },
      harvestBatches: { select: { phytosanitaryStatus: true } },
      fermentationTanks: { select: { status: true } },
      wineAgingBatches: { select: { discardedAt: true } },
      productionBatches: {
        select: { processEndDate: true, discardedAt: true },
      },
    },
  });
  const stage = deriveLotStage({
    discarded: lot.discardedAt !== null,
    dossierClosed: lot.dossier?.status === 'CLOSED',
    anchored: lot.dossier?.anchor?.status === 'ANCHORED',
    productType: lot.productType as LotProductType | null,
    harvestStatuses: lot.harvestBatches.map((h) => h.phytosanitaryStatus),
    tanks: lot.fermentationTanks,
    agings: lot.wineAgingBatches.map((a) => ({
      discarded: a.discardedAt !== null,
    })),
    distillations: lot.productionBatches.map((p) => ({
      closed: p.processEndDate !== null,
      discarded: p.discardedAt !== null,
    })),
    bottled: lot.bottlingBatch !== null,
  });
  if (stage !== lot.stage) {
    await tx.lot.update({
      where: { id: lotId },
      data: { stage: stage as LotStageEnum, stageChangedAt: at },
    });
  } else {
    await tx.lot.update({ where: { id: lotId }, data: { updatedAt: at } });
  }
  return stage;
}

/** Fija el tipo de producto del lote si aún no lo tiene (primera bifurcación). */
export async function fixProductType(
  tx: Tx,
  lotId: string,
  productType: LotProductType,
): Promise<void> {
  await tx.lot.updateMany({
    where: { id: lotId, productType: null },
    data: { productType: productType as LotProductTypeEnum },
  });
}

/** Ids de las incidencias de cumplimiento abiertas del lote. */
export async function openComplianceIssueIds(
  tx: Tx,
  lotId: string,
): Promise<string[]> {
  const rows = await tx.lotComplianceIssue.findMany({
    where: { lotId, resolvedAt: null },
    select: { id: true },
    orderBy: { detectedAt: 'asc' },
  });
  return rows.map((r) => r.id);
}
