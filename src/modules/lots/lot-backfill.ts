import { Prisma } from '@prisma/client';
import { v5 as uuidv5 } from 'uuid';
import { ErrorCode } from '@shared/exceptions/error-codes';
import type { ErrorDetail } from '@shared/interfaces/api-response.interface';
import type { AuditEventInput } from '@shared/audit/audit.types';
import { createLotRecord, refreshLotStage } from './lot-records';
import { appendLotEvent, formatQuantity } from './lot-events';
import { generateBottleUnits, passportUrl } from './bottle-units';
import { dbClock } from './trace-db';
import { dateOnly, laPazDate, toDbDate } from './domain/dates';
import {
  doRulesFromLot,
  doViolations,
  evaluateDo,
} from './domain/do-evaluation';
import {
  computeLabConformity,
  methanolToAnhydrous,
} from './domain/lab-conformity';
import { agingLock, restLock } from './domain/locks';
import {
  bottlingBalanceViolations,
  computeBottlingBalance,
} from './domain/bottling-balance';
import {
  distillationHeart,
  legacyCuts,
  num,
  tankLiters,
} from './domain/sources';
import { LOT_RULE_KEYS, LotRules } from './domain/lot-rules';
import type { LotProductType, LotStage } from './domain/lot-stage';
import { violation } from './domain/trace-errors';

type Tx = Prisma.TransactionClient;

/**
 * Espacio de nombres de los UUID v5 del proyecto (el de `@drinks-on-chain/mocks`,
 * `src/shared/uuid.ts`): la semilla y los mocks derivan los mismos ids.
 */
export const LOT_ID_NAMESPACE = '6b2f4c1e-9c3a-4d5e-8f70-1a2b3c4d5e6f';

/** Id del lote migrado de un pesaje: UUID v5 de `lot:{harvestBatchId}` (§2.6). */
export function migratedLotId(harvestBatchId: string): string {
  return uuidv5(`lot:${harvestBatchId}`, LOT_ID_NAMESPACE);
}

export interface BackfillDeps {
  passportBaseUrl: string;
  /** Registra la entrada de bitácora del lote migrado (en la misma transacción). */
  audit?: (tx: Tx, input: AuditEventInput) => Promise<unknown>;
}

export interface BackfillResult {
  harvestBatchId: string;
  lotId: string | null;
  skipped: 'ALREADY_ASSIGNED' | 'NOT_FOUND' | null;
  stage: LotStage | null;
  issues: string[];
  bottleCodes: number;
}

interface Issue {
  code: string;
  message: string;
  details: ErrorDetail[];
}

/**
 * Relleno de un pesaje anterior a la Ola 2 (contrato O2 §2.6): crea su lote
 * (uno por pesaje, como `LotView`) con la instantánea `MIGRATION`, le cuelga
 * la cadena (tanques, crianzas, destilaciones, embotellado, laboratorio),
 * genera los dictámenes, el primer análisis de madurez, las entradas de
 * tanque, la conformidad de laboratorio, los códigos de botella y la línea de
 * tiempo, y revisa las reglas de la ola: lo que no cumple queda como
 * incidencia `MIGRATION` (no se borra ni se corrige solo).
 *
 * Idempotente: un pesaje que ya tiene lote no se toca.
 */
export async function backfillHarvestChain(
  tx: Tx,
  harvestBatchId: string,
  deps: BackfillDeps,
): Promise<BackfillResult> {
  const result: BackfillResult = {
    harvestBatchId,
    lotId: null,
    skipped: null,
    stage: null,
    issues: [],
    bottleCodes: 0,
  };
  // Serializa el relleno del mismo pesaje (API y semilla a la vez)
  await tx.$queryRaw`SELECT id FROM harvest_batches WHERE id = ${harvestBatchId}::uuid FOR UPDATE`;
  const harvest = await tx.harvestBatch.findUnique({
    where: { id: harvestBatchId },
    include: {
      terroir: true,
      fermentationTanks: {
        orderBy: [{ startDate: 'asc' }, { id: 'asc' }],
        include: {
          wineAgingBatch: {
            include: { bottlingBatches: { include: { labAnalyses: true } } },
          },
          productionBatches: {
            orderBy: [{ processStartDate: 'asc' }, { id: 'asc' }],
            include: { bottlingBatches: { include: { labAnalyses: true } } },
          },
        },
      },
    },
  });
  if (!harvest) {
    result.skipped = 'NOT_FOUND';
    return result;
  }
  if (harvest.lotId) {
    result.skipped = 'ALREADY_ASSIGNED';
    result.lotId = harvest.lotId;
    return result;
  }

  const clock = await dbClock(tx);
  const tanks = harvest.fermentationTanks;
  const agings = tanks.flatMap((t) =>
    t.wineAgingBatch ? [t.wineAgingBatch] : [],
  );
  const productions = tanks.flatMap((t) => t.productionBatches);
  const bottlings = [
    ...agings.flatMap((a) =>
      a.bottlingBatches.map((b) => ({ b, source: a, kind: 'AGING' as const })),
    ),
    ...productions.flatMap((p) =>
      p.bottlingBatches.map((b) => ({ b, source: p, kind: 'REST' as const })),
    ),
  ].sort(
    (x, y) =>
      x.b.bottlingDate.getTime() - y.b.bottlingDate.getTime() ||
      x.b.id.localeCompare(y.b.id),
  );

  // Tipo derivado (§2.6.2): destilación o tanque a singani → SINGANI;
  // crianza → WINE. Un tanque con destino WINE_AGING predeclara el vino igual
  // que SINGANI_DIST el singani (la misma regla que al llenar un tanque, §4.3)
  let productType: LotProductType | null = null;
  if (
    productions.length > 0 ||
    tanks.some((t) => t.destinationType === 'SINGANI_DIST')
  ) {
    productType = 'SINGANI';
  } else if (
    agings.length > 0 ||
    tanks.some((t) => t.destinationType === 'WINE_AGING')
  ) {
    productType = 'WINE';
  }

  const bottled = bottlings[0] ?? null;
  const lotId = migratedLotId(harvest.id);
  const name = bottled
    ? bottled.b.internationalLotCode
    : `${harvest.terroir.varietyName} ${harvest.harvestYear}`;
  const created = await createLotRecord(tx, {
    wineryId: harvest.wineryId,
    id: lotId,
    name: name.slice(0, 120),
    harvestYear: harvest.harvestYear,
    productType,
    createdByMembershipId: null,
    origin: 'MIGRATION',
    createdAt: harvest.createdAt,
    takenAt: clock.now,
    summary: `Lote migrado desde el pesaje ${harvest.harvestBatchCode} (reglas fijadas al migrar)`,
  });
  const rules = created.rules;
  result.lotId = lotId;
  if (bottled) {
    await tx.lot.update({
      where: { id: lotId },
      data: { lotCode: bottled.b.internationalLotCode },
    });
  }

  // ── Pesaje: lote, parcela tal como está hoy, dictamen y análisis ─────────
  await tx.harvestBatch.update({
    where: { id: harvest.id },
    data: {
      lotId,
      terroirSnapshot: {
        parcelName: harvest.terroir.parcelName,
        altitudeMasl: harvest.terroir.altitudeMasl.toNumber(),
        varietyName: harvest.terroir.varietyName,
        rawMaterialType: harvest.terroir.rawMaterialType,
        takenAt: clock.now.toISOString(),
        source: 'MIGRATION',
      },
    },
  });
  await appendLotEvent(tx, lotId, {
    type: 'HARVEST_WEIGHED',
    occurredAt: harvest.intakeDate,
    recordedAt: harvest.createdAt,
    stage: 'HARVEST',
    actorMembershipId: null,
    summary: `Pesaje de ${formatQuantity(harvest.netWeightKg.toNumber(), 3)} kg desde ${harvest.terroir.parcelName}`,
    data: {
      netWeightKg: harvest.netWeightKg.toNumber(),
      unit: 'kg',
      harvestBatchCode: harvest.harvestBatchCode,
    },
    resource: { type: 'harvest_batch', id: harvest.id },
  });

  const brix = num(harvest.brixDegrees);
  const ph = num(harvest.initialPh);
  const acidity = num(harvest.initialAcidityGl);
  // 0/0/0 en los datos anteriores = sin análisis (un pH 0 es imposible)
  if (
    brix !== null &&
    ph !== null &&
    acidity !== null &&
    (brix > 0 || ph > 0 || acidity > 0)
  ) {
    const analysis = await tx.maturityAnalysis.create({
      data: {
        harvestBatchId: harvest.id,
        brixDegrees: harvest.brixDegrees as Prisma.Decimal,
        ph: harvest.initialPh as Prisma.Decimal,
        acidityGl: harvest.initialAcidityGl as Prisma.Decimal,
        measuredAt: harvest.intakeDate,
        recordedAt: harvest.createdAt,
        source: 'MIGRATION',
      },
    });
    await appendLotEvent(tx, lotId, {
      type: 'MATURITY_ANALYZED',
      occurredAt: harvest.intakeDate,
      recordedAt: harvest.createdAt,
      stage: 'HARVEST',
      actorMembershipId: null,
      summary: `Análisis de madurez: ${brix} °Bx, pH ${ph}, acidez ${acidity} g/L`,
      data: { brixDegrees: brix, ph, acidityGl: acidity },
      resource: { type: 'maturity_analysis', id: analysis.id },
    });
  }
  if (harvest.phytosanitaryStatus !== 'PENDING_INSPECTION') {
    const decision = await tx.phytoDecision.create({
      data: {
        harvestBatchId: harvest.id,
        decision: harvest.phytosanitaryStatus,
        decidedAt: harvest.createdAt,
        recordedAt: harvest.createdAt,
        decidedByMembershipId: harvest.certifiedByMemberId,
        source: 'MIGRATION',
      },
    });
    await appendLotEvent(tx, lotId, {
      type: 'PHYTO_DECIDED',
      occurredAt: harvest.createdAt,
      stage: 'HARVEST',
      actorMembershipId: harvest.certifiedByMemberId,
      summary: `Dictamen fitosanitario: ${harvest.phytosanitaryStatus}`,
      data: { decision: harvest.phytosanitaryStatus, source: 'MIGRATION' },
      resource: { type: 'phyto_decision', id: decision.id },
    });
  }

  // ── Tanques: lote y entradas (kilos repartidos por volumen) ──────────────
  const net = harvest.netWeightKg.toNumber();
  const filled = tanks.map((t) => num(t.volumeFilledLiters) ?? 0);
  const totalFilled = filled.reduce((a, b) => a + b, 0);
  let assigned = 0;
  for (const [i, tank] of tanks.entries()) {
    const last = i === tanks.length - 1;
    const share =
      totalFilled > 0 ? (net * filled[i]) / totalFilled : net / tanks.length;
    const kg = last ? net - assigned : Math.round(share * 1000) / 1000;
    assigned += kg;
    await tx.fermentationTank.update({
      where: { id: tank.id },
      data: { lotId },
    });
    await tx.fermentationTankInput.create({
      data: {
        fermentationTankId: tank.id,
        harvestBatchId: harvest.id,
        kg: new Prisma.Decimal(Math.max(0, Math.round(kg * 1000) / 1000)),
        createdAt: tank.createdAt,
      },
    });
    await appendLotEvent(tx, lotId, {
      type: 'TANK_FILLED',
      occurredAt: tank.startDate,
      recordedAt: tank.createdAt,
      stage: 'FERMENTING',
      actorMembershipId: null,
      summary: `Tanque ${tank.tankCode} lleno con ${formatQuantity(num(tank.volumeFilledLiters) ?? 0, 2)} L`,
      data: {
        tankCode: tank.tankCode,
        volumeFilledLiters: num(tank.volumeFilledLiters),
        unit: 'L',
      },
      resource: { type: 'fermentation_tank', id: tank.id },
    });
    if (tank.endDate) {
      await appendLotEvent(tx, lotId, {
        type: 'FERMENTATION_COMPLETED',
        occurredAt: tank.endDate,
        recordedAt: tank.createdAt,
        stage: 'FERMENTING',
        actorMembershipId: null,
        summary: `Fermentación completada en ${tank.tankCode}`,
        data: {
          tankCode: tank.tankCode,
          destinationType: tank.destinationType,
        },
        resource: { type: 'fermentation_tank', id: tank.id },
      });
    }
  }

  // ── Crianzas y destilaciones ──────────────────────────────────────────────
  for (const aging of agings) {
    const startDate = aging.startDate
      ? dateOnly(aging.startDate)
      : laPazDate(aging.createdAt);
    await tx.wineAgingBatch.update({
      where: { id: aging.id },
      data: {
        lotId,
        ...(aging.startDate ? {} : { startDate: toDbDate(startDate) }),
      },
    });
    await appendLotEvent(tx, lotId, {
      type: 'AGING_STARTED',
      occurredAt: toDbDate(startDate),
      recordedAt: aging.createdAt,
      stage: 'AGING',
      actorMembershipId: null,
      summary: `Crianza en ${aging.containerType} por ${aging.plannedMonths} meses`,
      data: {
        plannedMonths: aging.plannedMonths,
        volumeLiters: num(aging.volumeLiters),
        unit: 'L',
      },
      resource: { type: 'wine_aging_batch', id: aging.id },
    });
  }
  for (const p of productions) {
    const cuts = legacyCuts(p.additionalParams);
    await tx.productionBatch.update({
      where: { id: p.id },
      data: {
        lotId,
        ...(p.processEndDate && p.heartLiters === null
          ? {
              headsLiters:
                cuts.heads !== null ? new Prisma.Decimal(cuts.heads) : null,
              heartLiters:
                cuts.heart !== null
                  ? new Prisma.Decimal(cuts.heart)
                  : p.outputVolumeLiters,
              tailsLiters:
                cuts.tails !== null ? new Prisma.Decimal(cuts.tails) : null,
              heartAbvPercent: p.heartAbvPercent ?? p.initialAlcoholPercentage,
            }
          : {}),
      },
    });
    await appendLotEvent(tx, lotId, {
      type: 'DISTILLATION_STARTED',
      occurredAt: p.processStartDate,
      recordedAt: p.createdAt,
      stage: 'DISTILLING',
      actorMembershipId: null,
      summary: `Destilación en ${p.equipmentIdentifier} de ${formatQuantity(num(p.inputVolumeLiters) ?? 0, 3)} L`,
      data: { inputVolumeLiters: num(p.inputVolumeLiters), unit: 'L' },
      resource: { type: 'production_batch', id: p.id },
    });
    if (p.processEndDate) {
      const heart = distillationHeart(p);
      await appendLotEvent(tx, lotId, {
        type: 'DISTILLATION_CLOSED',
        occurredAt: p.processEndDate,
        recordedAt: p.createdAt,
        stage: 'RESTING',
        actorMembershipId: null,
        summary: `Destilación cerrada: corazón de ${formatQuantity(heart.liters ?? 0, 3)} L al ${heart.abv ?? '—'} %`,
        data: {
          heartLiters: heart.liters,
          heartAbvPercent: heart.abv,
          unit: 'L',
        },
        resource: { type: 'production_batch', id: p.id },
      });
    }
  }

  const issues: Issue[] = [];

  // ── Embotellado, códigos de botella y laboratorio ────────────────────────
  for (const [index, entry] of bottlings.entries()) {
    const { b } = entry;
    if (index > 0) {
      // Un embotellado por lote (S-10): los demás quedan sin lote e incidencia
      issues.push({
        code: ErrorCode.TRC_LOT_ALREADY_BOTTLED,
        message: `El lote tiene un segundo embotellado (${b.internationalLotCode}) anterior a la Ola 2`,
        details: [
          violation(
            ErrorCode.TRC_LOT_ALREADY_BOTTLED,
            `Embotellado adicional ${b.internationalLotCode}`,
            {
              meta: { bottlingBatchId: b.id, lotCode: b.internationalLotCode },
            },
          ),
        ],
      });
      continue;
    }
    const sourceHeart =
      entry.kind === 'REST' ? distillationHeart(entry.source as never) : null;
    const available =
      entry.kind === 'AGING'
        ? num(
            (entry.source as { volumeLiters: Prisma.Decimal | null })
              .volumeLiters,
          )
        : (sourceHeart?.liters ?? null);
    await tx.bottlingBatch.update({
      where: { id: b.id },
      data: {
        lotId,
        qrBatchUrl: passportUrl(deps.passportBaseUrl, b.internationalLotCode),
        ...(available !== null && {
          availableLiters: new Prisma.Decimal(available),
        }),
      },
    });
    await appendLotEvent(tx, lotId, {
      type: 'BOTTLED',
      occurredAt: b.bottlingDate,
      recordedAt: b.createdAt,
      stage: 'BOTTLED',
      actorMembershipId: b.releasedByMemberId,
      summary: `Embotellado de ${formatQuantity(b.totalBottlesPackaged)} botellas de ${b.packagingFormatCl} cL (${b.internationalLotCode})`,
      data: {
        lotCode: b.internationalLotCode,
        bottles: b.totalBottlesPackaged,
        formatCl: b.packagingFormatCl,
        finalAlcoholAbv: b.finalAlcoholAbv.toNumber(),
      },
      resource: { type: 'bottling_batch', id: b.id },
    });
    const existingCodes = await tx.bottleUnit.count({
      where: { bottlingBatchId: b.id },
    });
    if (existingCodes === 0) {
      await generateBottleUnits(tx, {
        lotId,
        bottlingBatchId: b.id,
        count: b.totalBottlesPackaged,
      });
      result.bottleCodes = b.totalBottlesPackaged;
      await appendLotEvent(tx, lotId, {
        type: 'BOTTLE_CODES_GENERATED',
        occurredAt: clock.now,
        stage: 'BOTTLED',
        actorMembershipId: null,
        summary: `${formatQuantity(b.totalBottlesPackaged)} códigos de botella generados al migrar`,
        data: { count: b.totalBottlesPackaged },
        resource: { type: 'bottling_batch', id: b.id },
      });
    }

    // Laboratorio: se recalcula la conformidad (§2.6.6); el valor guardado queda como histórico
    const labs = [...b.labAnalyses].sort(
      (x, y) => x.createdAt.getTime() - y.createdAt.getTime(),
    );
    for (const [i, lab] of labs.entries()) {
      const abv = lab.actualAlcoholAbv.toNumber();
      const methanolAa =
        num(lab.methanolMg100mlAa) ??
        (num(lab.methanolContentMgL) !== null
          ? methanolToAnhydrous(num(lab.methanolContentMgL) as number, abv)
          : null);
      const conformity = computeLabConformity({
        productType,
        values: {
          actualAlcoholAbv: abv,
          volatileAcidityAceticGl: num(lab.volatileAcidityAceticGl),
          methanolMg100mlAa: methanolAa,
          copperContentMgL: num(lab.copperContentMgL),
        },
        limits: rules.lab.limits,
        labeledAbv: b.finalAlcoholAbv.toNumber(),
        rulesTakenAt: rules.takenAt,
      });
      const superseded = i < labs.length - 1 ? labs[i + 1].createdAt : null;
      await tx.batchLabAnalysis.update({
        where: { id: lab.id },
        data: {
          lotId,
          methanolMg100mlAa:
            methanolAa !== null ? new Prisma.Decimal(methanolAa) : null,
          conformity: conformity as unknown as Prisma.InputJsonObject,
          conformityStatus: conformity.status,
          supersededAt: lab.supersededAt ?? superseded,
        },
      });
      await appendLotEvent(tx, lotId, {
        type: 'LAB_REGISTERED',
        occurredAt: lab.testPerformedAt,
        recordedAt: lab.createdAt,
        stage: 'BOTTLED',
        actorMembershipId: lab.reviewedByMemberId,
        summary: `Análisis de laboratorio de ${lab.certifiedLaboratoryName}: ${conformity.status}`,
        data: { conformity: conformity.status },
        resource: { type: 'lab_analysis', id: lab.id },
      });
    }

    // Revisión de integridad del embotellado: candado y balance
    issues.push(...bottlingIssues(entry, rules, productType));
  }

  // ── Revisión de integridad del resto de la cadena (§2.6.8) ───────────────
  issues.push(
    ...chainIssues(
      harvest,
      tanks,
      agings,
      productions,
      bottled?.b.id ?? null,
      rules,
      productType,
    ),
  );

  const stage = await refreshLotStage(
    tx,
    lotId,
    latestInstant(harvest, tanks, agings, productions, bottled?.b ?? null),
  );
  result.stage = stage;
  for (const issue of issues) {
    await tx.lotComplianceIssue.create({
      data: {
        lotId,
        code: issue.code,
        message: issue.message,
        source: 'MIGRATION',
        details: issue.details as unknown as Prisma.InputJsonArray,
        detectedAt: clock.now,
      },
    });
    result.issues.push(issue.code);
  }

  if (deps.audit) {
    await deps.audit(tx, {
      action: 'LOT_MIGRATED',
      resource: { type: 'lot', id: lotId },
      organizationId: harvest.wineryId,
      actor: null,
      after: {
        reference: created.reference,
        harvestBatchId: harvest.id,
        stage,
        productType,
        lotCode: bottled?.b.internationalLotCode ?? null,
        complianceIssues: result.issues,
        bottleCodes: result.bottleCodes,
      },
      reason: 'Relleno de la migración de la Ola 2 (§2.6)',
    });
  }
  return result;
}

type HarvestWithChain = Prisma.HarvestBatchGetPayload<{
  include: {
    terroir: true;
    fermentationTanks: {
      include: {
        wineAgingBatch: {
          include: { bottlingBatches: { include: { labAnalyses: true } } };
        };
        productionBatches: {
          include: { bottlingBatches: { include: { labAnalyses: true } } };
        };
      };
    };
  };
}>;
type TankRow = HarvestWithChain['fermentationTanks'][number];
type AgingRow = NonNullable<TankRow['wineAgingBatch']>;
type ProductionRow = TankRow['productionBatches'][number];
type BottlingRow = AgingRow['bottlingBatches'][number];

function latestInstant(
  harvest: HarvestWithChain,
  tanks: TankRow[],
  agings: AgingRow[],
  productions: ProductionRow[],
  bottling: BottlingRow | null,
): Date {
  const dates: Date[] = [harvest.intakeDate];
  for (const t of tanks) dates.push(t.endDate ?? t.startDate);
  for (const a of agings) dates.push(a.createdAt);
  for (const p of productions)
    dates.push(p.processEndDate ?? p.processStartDate);
  if (bottling) dates.push(bottling.bottlingDate);
  return dates.reduce((a, b) => (a > b ? a : b));
}

function bottlingIssues(
  entry: {
    b: BottlingRow;
    source: AgingRow | ProductionRow;
    kind: 'AGING' | 'REST';
  },
  rules: LotRules,
  productType: LotProductType | null,
): Issue[] {
  const out: Issue[] = [];
  const { b } = entry;
  const bottlingDay = dateOnly(b.bottlingDate);
  // Candado: con la fecha del embotellado (el reloj de entonces no se conoce)
  const lock =
    entry.kind === 'AGING'
      ? agingLock(
          {
            id: entry.source.id,
            startDate: (entry.source as AgingRow).startDate
              ? dateOnly((entry.source as AgingRow).startDate as Date)
              : laPazDate((entry.source as AgingRow).createdAt),
            plannedMonths: (entry.source as AgingRow).plannedMonths,
            storedUnlockDate: dateOnly(
              (entry.source as AgingRow).lockUntilDate,
            ),
          },
          rules,
          bottlingDay,
        )
      : restLock(
          {
            id: entry.source.id,
            processEndDate: (entry.source as ProductionRow).processEndDate
              ? dateOnly((entry.source as ProductionRow).processEndDate as Date)
              : null,
            storedUnlockDate: null,
          },
          rules,
          bottlingDay,
        );
  if (!lock) {
    out.push({
      code: ErrorCode.TRC_BOTTLING_SOURCE_INVALID,
      message: 'Se embotelló una destilación sin fecha de cierre',
      details: [
        violation(
          ErrorCode.TRC_BOTTLING_SOURCE_INVALID,
          'Destilación sin cerrar embotellada',
          {
            meta: { sourceId: entry.source.id },
          },
        ),
      ],
    });
  } else if (!lock.released) {
    out.push({
      code: ErrorCode.TRC_LOCK_NOT_RELEASED,
      message: `Se embotelló el ${bottlingDay}, antes del fin del candado (${lock.unlockDate})`,
      details: [
        violation(
          ErrorCode.TRC_LOCK_NOT_RELEASED,
          `Embotellado ${lock.daysRemaining} días antes del fin del candado`,
          {
            field: 'bottlingDate',
            rule: lock.rule.settingKey,
            expected: lock.unlockDate,
            actual: bottlingDay,
            meta: {
              sourceId: lock.sourceId,
              kind: lock.kind,
              unlockDate: lock.unlockDate,
              daysRemaining: lock.daysRemaining,
            },
          },
        ),
      ],
    });
  }

  const type: LotProductType =
    productType ?? (entry.kind === 'AGING' ? 'WINE' : 'SINGANI');
  const heart =
    entry.kind === 'REST'
      ? distillationHeart(entry.source as ProductionRow)
      : null;
  const available =
    entry.kind === 'AGING'
      ? num((entry.source as AgingRow).volumeLiters)
      : (heart?.liters ?? null);
  if (available === null) {
    out.push({
      code: ErrorCode.TRC_VOLUME_MISSING,
      message:
        'La fuente del embotellado no tiene volumen registrado: no se puede verificar el balance',
      details: [
        violation(
          ErrorCode.TRC_VOLUME_MISSING,
          'Volumen de la fuente sin registrar',
          {
            field:
              entry.kind === 'AGING' ? 'volumeLiters' : 'outputVolumeLiters',
            meta: { sourceId: entry.source.id },
          },
        ),
      ],
    });
    return out;
  }
  const input = {
    productType: type,
    availableLiters: available,
    waterDilutionLiters: num(b.waterDilutionLiters) ?? 0,
    bottles: b.totalBottlesPackaged,
    formatCl: b.packagingFormatCl,
    leftoverLiters: num(b.leftoverLiters) ?? 0,
    maxLossPercent: rules.bottling.maxLossPercent,
    finalAbv: b.finalAlcoholAbv.toNumber(),
    pureAlcoholAvailableLiters:
      heart && heart.liters !== null && heart.abv !== null
        ? (heart.liters * heart.abv) / 100
        : null,
  };
  for (const v of bottlingBalanceViolations(
    input,
    computeBottlingBalance(input),
  )) {
    out.push({ code: v.code as string, message: v.message, details: [v] });
  }
  return out;
}

function chainIssues(
  harvest: HarvestWithChain,
  tanks: TankRow[],
  agings: AgingRow[],
  productions: ProductionRow[],
  bottledId: string | null,
  rules: LotRules,
  productType: LotProductType | null,
): Issue[] {
  const out: Issue[] = [];

  // D.O. del lote singani con la instantánea
  if (productType === 'SINGANI') {
    const evaluation = evaluateDo(
      [
        {
          id: harvest.terroir.id,
          altitudeMasl: harvest.terroir.altitudeMasl.toNumber(),
          varietyName: harvest.terroir.varietyName,
        },
      ],
      doRulesFromLot(rules),
      'LOT_SNAPSHOT',
    );
    if (evaluation.status === 'NOT_ELIGIBLE') {
      out.push({
        code: ErrorCode.TRC_DO_NOT_ELIGIBLE,
        message:
          'El lote singani no cumple la D.O. con las reglas de la instantánea',
        details: doViolations(
          evaluation,
          ErrorCode.TRC_DO_NOT_ELIGIBLE,
          {
            [harvest.terroir.id]: harvest.terroir.parcelName,
          },
          () => ({
            harvestBatchId: harvest.id,
            harvestBatchCode: harvest.harvestBatchCode,
          }),
        ),
      });
    }
  }

  // Dictamen: uva en un tanque sin el estado exigido (R4, S-2)
  const allowed = rules.phytosanitary.requireApproved
    ? ['APPROVED']
    : ['APPROVED', 'PENDING_INSPECTION'];
  if (tanks.length > 0 && !allowed.includes(harvest.phytosanitaryStatus)) {
    out.push({
      code: ErrorCode.TRC_PHYTO_NOT_APPROVED,
      message: `Uva con dictamen ${harvest.phytosanitaryStatus} en ${tanks.length === 1 ? 'un tanque' : `${tanks.length} tanques`}`,
      details: [
        violation(
          ErrorCode.TRC_PHYTO_NOT_APPROVED,
          `El pesaje ${harvest.harvestBatchCode} está en ${harvest.phytosanitaryStatus}`,
          {
            rule: LOT_RULE_KEYS.requireApproved,
            expected: allowed,
            actual: harvest.phytosanitaryStatus,
            meta: {
              harvestBatchId: harvest.id,
              harvestBatchCode: harvest.harvestBatchCode,
              status: harvest.phytosanitaryStatus,
              tankIds: tanks.map((t) => t.id),
            },
          },
        ),
      ],
    });
  }

  // Volumen: lo que sale de cada tanque no puede superar lo que tiene
  for (const tank of tanks) {
    const liters = tankLiters(tank);
    const drawn =
      (tank.wineAgingBatch ? (num(tank.wineAgingBatch.volumeLiters) ?? 0) : 0) +
      tank.productionBatches.reduce(
        (sum, p) => sum + (num(p.inputVolumeLiters) ?? 0),
        0,
      );
    if (liters !== null && drawn > liters + 1e-6) {
      out.push({
        code: ErrorCode.TRC_VOLUME_EXCEEDS_AVAILABLE,
        message: `Del tanque ${tank.tankCode} salieron ${drawn} L y solo tenía ${liters} L`,
        details: [
          violation(
            ErrorCode.TRC_VOLUME_EXCEEDS_AVAILABLE,
            `Salidas del tanque ${tank.tankCode} por encima de su volumen`,
            {
              expected: liters,
              actual: drawn,
              meta: {
                tankId: tank.id,
                available: liters,
                requested: drawn,
                unit: 'L',
              },
            },
          ),
        ],
      });
    }
  }

  // Fuentes abiertas en un lote ya embotellado (§6.2.3)
  if (bottledId) {
    const open = [
      ...agings
        .filter(
          (a) =>
            !a.discardedAt &&
            !a.bottlingBatches.some((b) => b.id === bottledId),
        )
        .filter((a) => a.bottlingBatches.length === 0)
        .map((a) => a.id),
      ...productions
        .filter((p) => !p.discardedAt && p.bottlingBatches.length === 0)
        .map((p) => p.id),
    ];
    if (open.length > 0) {
      out.push({
        code: ErrorCode.TRC_BOTTLING_SOURCES_PENDING,
        message:
          'El lote está embotellado y tiene fuentes abiertas que no entraron en el embotellado',
        details: [
          violation(
            ErrorCode.TRC_BOTTLING_SOURCES_PENDING,
            'Fuentes abiertas sin embotellar ni descartar',
            {
              meta: { sourceIds: open },
            },
          ),
        ],
      });
    }
  }
  return out;
}
