import {
  AgingStatusEnum,
  BeverageTypeEnum,
  Prisma,
  RestStatusEnum,
  TankStatusEnum,
} from '@prisma/client';
import { ErrorCode } from '@shared/exceptions/error-codes';
import type { ErrorDetail } from '@shared/interfaces/api-response.interface';
import {
  LockedLot,
  openComplianceIssueIds,
  refreshLotStage,
} from './lot-records';
import { appendLotEvent, formatQuantity } from './lot-events';
import { generateBottleUnits, passportUrl } from './bottle-units';
import { DbClock, nextLotCode } from './trace-db';
import { calendarDay, dateOnly, laPazDate, toDbDate } from './domain/dates';
import { agingLock, LotLock, restLock } from './domain/locks';
import {
  BottlingBalance,
  bottlingBalanceViolations,
  computeBottlingBalance,
} from './domain/bottling-balance';
import { distillationHeart, num } from './domain/sources';
import type { LotProductType } from './domain/lot-stage';
import { violation } from './domain/trace-errors';

type Tx = Prisma.TransactionClient;

export interface BottlingSourceRef {
  kind: 'AGING' | 'REST';
  id: string;
  /** Litros que entran (por defecto, todo lo disponible de la fuente). */
  liters?: number;
}

export interface BottlingRequest {
  sources: BottlingSourceRef[];
  bottlingDate: string;
  packagingFormatCl: number;
  totalBottlesPackaged: number;
  finalAlcoholAbv: number;
  waterDilutionLiters?: number;
  leftover?: {
    liters: number;
    disposition: 'RETAINED' | 'DISCARDED';
    notes?: string;
  };
  bottleType?: string;
  labelDesignKey?: string;
}

export interface BottlingEvaluation {
  valid: boolean;
  productType: LotProductType | null;
  balance: BottlingBalance;
  violations: ErrorDetail[];
  locks: LotLock[];
  bottlingDay: string;
  availableLiters: number | null;
}

type SourceRow = {
  id: string;
  /** Posición en `sources` de la petición (para el `field` de los errores). */
  index: number;
  lotId: string | null;
  status: string;
  discarded: boolean;
  /** Volumen disponible de la fuente (todo: queda `BOTTLED`). */
  liters: number | null;
  /** Litros que la petición toma de la fuente (por defecto, todos). */
  requestedLiters: number | undefined;
  tankId: string;
  lock: LotLock | null;
} & (
  | { kind: 'AGING'; heartAbv: null }
  | { kind: 'REST'; heartAbv: number | null; closed: boolean }
);

/**
 * Reglas del embotellado seguro (contrato O2 §6.2), en su orden: tipo derivado
 * del origen (EA-01), candados con el reloj de la base y la instantánea, una
 * vez por lote, fuentes pendientes, balance de volumen con la merma de la
 * instantánea (EA-02), balance de alcohol, vino sin agua e incidencias
 * abiertas. No escribe nada: la usan la vista previa y el alta.
 *
 * Como el embotellado es uno por lote y cada fuente incluida queda `BOTTLED`,
 * el balance de volumen cuenta **todo** el volumen de cada fuente: si
 * `liters` pide menos, la diferencia se declara como remanente (`leftover`)
 * o cuenta como merma (no puede desaparecer del balance). El alcohol puro
 * disponible, en cambio, es solo el de los litros que se toman.
 */
export async function evaluateBottling(
  tx: Tx,
  lot: LockedLot,
  request: BottlingRequest,
  clock: DbClock,
): Promise<BottlingEvaluation> {
  const violations: ErrorDetail[] = [];
  const bottlingDay = calendarDay(request.bottlingDate);

  // Todas las fuentes del lote (para derivar el tipo y ver las pendientes)
  const [agings, productions] = await Promise.all([
    tx.wineAgingBatch.findMany({
      where: { lotId: lot.id },
      include: { bottlingBatches: { select: { id: true } } },
    }),
    tx.productionBatch.findMany({
      where: { lotId: lot.id },
      include: { bottlingBatches: { select: { id: true } } },
    }),
  ]);
  const requested: SourceRow[] = [];
  const seen = new Set<string>();
  for (const [index, ref] of request.sources.entries()) {
    const sourceField =
      ref.kind === 'AGING' ? 'wineAgingBatchId' : 'productionBatchId';
    // Una fuente repetida contaría su volumen (y su alcohol) dos veces
    if (seen.has(ref.id)) {
      violations.push(
        violation(
          ErrorCode.TRC_BOTTLING_SOURCE_INVALID,
          'La fuente está repetida en el embotellado',
          {
            field: `sources.${index}.${sourceField}`,
            meta: { sourceId: ref.id },
          },
        ),
      );
      continue;
    }
    seen.add(ref.id);
    const row =
      ref.kind === 'AGING'
        ? await tx.wineAgingBatch.findFirst({
            where: { id: ref.id, wineryId: lot.wineryId },
            include: { bottlingBatches: { select: { id: true } } },
          })
        : await tx.productionBatch.findFirst({
            where: { id: ref.id, wineryId: lot.wineryId },
            include: { bottlingBatches: { select: { id: true } } },
          });
    if (!row) {
      violations.push(
        violation(
          ErrorCode.TRC_BOTTLING_SOURCE_INVALID,
          'La fuente no existe en esta bodega',
          {
            field: sourceField,
            meta: { sourceId: ref.id },
          },
        ),
      );
      continue;
    }
    if (ref.kind === 'AGING') {
      const a = row as (typeof agings)[number];
      requested.push({
        kind: 'AGING',
        id: a.id,
        index,
        requestedLiters: ref.liters,
        lotId: a.lotId,
        status: a.agingStatus,
        discarded:
          a.agingStatus === AgingStatusEnum.DISCARDED || a.discardedAt !== null,
        liters: num(a.volumeLiters),
        heartAbv: null,
        tankId: a.fermentationTankId,
        lock: agingLock(
          {
            id: a.id,
            startDate: a.startDate
              ? dateOnly(a.startDate)
              : laPazDate(a.createdAt),
            plannedMonths: a.plannedMonths,
            storedUnlockDate: dateOnly(a.lockUntilDate),
          },
          lot.rules,
          clock.today,
        ),
      });
    } else {
      const p = row as (typeof productions)[number];
      const heart = distillationHeart(p);
      requested.push({
        kind: 'REST',
        id: p.id,
        index,
        requestedLiters: ref.liters,
        lotId: p.lotId,
        status: p.restStatus,
        discarded:
          p.restStatus === RestStatusEnum.DISCARDED || p.discardedAt !== null,
        liters: heart.liters,
        heartAbv: heart.abv,
        tankId: p.fermentationTankId,
        closed: p.processEndDate !== null,
        lock: restLock(
          {
            id: p.id,
            processEndDate: p.processEndDate
              ? dateOnly(p.processEndDate)
              : null,
            storedUnlockDate: p.mandatoryRestUntil
              ? dateOnly(p.mandatoryRestUntil)
              : null,
          },
          lot.rules,
          clock.today,
        ),
      });
    }
  }

  // 1. Tipo derivado del origen (EA-01)
  const kinds = new Set(requested.map((s) => s.kind));
  let productType: LotProductType | null = null;
  if (kinds.size > 1) {
    violations.push(
      violation(
        ErrorCode.TRC_BOTTLING_SOURCE_INVALID,
        'Un embotellado no mezcla crianzas y destilaciones',
        {
          field: 'sources',
          meta: { sourceIds: requested.map((s) => s.id) },
        },
      ),
    );
  } else if (kinds.size === 1) {
    productType = kinds.has('AGING') ? 'WINE' : 'SINGANI';
  }
  if (productType && lot.productType && productType !== lot.productType) {
    violations.push(
      violation(
        ErrorCode.TRC_BOTTLING_SOURCE_INVALID,
        `El lote es ${lot.productType} y la fuente es de ${productType}`,
        {
          field: 'sources',
          expected: lot.productType,
          actual: productType,
        },
      ),
    );
  }
  for (const s of requested) {
    if (s.lotId !== lot.id) {
      violations.push(
        violation(
          ErrorCode.TRC_BOTTLING_SOURCE_INVALID,
          'La fuente es de otro lote',
          {
            field: 'sources',
            meta: { sourceId: s.id },
          },
        ),
      );
    } else if (s.discarded || s.status === 'BOTTLED') {
      violations.push(
        violation(
          ErrorCode.TRC_BOTTLING_SOURCE_INVALID,
          `La fuente está ${s.status}`,
          {
            field: 'sources',
            meta: { sourceId: s.id, status: s.status },
          },
        ),
      );
    } else if (s.kind === 'REST' && !s.closed) {
      violations.push(
        violation(
          ErrorCode.TRC_BOTTLING_SOURCE_INVALID,
          'La destilación aún no está cerrada',
          {
            field: 'sources',
            meta: { sourceId: s.id },
          },
        ),
      );
    }
  }

  // Fecha del embotellado: no futura
  if (bottlingDay > clock.today) {
    violations.push(
      violation(
        ErrorCode.TRC_DATE_IN_FUTURE,
        'La fecha de embotellado no puede ser futura',
        {
          field: 'bottlingDate',
          expected: clock.today,
          actual: bottlingDay,
        },
      ),
    );
  }

  // 2. Candados: liberados hoy (reloj de la base) y a la fecha del embotellado
  const locks = requested.flatMap((s) => (s.lock ? [s.lock] : []));
  for (const lock of locks) {
    if (!lock.released || lock.unlockDate > bottlingDay) {
      const label =
        lock.kind === 'REST'
          ? `Reposo mínimo de ${lock.rule.applied} días`
          : `Crianza de ${lock.rule.applied} meses`;
      violations.push(
        violation(
          ErrorCode.TRC_LOCK_NOT_RELEASED,
          `${label}: disponible el ${lock.unlockDate}${lock.daysRemaining > 0 ? ` (faltan ${lock.daysRemaining} días)` : ''}`,
          {
            field: 'bottlingDate',
            rule: lock.rule.settingKey,
            expected: lock.unlockDate,
            actual: lock.released ? bottlingDay : clock.today,
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
  }

  // 3. Fuentes abiertas del lote sin incluir (S-10: un embotellado por lote)
  const included = new Set(requested.map((s) => s.id));
  const pending = [
    ...agings
      .filter(
        (a) =>
          !included.has(a.id) &&
          a.agingStatus !== 'DISCARDED' &&
          a.agingStatus !== 'BOTTLED' &&
          !a.discardedAt &&
          a.bottlingBatches.length === 0,
      )
      .map((a) => a.id),
    ...productions
      .filter(
        (p) =>
          !included.has(p.id) &&
          p.restStatus !== 'DISCARDED' &&
          p.restStatus !== 'BOTTLED' &&
          !p.discardedAt &&
          p.bottlingBatches.length === 0,
      )
      .map((p) => p.id),
  ];
  if (pending.length > 0) {
    violations.push(
      violation(
        ErrorCode.TRC_BOTTLING_SOURCES_PENDING,
        'El lote tiene fuentes abiertas que no entran en el embotellado: inclúyelas o descártalas antes',
        { field: 'sources', meta: { sourceIds: pending } },
      ),
    );
  }

  // 4–6. Balance de volumen, merma, alcohol y agua
  const missing = requested.filter((s) => s.liters === null);
  for (const s of requested) {
    const want = s.requestedLiters;
    if (want !== undefined && s.liters !== null && want > s.liters + 1e-6) {
      violations.push(
        violation(
          ErrorCode.TRC_VOLUME_EXCEEDS_AVAILABLE,
          `La fuente tiene ${s.liters} L`,
          {
            field: `sources.${s.index}.liters`,
            expected: s.liters,
            actual: want,
            meta: {
              sourceId: s.id,
              available: s.liters,
              requested: want,
              unit: 'L',
            },
          },
        ),
      );
    }
  }
  // Volumen: todo lo de cada fuente (lo que no se toma es remanente o merma)
  const available = requested.reduce((sum, s) => sum + (s.liters ?? 0), 0);
  // Alcohol puro: solo el de los litros que se toman de cada destilación
  const heartPure =
    requested.length > 0 &&
    requested.every((s) => s.kind === 'REST' && s.heartAbv !== null)
      ? requested.reduce(
          (sum, s) =>
            sum +
            (Math.min(s.requestedLiters ?? s.liters ?? 0, s.liters ?? 0) *
              (s.heartAbv ?? 0)) /
              100,
          0,
        )
      : null;
  const input = {
    productType: productType ?? lot.productType ?? 'WINE',
    availableLiters: available,
    waterDilutionLiters: request.waterDilutionLiters ?? 0,
    bottles: request.totalBottlesPackaged,
    formatCl: request.packagingFormatCl,
    leftoverLiters: request.leftover?.liters ?? 0,
    maxLossPercent: lot.rules.bottling.maxLossPercent,
    finalAbv: request.finalAlcoholAbv,
    pureAlcoholAvailableLiters: heartPure,
  };
  const balance = computeBottlingBalance(input);
  if (missing.length > 0) {
    violations.push(
      violation(
        ErrorCode.TRC_VOLUME_MISSING,
        'La fuente no tiene volumen registrado: no se puede verificar el balance',
        {
          field: 'sources',
          meta: { sourceIds: missing.map((s) => s.id) },
        },
      ),
    );
  } else if (requested.length > 0) {
    violations.push(...bottlingBalanceViolations(input, balance));
  }

  // 7. Incidencias de cumplimiento abiertas
  const issues = await openComplianceIssueIds(tx, lot.id);
  if (issues.length > 0) {
    violations.push(
      violation(
        ErrorCode.TRC_COMPLIANCE_ISSUES_OPEN,
        'El lote tiene incidencias de cumplimiento abiertas: corrígelas antes de embotellar',
        { meta: { issueIds: issues } },
      ),
    );
  }

  return {
    valid: violations.length === 0,
    productType,
    balance,
    violations,
    locks,
    bottlingDay,
    availableLiters: missing.length > 0 ? null : available,
  };
}

/**
 * Registra el embotellado ya evaluado (§6.2.8): código de lote sin carreras,
 * URL del QR, fuentes y tanques a estados terminales, lote a `BOTTLED` y un
 * código por botella, en la transacción `tx`.
 */
export async function executeBottling(
  tx: Tx,
  lot: LockedLot,
  request: BottlingRequest,
  evaluation: BottlingEvaluation,
  context: {
    clock: DbClock;
    membershipId: string | null;
    passportBaseUrl: string;
    /** Primera fuente de cada tipo (claves anteriores a la Ola 2 del embotellado). */
    primary: { wineAgingBatchId?: string; productionBatchId?: string };
  },
): Promise<string> {
  const productType = evaluation.productType as LotProductType;
  const year = Number(evaluation.bottlingDay.slice(0, 4));
  const lotCode = await nextLotCode(tx, lot.wineryId, year, productType);
  const legacyMember = context.membershipId
    ? await tx.wineryMember.findUnique({
        where: { id: context.membershipId },
        select: { id: true },
      })
    : null;
  const created = await tx.bottlingBatch.create({
    data: {
      wineryId: lot.wineryId,
      wineAgingBatchId: context.primary.wineAgingBatchId ?? null,
      productionBatchId: context.primary.productionBatchId ?? null,
      productType: productType as BeverageTypeEnum,
      internationalLotCode: lotCode,
      finalAlcoholAbv: new Prisma.Decimal(request.finalAlcoholAbv),
      waterDilutionLiters:
        request.waterDilutionLiters !== undefined
          ? new Prisma.Decimal(request.waterDilutionLiters)
          : null,
      totalBottlesPackaged: request.totalBottlesPackaged,
      packagingFormatCl: request.packagingFormatCl,
      bottleType: request.bottleType,
      labelDesignKey: request.labelDesignKey,
      bottlingDate: toDbDate(evaluation.bottlingDay),
      releasedByMemberId: legacyMember?.id ?? null,
      // El hash que vale es el del expediente (§10): ya no se calcula aquí
      blockchainDataHash: null,
      isAnchoredOnChain: false,
      qrBatchUrl: passportUrl(context.passportBaseUrl, lotCode),
      lotId: lot.id,
      availableLiters:
        evaluation.availableLiters !== null
          ? new Prisma.Decimal(evaluation.availableLiters)
          : null,
      leftoverLiters: request.leftover
        ? new Prisma.Decimal(request.leftover.liters)
        : null,
      leftoverDisposition: request.leftover?.disposition ?? null,
      leftoverNotes: request.leftover?.notes ?? null,
      createdByMembershipId: context.membershipId,
    },
  });

  // Estados terminales de las fuentes y sus tanques
  const agingIds = request.sources
    .filter((s) => s.kind === 'AGING')
    .map((s) => s.id);
  const restIds = request.sources
    .filter((s) => s.kind === 'REST')
    .map((s) => s.id);
  if (agingIds.length > 0) {
    await tx.wineAgingBatch.updateMany({
      where: { id: { in: agingIds } },
      data: { agingStatus: AgingStatusEnum.BOTTLED },
    });
  }
  if (restIds.length > 0) {
    await tx.productionBatch.updateMany({
      where: { id: { in: restIds } },
      data: { restStatus: RestStatusEnum.BOTTLED },
    });
  }
  await tx.fermentationTank.updateMany({
    where: {
      lotId: lot.id,
      status: {
        in: [
          TankStatusEnum.FILLING,
          TankStatusEnum.FERMENTING,
          TankStatusEnum.COMPLETED,
        ],
      },
      OR: [
        { wineAgingBatch: { id: { in: agingIds } } },
        { productionBatches: { some: { id: { in: restIds } } } },
      ],
    },
    data: { status: TankStatusEnum.TRANSFERRED },
  });
  await tx.lot.update({ where: { id: lot.id }, data: { lotCode } });
  const stage = await refreshLotStage(tx, lot.id, context.clock.now);
  await appendLotEvent(tx, lot.id, {
    type: 'BOTTLED',
    occurredAt: toDbDate(evaluation.bottlingDay),
    stage,
    actorMembershipId: context.membershipId,
    summary: `Embotellado de ${formatQuantity(request.totalBottlesPackaged)} botellas de ${request.packagingFormatCl} cL al ${request.finalAlcoholAbv} % (${lotCode})`,
    data: {
      lotCode,
      bottles: request.totalBottlesPackaged,
      formatCl: request.packagingFormatCl,
      finalAlcoholAbv: request.finalAlcoholAbv,
      balance: evaluation.balance,
    },
    resource: { type: 'bottling_batch', id: created.id },
  });
  await generateBottleUnits(tx, {
    lotId: lot.id,
    bottlingBatchId: created.id,
    count: request.totalBottlesPackaged,
  });
  await appendLotEvent(tx, lot.id, {
    type: 'BOTTLE_CODES_GENERATED',
    occurredAt: context.clock.now,
    stage,
    actorMembershipId: context.membershipId,
    summary: `${formatQuantity(request.totalBottlesPackaged)} códigos de botella generados`,
    data: { count: request.totalBottlesPackaged },
    resource: { type: 'bottling_batch', id: created.id },
  });
  return created.id;
}
