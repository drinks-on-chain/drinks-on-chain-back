import { Prisma } from '@prisma/client';
import { ErrorCode } from '@shared/exceptions/error-codes';
import { fixProductType, LockedLot } from './lot-records';
import { appendLotEvent } from './lot-events';
import {
  doRulesFromLot,
  doViolations,
  evaluateDo,
} from './domain/do-evaluation';
import { LotProductType, LotStage } from './domain/lot-stage';
import { num, tankLiters } from './domain/sources';
import { parseTankTransitions } from './domain/tank-transitions';
import { ruleError, stateError, violation } from './domain/trace-errors';

type Tx = Prisma.TransactionClient;

/** Litros que aún quedan en un tanque (final o llenado − crianza − destilaciones). */
export async function tankAvailableLiters(
  tx: Tx,
  tankId: string,
): Promise<number | null> {
  const tank = await tx.fermentationTank.findUniqueOrThrow({
    where: { id: tankId },
    select: {
      finalVolumeLiters: true,
      volumeFilledLiters: true,
      wineAgingBatch: { select: { volumeLiters: true } },
      productionBatches: { select: { inputVolumeLiters: true } },
    },
  });
  const liters = tankLiters(tank);
  if (liters === null) return null;
  const drawn =
    (num(tank.wineAgingBatch?.volumeLiters) ?? 0) +
    tank.productionBatches.reduce(
      (s, p) => s + (num(p.inputVolumeLiters) ?? 0),
      0,
    );
  return Math.max(0, Math.round((liters - drawn) * 1000) / 1000);
}

/**
 * Solo un tanque `COMPLETED` es origen de una crianza o de una destilación
 * (§5.1, §5.2): sin completar (`FILLING`/`FERMENTING`) aún no tiene volumen
 * final ni destino decidido, y `TRANSFERRED`/`CLEANED` ya no tiene volumen que
 * transferir → 409 `TRC_TANK_NOT_COMPLETED`.
 */
export function assertTankIsSource(tank: {
  id: string;
  tankCode: string;
  status: string;
}): void {
  if (tank.status === 'COMPLETED') return;
  const pending = tank.status === 'FILLING' || tank.status === 'FERMENTING';
  throw stateError(
    ErrorCode.TRC_TANK_NOT_COMPLETED,
    pending
      ? `El tanque ${tank.tankCode} está ${tank.status}: completa la fermentación antes de transferirlo`
      : `El tanque ${tank.tankCode} está ${tank.status}: ya no tiene volumen que transferir`,
    [
      violation(
        ErrorCode.TRC_TANK_NOT_COMPLETED,
        pending ? 'Tanque sin completar' : 'Tanque ya transferido',
        {
          field: 'fermentationTankId',
          meta: { status: tank.status, tankId: tank.id },
        },
      ),
    ],
  );
}

/**
 * `→ TRANSFERRED` automático (§4.2): al crear la crianza del tanque, o al
 * agotarse su volumen con las destilaciones (o `closeTank: true`). Fija el
 * destino decidido y deja la transición en el historial del tanque.
 */
export async function transferTank(
  tx: Tx,
  tank: {
    id: string;
    status: string;
    destinationType: string | null;
    transitionLog: Prisma.JsonValue;
  },
  destination: 'WINE_AGING' | 'SINGANI_DIST',
  at: Date,
  byMembershipId: string | null,
): Promise<boolean> {
  if (tank.status === 'TRANSFERRED' || tank.status === 'CLEANED') return false;
  await tx.fermentationTank.update({
    where: { id: tank.id },
    data: {
      status: 'TRANSFERRED',
      ...(tank.destinationType === null && { destinationType: destination }),
      transitionLog: [
        ...parseTankTransitions(tank.transitionLog),
        { status: 'TRANSFERRED', at: at.toISOString(), byMembershipId },
      ] as unknown as Prisma.InputJsonArray,
    },
  });
  return true;
}

/** Etapas en las que el lote admite una etapa de proceso. */
export function assertStage(
  lot: LockedLot,
  allowed: readonly LotStage[],
  action: string,
): void {
  if (!allowed.includes(lot.stage)) {
    throw stateError(
      ErrorCode.TRC_INVALID_STAGE,
      `El lote está en etapa ${lot.stage}: no admite ${action}`,
      [
        violation(ErrorCode.TRC_INVALID_STAGE, `Etapa del lote sin ${action}`, {
          meta: { stage: lot.stage, allowed },
        }),
      ],
    );
  }
}

const DESTINATION_OF: Record<LotProductType, string> = {
  WINE: 'WINE_AGING',
  SINGANI: 'SINGANI_DIST',
};

/**
 * Coherencia del destino con el tipo del lote (§4.3): `WINE ↔ WINE_AGING`,
 * `SINGANI ↔ SINGANI_DIST`. Un destino fuera del MVP → 422
 * `TRC_PRODUCT_NOT_SUPPORTED`.
 */
export function assertDestination(
  lot: LockedLot,
  destination: string | null | undefined,
  field = 'destinationType',
): LotProductType | null {
  if (destination === null || destination === undefined) return null;
  const product: LotProductType | null =
    destination === 'WINE_AGING'
      ? 'WINE'
      : destination === 'SINGANI_DIST'
        ? 'SINGANI'
        : null;
  if (!product) {
    throw ruleError(
      ErrorCode.TRC_PRODUCT_NOT_SUPPORTED,
      `El lote solo admite vino o singani: destino ${destination} no admitido`,
      [
        violation(
          ErrorCode.TRC_PRODUCT_NOT_SUPPORTED,
          'Destino fuera del MVP',
          {
            field,
            expected: ['WINE_AGING', 'SINGANI_DIST'],
            actual: destination,
          },
        ),
      ],
    );
  }
  if (lot.productType && lot.productType !== product) {
    throw ruleError(
      ErrorCode.TRC_DESTINATION_MISMATCH,
      `El lote es ${lot.productType}: su destino es ${DESTINATION_OF[lot.productType]}`,
      [
        violation(
          ErrorCode.TRC_DESTINATION_MISMATCH,
          'Destino incoherente con el tipo del lote',
          {
            field,
            expected: DESTINATION_OF[lot.productType],
            actual: destination,
          },
        ),
      ],
    );
  }
  return product;
}

/**
 * D.O. del lote singani con la instantánea, sobre **todos** sus pesajes (§4.3,
 * EA-03): un detalle por pesaje y regla → 422 `TRC_DO_NOT_ELIGIBLE`.
 */
export async function assertLotDo(tx: Tx, lot: LockedLot): Promise<void> {
  const harvests = await tx.harvestBatch.findMany({
    where: { lotId: lot.id },
    select: {
      id: true,
      harvestBatchCode: true,
      terroir: {
        select: {
          id: true,
          parcelName: true,
          altitudeMasl: true,
          varietyName: true,
        },
      },
    },
  });
  if (harvests.length === 0) return;
  const evaluation = evaluateDo(
    harvests.map((h) => ({
      id: h.terroir.id,
      altitudeMasl: h.terroir.altitudeMasl.toNumber(),
      varietyName: h.terroir.varietyName,
    })),
    doRulesFromLot(lot.rules),
    'LOT_SNAPSHOT',
  );
  if (evaluation.status !== 'NOT_ELIGIBLE') return;
  const names = Object.fromEntries(
    harvests.map((h) => [h.terroir.id, h.terroir.parcelName]),
  );
  const byTerroir = new Map<string, { id: string; code: string }[]>();
  for (const h of harvests) {
    const list = byTerroir.get(h.terroir.id) ?? [];
    list.push({ id: h.id, code: h.harvestBatchCode });
    byTerroir.set(h.terroir.id, list);
  }
  throw ruleError(
    ErrorCode.TRC_DO_NOT_ELIGIBLE,
    'El lote no cumple la D.O. Singani con las reglas de su instantánea',
    doViolations(
      evaluation,
      ErrorCode.TRC_DO_NOT_ELIGIBLE,
      names,
      (terroirId) => ({
        harvestBatches: byTerroir.get(terroirId) ?? [],
      }),
    ),
  );
}

/** Fija el tipo del lote en la primera bifurcación (evento `PRODUCT_DECIDED`). */
export async function decideProductType(
  tx: Tx,
  lot: LockedLot,
  product: LotProductType,
  actorMembershipId: string | null,
  at: Date,
  resource: { type: string; id: string },
): Promise<void> {
  if (lot.productType) return;
  await fixProductType(tx, lot.id, product);
  await appendLotEvent(tx, lot.id, {
    type: 'PRODUCT_DECIDED',
    occurredAt: at,
    stage: lot.stage,
    actorMembershipId,
    summary: `El lote será ${product === 'WINE' ? 'vino' : 'singani'}`,
    data: { productType: product },
    resource,
  });
  lot.productType = product;
}
