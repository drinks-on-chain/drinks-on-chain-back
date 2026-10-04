import { ErrorCode } from '@shared/exceptions/error-codes';
import type { ErrorDetail } from '@shared/interfaces/api-response.interface';
import {
  bottlingBalanceViolations,
  computeBottlingBalance,
} from './bottling-balance';
import { doRulesFromLot, doViolations, evaluateDo } from './do-evaluation';
import { agingLock, restLock } from './locks';
import { LOT_RULE_KEYS, LotRules } from './lot-rules';
import type { LotProductType } from './lot-stage';
import { massBalanceViolation } from './mass-balance';
import { violation } from './trace-errors';

/**
 * Datos de un lote con lo que deciden sus reglas (contrato O2 §9: "cada
 * corrección vuelve a validar las reglas del lote con la instantánea:
 * candados, balances, D.O."). Es la misma revisión de integridad de la
 * migración (§2.6.8), pero a nivel de lote y sobre los valores vigentes.
 */
export interface IntegrityLot {
  productType: LotProductType | null;
  rules: LotRules;
  harvests: {
    id: string;
    code: string;
    netKg: number;
    phytoStatus: string;
    /** Kilos que entraron a tanques. */
    inputsKg: number;
    terroir: {
      id: string;
      parcelName: string;
      altitudeMasl: number;
      varietyName: string;
    };
  }[];
  tanks: {
    id: string;
    tankCode: string;
    capacityLiters: number | null;
    filledLiters: number | null;
    finalLiters: number | null;
    /** Litros transferidos a la crianza y a las destilaciones. */
    drawnLiters: number;
  }[];
  agings: {
    id: string;
    startDate: string;
    plannedMonths: number;
    /** `lock_until_date` guardado: con un registro anterior a la Ola 2 manda la fecha más tardía. */
    storedUnlockDate: string | null;
    volumeLiters: number | null;
    discarded: boolean;
    bottled: boolean;
  }[];
  distillations: {
    id: string;
    inputLiters: number | null;
    headsLiters: number | null;
    heartLiters: number | null;
    tailsLiters: number | null;
    vinasseLiters: number | null;
    heartAbvPercent: number | null;
    /** `null` = abierta. */
    processEndDate: string | null;
    discarded: boolean;
    bottled: boolean;
  }[];
  bottling: {
    id: string;
    bottlingDay: string;
    bottles: number;
    formatCl: number;
    finalAbv: number;
    waterLiters: number;
    leftoverLiters: number;
  } | null;
}

/**
 * Códigos que evalúa `lotIntegrityViolations`: una incidencia abierta con uno
 * de estos códigos se da por resuelta cuando la revisión ya no lo encuentra.
 * Las de otros códigos (p. ej. un segundo embotellado anterior a la Ola 2)
 * no se resuelven con una corrección.
 */
export const INTEGRITY_CODES: readonly string[] = [
  ErrorCode.TRC_DO_NOT_ELIGIBLE,
  ErrorCode.TRC_PHYTO_NOT_APPROVED,
  ErrorCode.TRC_VOLUME_EXCEEDS_AVAILABLE,
  ErrorCode.TRC_TANK_CAPACITY_EXCEEDED,
  ErrorCode.TRC_AGING_BELOW_MINIMUM,
  ErrorCode.TRC_MASS_BALANCE_EXCEEDED,
  ErrorCode.TRC_BOTTLING_SOURCE_INVALID,
  ErrorCode.TRC_BOTTLING_SOURCES_PENDING,
  ErrorCode.TRC_VOLUME_MISSING,
  ErrorCode.TRC_LOCK_NOT_RELEASED,
  ErrorCode.TRC_BOTTLING_EXCEEDS_VOLUME,
  ErrorCode.TRC_BOTTLING_LOSS_ABOVE_TOLERANCE,
  ErrorCode.TRC_ALCOHOL_BALANCE_EXCEEDED,
  ErrorCode.TRC_DILUTION_NOT_ALLOWED,
];

/**
 * Reglas de un embotellado **ya hecho**: no se puede deshacer, así que una
 * corrección que las incumple no se rechaza; queda registrada y abre una
 * incidencia `CORRECTION` que bloquea el cierre del expediente.
 */
export const BOTTLED_RULE_CODES: readonly string[] = [
  ErrorCode.TRC_LOCK_NOT_RELEASED,
  ErrorCode.TRC_BOTTLING_EXCEEDS_VOLUME,
  ErrorCode.TRC_BOTTLING_LOSS_ABOVE_TOLERANCE,
  ErrorCode.TRC_ALCOHOL_BALANCE_EXCEEDED,
  ErrorCode.TRC_DILUTION_NOT_ALLOWED,
  ErrorCode.TRC_VOLUME_MISSING,
  ErrorCode.TRC_BOTTLING_SOURCE_INVALID,
  ErrorCode.TRC_BOTTLING_SOURCES_PENDING,
];

const round = (n: number): number => Math.round(n * 1000) / 1000;

/** Todas las reglas del lote que no se cumplen con sus valores vigentes. */
export function lotIntegrityViolations(lot: IntegrityLot): ErrorDetail[] {
  const out: ErrorDetail[] = [];
  const { rules } = lot;

  // D.O. del lote singani sobre todos sus pesajes (EA-03)
  if (lot.productType === 'SINGANI' && lot.harvests.length > 0) {
    const evaluation = evaluateDo(
      lot.harvests.map((h) => ({
        id: h.terroir.id,
        altitudeMasl: h.terroir.altitudeMasl,
        varietyName: h.terroir.varietyName,
      })),
      doRulesFromLot(rules),
      'LOT_SNAPSHOT',
    );
    if (evaluation.status === 'NOT_ELIGIBLE') {
      const names = Object.fromEntries(
        lot.harvests.map((h) => [h.terroir.id, h.terroir.parcelName]),
      );
      out.push(
        ...doViolations(
          evaluation,
          ErrorCode.TRC_DO_NOT_ELIGIBLE,
          names,
          (terroirId) => ({
            harvestBatches: lot.harvests
              .filter((h) => h.terroir.id === terroirId)
              .map((h) => ({ id: h.id, code: h.code })),
          }),
        ),
      );
    }
  }

  // Dictamen de la uva que está en un tanque (R4, S-2) y kilos ≤ neto
  const allowed = rules.phytosanitary.requireApproved
    ? ['APPROVED']
    : ['APPROVED', 'PENDING_INSPECTION'];
  for (const h of lot.harvests) {
    if (h.inputsKg > 0 && !allowed.includes(h.phytoStatus)) {
      out.push(
        violation(
          ErrorCode.TRC_PHYTO_NOT_APPROVED,
          `El pesaje ${h.code} está en un tanque con dictamen ${h.phytoStatus}`,
          {
            rule: LOT_RULE_KEYS.requireApproved,
            expected: allowed,
            actual: h.phytoStatus,
            meta: {
              harvestBatchId: h.id,
              harvestBatchCode: h.code,
              status: h.phytoStatus,
            },
          },
        ),
      );
    }
    if (h.inputsKg > h.netKg + 1e-6) {
      out.push(
        violation(
          ErrorCode.TRC_VOLUME_EXCEEDS_AVAILABLE,
          `Del pesaje ${h.code} entraron ${h.inputsKg} kg a tanques y su neto es de ${h.netKg} kg`,
          {
            expected: h.netKg,
            actual: h.inputsKg,
            meta: {
              harvestBatchId: h.id,
              available: h.netKg,
              requested: h.inputsKg,
              unit: 'kg',
            },
          },
        ),
      );
    }
  }

  // Tanques: llenado ≤ capacidad, final ≤ llenado, salidas ≤ lo que tiene
  for (const t of lot.tanks) {
    if (
      t.capacityLiters !== null &&
      t.filledLiters !== null &&
      t.filledLiters > t.capacityLiters + 1e-6
    ) {
      out.push(
        violation(
          ErrorCode.TRC_TANK_CAPACITY_EXCEEDED,
          `El llenado del tanque ${t.tankCode} (${t.filledLiters} L) supera su capacidad (${t.capacityLiters} L)`,
          {
            expected: t.capacityLiters,
            actual: t.filledLiters,
            meta: { tankId: t.id, capacityLiters: t.capacityLiters },
          },
        ),
      );
    }
    if (
      t.finalLiters !== null &&
      t.filledLiters !== null &&
      t.finalLiters > t.filledLiters + 1e-6
    ) {
      out.push(
        violation(
          ErrorCode.TRC_VOLUME_EXCEEDS_AVAILABLE,
          `El volumen final del tanque ${t.tankCode} (${t.finalLiters} L) supera el de llenado (${t.filledLiters} L)`,
          {
            expected: t.filledLiters,
            actual: t.finalLiters,
            meta: {
              tankId: t.id,
              scope: 'FINAL_VOLUME',
              available: t.filledLiters,
              requested: t.finalLiters,
              unit: 'L',
            },
          },
        ),
      );
    }
    const liters = t.finalLiters ?? t.filledLiters;
    if (liters !== null && t.drawnLiters > liters + 1e-6) {
      out.push(
        violation(
          ErrorCode.TRC_VOLUME_EXCEEDS_AVAILABLE,
          `Del tanque ${t.tankCode} salieron ${t.drawnLiters} L y solo tenía ${liters} L`,
          {
            expected: liters,
            actual: t.drawnLiters,
            meta: {
              tankId: t.id,
              scope: 'TRANSFERS',
              available: liters,
              requested: t.drawnLiters,
              unit: 'L',
            },
          },
        ),
      );
    }
  }

  // Crianza ≥ mínimo de la instantánea
  for (const a of lot.agings) {
    if (a.discarded) continue;
    if (a.plannedMonths < rules.wine.minAgingMonths) {
      out.push(
        violation(
          ErrorCode.TRC_AGING_BELOW_MINIMUM,
          `La crianza mínima del lote es de ${rules.wine.minAgingMonths} meses`,
          {
            field: 'plannedMonths',
            rule: LOT_RULE_KEYS.minAgingMonths,
            expected: rules.wine.minAgingMonths,
            actual: a.plannedMonths,
            meta: { sourceId: a.id },
          },
        ),
      );
    }
  }

  // Balance de masa de las destilaciones cerradas
  for (const p of lot.distillations) {
    if (p.discarded || p.processEndDate === null) continue;
    if (p.inputLiters === null || p.heartLiters === null) continue;
    const broken = massBalanceViolation(p.inputLiters, {
      headsLiters: p.headsLiters ?? 0,
      heartLiters: p.heartLiters,
      tailsLiters: p.tailsLiters ?? 0,
      vinasseLiters: p.vinasseLiters,
    });
    if (broken) {
      out.push({ ...broken, meta: { ...broken.meta, sourceId: p.id } });
    }
  }

  if (lot.bottling) out.push(...bottledViolations(lot, lot.bottling));
  return out;
}

/** Reglas del embotellado ya hecho: candados a su fecha y balances (§6.2). */
function bottledViolations(
  lot: IntegrityLot,
  bottling: NonNullable<IntegrityLot['bottling']>,
): ErrorDetail[] {
  const out: ErrorDetail[] = [];
  const { rules } = lot;
  const agings = lot.agings.filter((a) => a.bottled);
  const distillations = lot.distillations.filter((p) => p.bottled);

  // Fuentes abiertas que no entraron en el embotellado (§6.2.3)
  const pending = [
    ...lot.agings.filter((a) => !a.bottled && !a.discarded).map((a) => a.id),
    ...lot.distillations
      .filter((p) => !p.bottled && !p.discarded)
      .map((p) => p.id),
  ];
  if (pending.length > 0) {
    out.push(
      violation(
        ErrorCode.TRC_BOTTLING_SOURCES_PENDING,
        'El lote está embotellado y tiene fuentes abiertas que no entraron en el embotellado',
        { meta: { sourceIds: pending } },
      ),
    );
  }

  // Candados a la fecha del embotellado (el reloj de entonces no se conoce)
  const locks = [
    ...agings.map((a) =>
      agingLock(
        {
          id: a.id,
          startDate: a.startDate,
          plannedMonths: a.plannedMonths,
          storedUnlockDate: a.storedUnlockDate,
        },
        rules,
        bottling.bottlingDay,
      ),
    ),
    ...distillations.map((p) => {
      const lock = restLock(
        { id: p.id, processEndDate: p.processEndDate, storedUnlockDate: null },
        rules,
        bottling.bottlingDay,
      );
      if (!lock) {
        out.push(
          violation(
            ErrorCode.TRC_BOTTLING_SOURCE_INVALID,
            'Se embotelló una destilación sin fecha de cierre',
            { meta: { sourceId: p.id } },
          ),
        );
      }
      return lock;
    }),
  ];
  for (const lock of locks) {
    if (!lock || lock.released) continue;
    out.push(
      violation(
        ErrorCode.TRC_LOCK_NOT_RELEASED,
        `Se embotelló el ${bottling.bottlingDay}, ${lock.daysRemaining} días antes del fin del candado (${lock.unlockDate})`,
        {
          field: 'bottlingDate',
          rule: lock.rule.settingKey,
          expected: lock.unlockDate,
          actual: bottling.bottlingDay,
          meta: {
            sourceId: lock.sourceId,
            kind: lock.kind,
            unlockDate: lock.unlockDate,
            daysRemaining: lock.daysRemaining,
          },
        },
      ),
    );
  }

  // Balance de volumen, merma, alcohol y agua con las fuentes embotelladas
  const sources = [
    ...agings.map((a) => ({ id: a.id, liters: a.volumeLiters, abv: null })),
    ...distillations.map((p) => ({
      id: p.id,
      liters: p.heartLiters,
      abv: p.heartAbvPercent,
    })),
  ];
  if (sources.length === 0) return out;
  const missing = sources.filter((s) => s.liters === null);
  if (missing.length > 0) {
    out.push(
      violation(
        ErrorCode.TRC_VOLUME_MISSING,
        'La fuente del embotellado no tiene volumen registrado: no se puede verificar el balance',
        { meta: { sourceIds: missing.map((s) => s.id) } },
      ),
    );
    return out;
  }
  const productType: LotProductType =
    lot.productType ?? (agings.length > 0 ? 'WINE' : 'SINGANI');
  const available = round(
    sources.reduce((sum, s) => sum + (s.liters as number), 0),
  );
  const pure =
    distillations.length > 0 &&
    distillations.every((p) => p.heartAbvPercent !== null)
      ? distillations.reduce(
          (sum, p) =>
            sum +
            ((p.heartLiters as number) * (p.heartAbvPercent as number)) / 100,
          0,
        )
      : null;
  const input = {
    productType,
    availableLiters: available,
    waterDilutionLiters: bottling.waterLiters,
    bottles: bottling.bottles,
    formatCl: bottling.formatCl,
    leftoverLiters: bottling.leftoverLiters,
    maxLossPercent: rules.bottling.maxLossPercent,
    finalAbv: bottling.finalAbv,
    pureAlcoholAvailableLiters: pure,
  };
  out.push(...bottlingBalanceViolations(input, computeBottlingBalance(input)));
  return out;
}

/** Clave estable de una violación: código más el registro al que afecta. */
export function violationKey(detail: ErrorDetail): string {
  const meta = detail.meta ?? {};
  const target =
    meta.sourceId ?? meta.tankId ?? meta.harvestBatchId ?? meta.terroirId ?? '';
  const scope = meta.scope ?? meta.check ?? '';
  return `${detail.code ?? ''}:${String(target)}:${String(scope)}`;
}

/**
 * Compara la revisión de antes y de después de una corrección: lo que la
 * corrección **introduce** (dividido en lo que se rechaza y lo que, por ser
 * de un embotellado ya hecho, queda como incidencia) y los códigos que la
 * corrección **resuelve**: los que se incumplían antes y ya no. Una incidencia
 * cuyo código no se incumplía antes (p. ej. una de la migración que esta
 * revisión no reproduce) nunca se da por resuelta por una escritura ajena.
 */
export function compareIntegrity(
  before: readonly ErrorDetail[],
  after: readonly ErrorDetail[],
): {
  rejected: ErrorDetail[];
  recorded: ErrorDetail[];
  clearedCodes: string[];
} {
  const known = new Set(before.map(violationKey));
  const introduced = after.filter((d) => !known.has(violationKey(d)));
  const remaining = new Set(after.map((d) => d.code));
  const previous = new Set(before.map((d) => d.code ?? ''));
  return {
    rejected: introduced.filter(
      (d) => !BOTTLED_RULE_CODES.includes(d.code ?? ''),
    ),
    recorded: introduced.filter((d) =>
      BOTTLED_RULE_CODES.includes(d.code ?? ''),
    ),
    clearedCodes: INTEGRITY_CODES.filter(
      (code) => previous.has(code) && !remaining.has(code),
    ),
  };
}
