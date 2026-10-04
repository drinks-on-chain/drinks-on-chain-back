import { Prisma } from '@prisma/client';
import type { ErrorDetail } from '@shared/interfaces/api-response.interface';
import { dateOnly, laPazDate } from './domain/dates';
import { IntegrityLot, lotIntegrityViolations } from './domain/lot-integrity';
import { parseLotRules } from './domain/lot-rules';
import type { LotProductType } from './domain/lot-stage';
import { num } from './domain/sources';

type Tx = Prisma.TransactionClient;

/** Carga del lote lo que deciden sus reglas, con los valores vigentes. */
export async function loadIntegrityLot(
  tx: Tx,
  lotId: string,
): Promise<IntegrityLot> {
  const lot = await tx.lot.findUniqueOrThrow({
    where: { id: lotId },
    select: {
      productType: true,
      rules: true,
      harvestBatches: {
        select: {
          id: true,
          harvestBatchCode: true,
          netWeightKg: true,
          phytosanitaryStatus: true,
          tankInputs: { select: { kg: true } },
          terroir: {
            select: {
              id: true,
              parcelName: true,
              altitudeMasl: true,
              varietyName: true,
            },
          },
        },
        orderBy: { intakeDate: 'asc' },
      },
      fermentationTanks: {
        select: {
          id: true,
          tankCode: true,
          capacityLiters: true,
          volumeFilledLiters: true,
          finalVolumeLiters: true,
          wineAgingBatch: { select: { volumeLiters: true } },
          productionBatches: { select: { inputVolumeLiters: true } },
        },
        orderBy: { startDate: 'asc' },
      },
      wineAgingBatches: {
        select: {
          id: true,
          startDate: true,
          createdAt: true,
          plannedMonths: true,
          lockUntilDate: true,
          volumeLiters: true,
          agingStatus: true,
          discardedAt: true,
        },
        orderBy: { createdAt: 'asc' },
      },
      productionBatches: {
        select: {
          id: true,
          inputVolumeLiters: true,
          headsLiters: true,
          heartLiters: true,
          tailsLiters: true,
          vinasseLiters: true,
          heartAbvPercent: true,
          outputVolumeLiters: true,
          initialAlcoholPercentage: true,
          processEndDate: true,
          restStatus: true,
          discardedAt: true,
        },
        orderBy: { processStartDate: 'asc' },
      },
      bottlingBatch: {
        select: {
          id: true,
          bottlingDate: true,
          totalBottlesPackaged: true,
          packagingFormatCl: true,
          finalAlcoholAbv: true,
          waterDilutionLiters: true,
          leftoverLiters: true,
        },
      },
    },
  });
  return {
    productType: lot.productType as LotProductType | null,
    rules: parseLotRules(lot.rules),
    harvests: lot.harvestBatches.map((h) => ({
      id: h.id,
      code: h.harvestBatchCode,
      netKg: h.netWeightKg.toNumber(),
      phytoStatus: h.phytosanitaryStatus,
      inputsKg:
        Math.round(
          h.tankInputs.reduce((sum, i) => sum + i.kg.toNumber(), 0) * 1000,
        ) / 1000,
      terroir: {
        id: h.terroir.id,
        parcelName: h.terroir.parcelName,
        altitudeMasl: h.terroir.altitudeMasl.toNumber(),
        varietyName: h.terroir.varietyName,
      },
    })),
    tanks: lot.fermentationTanks.map((t) => ({
      id: t.id,
      tankCode: t.tankCode,
      capacityLiters: num(t.capacityLiters),
      filledLiters: num(t.volumeFilledLiters),
      finalLiters: num(t.finalVolumeLiters),
      drawnLiters:
        (num(t.wineAgingBatch?.volumeLiters) ?? 0) +
        t.productionBatches.reduce(
          (sum, p) => sum + (num(p.inputVolumeLiters) ?? 0),
          0,
        ),
    })),
    agings: lot.wineAgingBatches.map((a) => ({
      id: a.id,
      startDate: a.startDate ? dateOnly(a.startDate) : laPazDate(a.createdAt),
      plannedMonths: a.plannedMonths,
      storedUnlockDate: dateOnly(a.lockUntilDate),
      volumeLiters: num(a.volumeLiters),
      discarded: a.discardedAt !== null || a.agingStatus === 'DISCARDED',
      bottled: a.agingStatus === 'BOTTLED',
    })),
    distillations: lot.productionBatches.map((p) => ({
      id: p.id,
      inputLiters: num(p.inputVolumeLiters),
      headsLiters: num(p.headsLiters),
      heartLiters: num(p.heartLiters) ?? num(p.outputVolumeLiters),
      tailsLiters: num(p.tailsLiters),
      vinasseLiters: num(p.vinasseLiters),
      heartAbvPercent:
        num(p.heartAbvPercent) ?? num(p.initialAlcoholPercentage),
      processEndDate: p.processEndDate ? dateOnly(p.processEndDate) : null,
      discarded: p.discardedAt !== null || p.restStatus === 'DISCARDED',
      bottled: p.restStatus === 'BOTTLED',
    })),
    bottling: lot.bottlingBatch
      ? {
          id: lot.bottlingBatch.id,
          bottlingDay: dateOnly(lot.bottlingBatch.bottlingDate),
          bottles: lot.bottlingBatch.totalBottlesPackaged,
          formatCl: lot.bottlingBatch.packagingFormatCl,
          finalAbv: lot.bottlingBatch.finalAlcoholAbv.toNumber(),
          waterLiters: num(lot.bottlingBatch.waterDilutionLiters) ?? 0,
          leftoverLiters: num(lot.bottlingBatch.leftoverLiters) ?? 0,
        }
      : null,
  };
}

/** Revisión de integridad del lote con sus valores vigentes. */
export async function lotIntegrity(
  tx: Tx,
  lotId: string,
): Promise<ErrorDetail[]> {
  return lotIntegrityViolations(await loadIntegrityLot(tx, lotId));
}

export interface IssueReevaluation {
  /** Incidencias que ya no aplican y quedan resueltas. */
  resolvedIssueIds: string[];
  /** Incidencias nuevas abiertas por `record`. */
  openedIssueIds: string[];
}

/**
 * Reevalúa las incidencias del lote tras una escritura (§9): las abiertas
 * cuyo código la escritura **resolvió** (se incumplía antes y ya no, ver
 * `compareIntegrity`) quedan resueltas (`resolvedAt`, con la corrección que
 * lo logró), y las violaciones de `record` (las que la corrección deja
 * registradas) se abren como incidencias nuevas, agrupadas por código, salvo
 * que ya haya una abierta con ese código.
 */
export async function reevaluateLotIssues(
  tx: Tx,
  lotId: string,
  options: {
    clearedCodes: readonly string[];
    record: readonly ErrorDetail[];
    source: 'CORRECTION' | 'RULES_REEVALUATION';
    correctionId: string | null;
    now: Date;
  },
): Promise<IssueReevaluation> {
  const open = await tx.lotComplianceIssue.findMany({
    where: { lotId, resolvedAt: null },
    select: { id: true, code: true },
  });
  const resolved = open.filter((issue) =>
    options.clearedCodes.includes(issue.code),
  );
  if (resolved.length > 0) {
    await tx.lotComplianceIssue.updateMany({
      where: { id: { in: resolved.map((i) => i.id) } },
      data: {
        resolvedAt: options.now,
        resolvedByCorrectionId: options.correctionId,
      },
    });
  }
  const stillOpen = new Set(
    open.filter((i) => !resolved.includes(i)).map((i) => i.code),
  );
  const byCode = new Map<string, ErrorDetail[]>();
  for (const detail of options.record) {
    const code = detail.code ?? '';
    if (!code || stillOpen.has(code)) continue;
    byCode.set(code, [...(byCode.get(code) ?? []), detail]);
  }
  const openedIssueIds: string[] = [];
  for (const [code, details] of byCode) {
    const issue = await tx.lotComplianceIssue.create({
      data: {
        lotId,
        code,
        message: details[0].message,
        source: options.source,
        details: details as unknown as Prisma.InputJsonArray,
        detectedAt: options.now,
      },
      select: { id: true },
    });
    openedIssueIds.push(issue.id);
  }
  return { resolvedIssueIds: resolved.map((i) => i.id), openedIssueIds };
}
