import { ErrorCode } from '@shared/exceptions/error-codes';
import type { ErrorDetail } from '@shared/interfaces/api-response.interface';
import { violation } from './trace-errors';

/** Estados del tanque de fermentación (contrato O2 §4.2). */
export type TankStatus =
  'FILLING' | 'FERMENTING' | 'COMPLETED' | 'TRANSFERRED' | 'CLEANED';

/** Acciones que cambian el estado (no hay `PATCH`). */
export type TankAction = 'start' | 'complete' | 'clean';

/**
 * Transiciones por acción. `COMPLETED → TRANSFERRED` es automática: al crear
 * la crianza del tanque o al agotarse su volumen con las destilaciones.
 */
export const TANK_TRANSITIONS: Record<
  TankAction,
  { from: TankStatus; to: TankStatus }
> = {
  start: { from: 'FILLING', to: 'FERMENTING' },
  complete: { from: 'FERMENTING', to: 'COMPLETED' },
  clean: { from: 'TRANSFERRED', to: 'CLEANED' },
};

/**
 * Violación `TRC_TANK_INVALID_TRANSITION` (409) con `meta: { from, to }` si
 * la acción no se puede hacer desde el estado actual; `null` si es válida.
 */
export function tankTransitionViolation(
  action: TankAction,
  current: TankStatus,
  tankCode: string,
): ErrorDetail | null {
  const { from, to } = TANK_TRANSITIONS[action];
  if (current === from) return null;
  return violation(
    ErrorCode.TRC_TANK_INVALID_TRANSITION,
    `El tanque ${tankCode} está ${current}: solo pasa a ${to} desde ${from}`,
    { meta: { from: current, to, allowedFrom: from } },
  );
}

/** Transición guardada en `fermentation_tanks.transition_log`. */
export interface StoredTankTransition {
  status: TankStatus;
  /** Instante del hecho (ISO 8601). */
  at: string;
  byMembershipId: string | null;
}

const STATUSES: readonly string[] = [
  'FILLING',
  'FERMENTING',
  'COMPLETED',
  'TRANSFERRED',
  'CLEANED',
];

export function parseTankTransitions(json: unknown): StoredTankTransition[] {
  if (!Array.isArray(json)) return [];
  const out: StoredTankTransition[] = [];
  for (const raw of json) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.status !== 'string' || !STATUSES.includes(r.status)) continue;
    if (typeof r.at !== 'string') continue;
    out.push({
      status: r.status as TankStatus,
      at: r.at,
      byMembershipId:
        typeof r.byMembershipId === 'string' ? r.byMembershipId : null,
    });
  }
  return out;
}

/**
 * Historial del tanque: el llenado (que no se guarda como transición) más las
 * transiciones registradas. Los tanques anteriores al paso 2.3 no tienen
 * transiciones guardadas: su único punto conocido es el llenado.
 */
export function tankTransitionHistory(tank: {
  status: string;
  startDate: Date;
  createdByMembershipId: string | null;
  transitionLog: unknown;
}): StoredTankTransition[] {
  const stored = parseTankTransitions(tank.transitionLog);
  // Nació fermentando (`startFermentation`) si nunca pasó por `start`
  const startedLater = stored.some((t) => t.status === 'FERMENTING');
  const initial: TankStatus =
    startedLater || tank.status === 'FILLING' ? 'FILLING' : 'FERMENTING';
  return [
    {
      status: initial,
      at: tank.startDate.toISOString(),
      byMembershipId: tank.createdByMembershipId,
    },
    ...stored,
  ];
}

const round = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * Litros que quedan en el tanque y merma de trasiego (§4.2): el volumen
 * final (o el de llenado) menos lo transferido a la crianza y a las
 * destilaciones. Con el tanque `TRANSFERRED` o `CLEANED` ya no queda nada y
 * la diferencia es la merma.
 */
export function tankVolumes(tank: {
  status: string;
  liters: number | null;
  drawnLiters: number;
}): { availableLiters: number | null; transferLossLiters: number | null } {
  if (tank.liters === null) {
    return { availableLiters: null, transferLossLiters: null };
  }
  const remaining = Math.max(0, round(tank.liters - tank.drawnLiters));
  if (tank.status === 'TRANSFERRED' || tank.status === 'CLEANED') {
    return { availableLiters: 0, transferLossLiters: remaining };
  }
  return { availableLiters: remaining, transferLossLiters: null };
}
