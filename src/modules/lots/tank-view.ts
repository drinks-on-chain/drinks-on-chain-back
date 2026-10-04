import { Prisma } from '@prisma/client';
import {
  CorrectionMarks,
  correctionMarks,
  withMarks,
} from './correction-marks';
import { num, tankLiters } from './domain/sources';
import {
  tankTransitionHistory,
  TankStatus,
  tankVolumes,
} from './domain/tank-transitions';
import { actorOf, resolveTraceActors, TraceActor } from './trace-actors';
import type { DbClient } from './trace-db';

/** Lo que hace falta de un tanque para calcular lo que le queda (§4.2). */
export const TANK_VOLUME_INCLUDE = {
  wineAgingBatch: { select: { volumeLiters: true } },
  productionBatches: { select: { inputVolumeLiters: true } },
} satisfies Prisma.FermentationTankInclude;

type TankRow = Prisma.FermentationTankGetPayload<{
  include: typeof TANK_VOLUME_INCLUDE;
}> & {
  logs?: { id: string }[];
  treatments?: { id: string }[];
};

export interface TankTransitionView {
  status: TankStatus;
  at: string;
  by: TraceActor | null;
}

type Marked<T> = T & CorrectionMarks;

export type TankView<T extends TankRow> = Omit<
  T,
  | 'transitionLog'
  | 'wineAgingBatch'
  | 'productionBatches'
  | 'logs'
  | 'treatments'
> &
  CorrectionMarks & {
    availableLiters: number | null;
    transferLossLiters: number | null;
    transitions: TankTransitionView[];
  } & (T extends { logs: (infer L)[] } ? { logs: Marked<L>[] } : unknown) &
  (T extends { treatments: (infer R)[] }
    ? { treatments: Marked<R>[] }
    : unknown);

/** Litros transferidos desde el tanque a la crianza y a las destilaciones. */
export function tankDrawnLiters(tank: {
  wineAgingBatch: { volumeLiters: Prisma.Decimal | null } | null;
  productionBatches: { inputVolumeLiters: Prisma.Decimal | null }[];
}): number {
  return (
    (num(tank.wineAgingBatch?.volumeLiters) ?? 0) +
    tank.productionBatches.reduce(
      (sum, p) => sum + (num(p.inputVolumeLiters) ?? 0),
      0,
    )
  );
}

/**
 * Tanque con los campos de la Ola 2 (§4.2): `availableLiters` (final menos lo
 * transferido), `transferLossLiters`, `transitions` con su autor y las marcas
 * de corrección (también en sus lecturas y tratamientos).
 */
export async function toTankViews<T extends TankRow>(
  client: DbClient,
  tanks: T[],
): Promise<TankView<T>[]> {
  const histories = tanks.map((t) => tankTransitionHistory(t));
  const [actors, tankMarks, logMarks, treatmentMarks] = await Promise.all([
    resolveTraceActors(
      client,
      histories.flatMap((h) => h.map((t) => t.byMembershipId)),
    ),
    correctionMarks(
      client,
      'FERMENTATION_TANK',
      tanks.map((t) => t.id),
    ),
    correctionMarks(
      client,
      'FERMENTATION_LOG',
      tanks.flatMap((t) => (t.logs ?? []).map((l) => l.id)),
    ),
    correctionMarks(
      client,
      'TREATMENT',
      tanks.flatMap((t) => (t.treatments ?? []).map((r) => r.id)),
    ),
  ]);
  return tanks.map((tank, index) => {
    const {
      transitionLog: _log,
      wineAgingBatch: _aging,
      productionBatches: _productions,
      logs,
      treatments,
      ...rest
    } = tank;
    void _log;
    void _aging;
    void _productions;
    const volumes = tankVolumes({
      status: tank.status,
      liters: tankLiters(tank),
      drawnLiters: tankDrawnLiters(tank),
    });
    return {
      ...withMarks(rest, tankMarks),
      ...volumes,
      transitions: histories[index].map((t) => ({
        status: t.status,
        at: t.at,
        by: actorOf(actors, t.byMembershipId),
      })),
      ...(logs && { logs: logs.map((l) => withMarks(l, logMarks)) }),
      ...(treatments && {
        treatments: treatments.map((r) => withMarks(r, treatmentMarks)),
      }),
    } as unknown as TankView<T>;
  });
}
