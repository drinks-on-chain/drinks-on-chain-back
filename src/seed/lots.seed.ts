import { Prisma } from '@prisma/client';
import type { AuditEventInput } from '../shared/audit/audit.types';
import { generateBottleUnits, passportUrl } from '../modules/lots/bottle-units';
import {
  computeLabConformity,
  methanolToAnhydrous,
} from '../modules/lots/domain/lab-conformity';
import {
  generateBottleCode,
  generateBottleSalt,
} from '../modules/lots/domain/bottle-code';
import { parseLotRules } from '../modules/lots/domain/lot-rules';
import { toDbDate } from '../modules/lots/domain/dates';
import { DOSSIER_SCHEMA } from '../modules/lots/domain/dossier';
import { loadDossierData, sealLotDossier } from '../modules/lots/lot-dossier';
import { refreshLotStage } from '../modules/lots/lot-records';
import { lockLotRow, nextLotReference } from '../modules/lots/trace-db';
import type {
  FixtureActor,
  FixtureHarvestBatch,
  FixtureLot,
  MockFixtures,
} from './fixtures';

type Tx = Prisma.TransactionClient;

/** Lo que `seedDemo` sabe de las personas ya creadas. */
export interface DemoPeopleContext {
  /** id del miembro en los fixtures → id en la base (winery_members = memberships). */
  memberIds: ReadonlyMap<string, string>;
  /** id del miembro en los fixtures → id de su persona en la base. */
  memberUsers: ReadonlyMap<string, string>;
  /** Quién autoriza los tratamientos de cada bodega. */
  authorizerByWinery: ReadonlyMap<string, string>;
}

export interface SeededLot {
  id: string;
  wineryId: string;
  reference: string;
  name: string;
  stage: string;
  lotCode: string | null;
  bottleCodes: number;
  dossierClosed: boolean;
}

export interface DemoLotsSummary {
  /** Lotes creados en esta ejecución. */
  created: SeededLot[];
  /** Lotes de demostración que ya estaban en la base: no se tocan. */
  existing: number;
  /** Lotes que no se crearon porque chocan con datos que ya existen. */
  skipped: { lotId: string; name: string; reason: string }[];
  /** Pesajes sin lote (uva recibida) creados en esta ejecución. */
  unassignedHarvests: number;
  bottleCodes: number;
  warnings: string[];
}

export interface DemoLotsDeps {
  passportBaseUrl: string;
  people: DemoPeopleContext;
  /** Recibe la entrada de bitácora de cada lote creado (se escribe al final). */
  audit: (entry: AuditEventInput) => void;
}

const date = (iso: string): Date => new Date(iso);
const optionalDate = (iso: string | null): Date | null =>
  iso === null ? null : new Date(iso);
const json = (
  value: object | null,
): Prisma.InputJsonValue | typeof Prisma.DbNull =>
  value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue);
const decimal = (value: number | null): Prisma.Decimal | null =>
  value === null ? null : new Prisma.Decimal(value);

/** Los informes de los mocks 0.3.x eran rutas ficticias (`/mocks/uploads/…`), no claves. */
const storageKey = (key: string | null | undefined): string | null =>
  key && key.startsWith('org/') ? key : null;

function groupBy<T>(rows: readonly T[], key: (row: T) => string | null) {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    if (k === null) continue;
    const list = map.get(k) ?? [];
    list.push(row);
    map.set(k, list);
  }
  return map;
}

/**
 * Lotes de demostración (contrato O2 §2.6, §18): los de los fixtures de los
 * mocks, con sus mismos ids, registros, autores y fechas — un lote en cada
 * etapa (origen, vendimia, fermentación, crianza, destilación, reposo,
 * embotellado, certificado, rechazado y descartado) y el caso «Singani Gran
 * Reserva 2026» con el expediente cerrado.
 *
 * La trazabilidad es de solo inserción, también para la semilla: un lote de
 * demostración que ya existe **no se toca** (ni él ni sus registros), y uno
 * nuevo se crea entero o no se crea (si su código de vendimia o de lote ya
 * está en uso, se salta con un aviso). El lote nace antes que su cadena, como
 * en la API: los tanques, crianzas, destilaciones, embotellados y análisis
 * siempre llevan su lote.
 */
export async function seedDemoLots(
  tx: Tx,
  fx: MockFixtures,
  deps: DemoLotsDeps,
): Promise<DemoLotsSummary> {
  const { memberIds, memberUsers, authorizerByWinery } = deps.people;
  const summary: DemoLotsSummary = {
    created: [],
    existing: 0,
    skipped: [],
    unassignedHarvests: 0,
    bottleCodes: 0,
    warnings: [],
  };
  const member = (id: string | null | undefined): string | null =>
    id ? (memberIds.get(id) ?? null) : null;
  const actor = (a: FixtureActor | null | undefined): string | null =>
    member(a?.membershipId);

  const terroirs = new Map(fx.terroirs.map((t) => [t.id, t]));
  const harvestsByLot = groupBy(fx.harvestBatches, (h) => h.lotId);
  const tanksByLot = groupBy(fx.fermentationTanks, (t) => t.lotId);
  const agingsByLot = groupBy(fx.wineAgings, (a) => a.lotId);
  const productionsByLot = groupBy(fx.productionBatches, (p) => p.lotId);
  const bottlingsByLot = groupBy(fx.bottlingBatches, (b) => b.lotId);
  const labsByLot = groupBy(fx.labAnalyses, (l) => l.lotId);
  const eventsByLot = groupBy(fx.lotEvents, (e) => e.lotId);
  const correctionsByLot = groupBy(fx.corrections, (c) => c.lotId);
  const maturityByHarvest = groupBy(
    fx.maturityAnalyses,
    (m) => m.harvestBatchId,
  );
  const decisionsByHarvest = groupBy(
    fx.phytoDecisions,
    (d) => d.harvestBatchId,
  );
  const logsByTank = groupBy(fx.fermentationLogs, (l) => l.fermentationTankId);
  const treatmentsByTank = groupBy(
    fx.enologicalTreatments,
    (t) => t.fermentationTankId,
  );

  const harvestData = (h: FixtureHarvestBatch) => {
    const terroir = terroirs.get(h.terroirId);
    return {
      id: h.id,
      wineryId: h.wineryId,
      terroirId: h.terroirId,
      harvestBatchCode: h.harvestBatchCode,
      intakeDate: date(h.intakeDate),
      harvestYear: h.harvestYear,
      grossWeightKg: h.grossWeightKg,
      tareWeightKg: h.tareWeightKg,
      netWeightKg: h.netWeightKg,
      brixDegrees: h.brixDegrees,
      initialPh: h.initialPh,
      initialAcidityGl: h.initialAcidityGl,
      temperatureAtIntakeC: h.temperatureAtIntakeC,
      phytosanitaryStatus: h.phytosanitaryStatus,
      phytoInspectionPdfUrl: h.phytoInspectionPdfUrl,
      certifiedByMemberId: member(h.certifiedByMemberId),
      notes: h.notes,
      createdAt: date(h.createdAt),
      lotId: h.lotId,
      terroirSnapshot: (h.terroirSnapshot ??
        (terroir
          ? {
              parcelName: terroir.parcelName,
              altitudeMasl: terroir.altitudeMasl,
              varietyName: terroir.varietyName,
              rawMaterialType: terroir.rawMaterialType,
              takenAt: h.createdAt,
            }
          : Prisma.DbNull)) as Prisma.InputJsonValue,
    };
  };

  /** Pesaje con sus análisis de madurez y sus dictámenes. */
  const createHarvest = async (h: FixtureHarvestBatch): Promise<void> => {
    await tx.harvestBatch.create({ data: harvestData(h) });
    const analyses = maturityByHarvest.get(h.id) ?? [];
    if (analyses.length > 0) {
      await tx.maturityAnalysis.createMany({
        data: analyses.map((m) => ({
          id: m.id,
          harvestBatchId: h.id,
          brixDegrees: m.brixDegrees,
          ph: m.ph,
          acidityGl: m.acidityGl,
          measuredAt: date(m.measuredAt),
          recordedAt: date(m.recordedAt),
          recordedByMembershipId: actor(m.recordedBy),
          notes: m.notes,
          source: m.source,
        })),
      });
    }
    const decisions = decisionsByHarvest.get(h.id) ?? [];
    if (decisions.length > 0) {
      await tx.phytoDecision.createMany({
        data: decisions.map((d) => {
          const key = storageKey(d.inspectionReport?.key);
          return {
            id: d.id,
            harvestBatchId: h.id,
            decision: d.decision,
            decidedAt: date(d.decidedAt),
            recordedAt: date(d.recordedAt),
            decidedByMembershipId: actor(d.decidedBy),
            inspectionReportKey: key,
            inspectionReportSha256: key
              ? (d.inspectionReport?.sha256 ?? null)
              : null,
            notes: d.notes,
            source: d.source,
          };
        }),
      });
    }
  };

  /** Motivo por el que un lote nuevo chocaría con datos que ya existen. */
  const conflictOf = async (lot: FixtureLot): Promise<string | null> => {
    const harvests = harvestsByLot.get(lot.id) ?? [];
    const bottling = (bottlingsByLot.get(lot.id) ?? [])[0];
    if (harvests.length > 0) {
      const taken = await tx.harvestBatch.findFirst({
        where: {
          OR: [
            { id: { in: harvests.map((h) => h.id) } },
            ...harvests.map((h) => ({
              wineryId: h.wineryId,
              harvestBatchCode: h.harvestBatchCode,
            })),
          ],
        },
        select: { harvestBatchCode: true },
      });
      if (taken) {
        return `el pesaje ${taken.harvestBatchCode} ya existe`;
      }
    }
    const lotCode = bottling?.internationalLotCode ?? lot.lotCode;
    if (lotCode) {
      const [byLot, byBottling] = await Promise.all([
        tx.lot.findUnique({ where: { lotCode }, select: { id: true } }),
        tx.bottlingBatch.findUnique({
          where: { internationalLotCode: lotCode },
          select: { id: true },
        }),
      ]);
      if (byLot || byBottling) return `el código de lote ${lotCode} ya existe`;
    }
    return null;
  };

  // ── Uva recibida sin lote (contrato O2 §2.4) ───────────────────────────────
  for (const h of fx.harvestBatches.filter((h) => h.lotId === null)) {
    const taken = await tx.harvestBatch.findFirst({
      where: {
        OR: [
          { id: h.id },
          { wineryId: h.wineryId, harvestBatchCode: h.harvestBatchCode },
        ],
      },
      select: { id: true },
    });
    if (taken) continue;
    await createHarvest(h);
    summary.unassignedHarvests++;
  }

  // ── Lotes ──────────────────────────────────────────────────────────────────
  for (const lot of fx.lots) {
    const found = await tx.lot.findUnique({
      where: { id: lot.id },
      select: { id: true },
    });
    if (found) {
      summary.existing++;
      continue;
    }
    const conflict = await conflictOf(lot);
    if (conflict) {
      summary.skipped.push({ lotId: lot.id, name: lot.name, reason: conflict });
      summary.warnings.push(
        `Lote de demostración "${lot.name}" (${lot.reference}) sin crear: ${conflict}`,
      );
      continue;
    }

    const rules = parseLotRules(lot.rules);
    const harvests = harvestsByLot.get(lot.id) ?? [];
    const tanks = tanksByLot.get(lot.id) ?? [];
    const agings = agingsByLot.get(lot.id) ?? [];
    const productions = productionsByLot.get(lot.id) ?? [];
    const bottling = (bottlingsByLot.get(lot.id) ?? [])[0] ?? null;
    const labs = [...(labsByLot.get(lot.id) ?? [])].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
    const events = [...(eventsByLot.get(lot.id) ?? [])].sort(
      (a, b) => a.seq - b.seq,
    );
    const closing = events.find((e) => e.type === 'DOSSIER_CLOSED') ?? null;
    const discarded = lot.discarded;

    // La referencia de los mocks si está libre; si no, la siguiente de la bodega
    const referenceTaken = await tx.lot.findUnique({
      where: { reference: lot.reference },
      select: { id: true },
    });
    const reference = referenceTaken
      ? await nextLotReference(tx, lot.wineryId, lot.harvestYear)
      : lot.reference;

    await tx.lot.create({
      data: {
        id: lot.id,
        wineryId: lot.wineryId,
        reference,
        lotCode: bottling?.internationalLotCode ?? null,
        name: lot.name,
        productType: lot.productType,
        stage: 'ORIGIN',
        stageChangedAt: date(lot.createdAt),
        harvestYear: lot.harvestYear,
        estimatedBottles: lot.estimatedBottles,
        plannedFormatCl: lot.plannedFormatCl,
        targetAbvPercent: decimal(lot.targetAbvPercent),
        targetReadyDate: lot.targetReadyDate
          ? toDbDate(lot.targetReadyDate)
          : null,
        plannedTerroirIds: lot.plannedTerroirIds,
        // La instantánea de los mocks, tal cual: las reglas del lote no
        // dependen de la configuración que tenga hoy la bodega
        rules: lot.rules as unknown as Prisma.InputJsonObject,
        rulesOrigin: rules.origin,
        notes: lot.notes,
        discardedAt: discarded ? date(discarded.at) : null,
        discardedByMembershipId: discarded ? actor(discarded.by) : null,
        discardReason: discarded?.reason ?? null,
        createdByMembershipId: actor(lot.createdBy),
        createdAt: date(lot.createdAt),
        updatedAt: date(lot.createdAt),
      },
    });
    await lockLotRow(tx, lot.id);

    for (const h of harvests) await createHarvest(h);

    for (const t of tanks) {
      await tx.fermentationTank.create({
        data: {
          id: t.id,
          wineryId: t.wineryId,
          harvestBatchId: t.harvestBatchId,
          tankCode: t.tankCode,
          capacityLiters: t.capacityLiters,
          material: t.material,
          volumeFilledLiters: t.volumeFilledLiters,
          destinationType: t.destinationType,
          status: t.status,
          startDate: date(t.startDate),
          endDate: optionalDate(t.endDate),
          createdAt: date(t.createdAt),
          lotId: lot.id,
          finalVolumeLiters: t.finalVolumeLiters,
          createdByMembershipId: actor(t.transitions?.[0]?.by),
          transitionLog: (t.transitions ?? []).map((tr) => ({
            status: tr.status,
            at: date(tr.at).toISOString(),
            byMembershipId: actor(tr.by),
          })) as Prisma.InputJsonArray,
        },
      });
      await tx.fermentationTankInput.createMany({
        data: t.inputs.map((i) => ({
          fermentationTankId: t.id,
          harvestBatchId: i.harvestBatchId,
          kg: i.kg,
          createdAt: date(t.createdAt),
        })),
      });
      const logs = logsByTank.get(t.id) ?? [];
      if (logs.length > 0) {
        await tx.fermentationLog.createMany({
          data: logs.map((l) => ({
            id: l.id,
            fermentationTankId: t.id,
            temperatureCelsius: l.temperatureCelsius,
            specificGravity: l.specificGravity,
            phValue: l.phValue,
            co2Observations: l.co2Observations,
            recordedAt: date(l.recordedAt),
            recordedByUserId: required(
              memberUsers.get(l.recordedByMemberId),
              `la persona del miembro ${l.recordedByMemberId}`,
            ),
            notes: l.notes,
          })),
          skipDuplicates: true,
        });
      }
      const treatments = treatmentsByTank.get(t.id) ?? [];
      if (treatments.length > 0) {
        const authorizer = required(
          authorizerByWinery.get(t.wineryId),
          `quien autorice los tratamientos de la bodega ${t.wineryId}`,
        );
        await tx.enologicalTreatment.createMany({
          data: treatments.map((r) => ({
            id: r.id,
            fermentationTankId: t.id,
            treatmentType: r.treatmentType,
            additiveName: r.additiveName,
            additiveSupplier: r.additiveSupplier,
            dosageAppliedGPerHl: r.dosageAppliedGPerHl,
            totalAppliedG: r.totalAppliedG,
            regulatoryAuthCode: r.regulatoryAuthCode,
            appliedAt: date(r.appliedAt),
            authorizedByMemberId: authorizer,
            notes: r.notes,
          })),
          skipDuplicates: true,
        });
      }
    }

    for (const a of agings) {
      const isDiscarded = a.agingStatus === 'DISCARDED';
      await tx.wineAgingBatch.create({
        data: {
          id: a.id,
          wineryId: a.wineryId,
          fermentationTankId: a.fermentationTankId,
          containerType: a.containerType,
          containerMaterial: a.containerMaterial,
          containerCode: a.containerCode,
          barrelUseCycle: a.barrelUseCycle,
          containerCount: a.containerCount,
          volumeLiters: a.volumeLiters,
          plannedMonths: a.plannedMonths,
          startDate: a.startDate ? toDbDate(a.startDate) : null,
          lockUntilDate: date(a.lockUntilDate),
          agingStatus: a.agingStatus,
          notes: a.notes,
          createdAt: date(a.createdAt),
          lotId: lot.id,
          discardedAt: isDiscarded && discarded ? date(discarded.at) : null,
          discardReason: isDiscarded ? (discarded?.reason ?? null) : null,
        },
      });
    }

    for (const p of productions) {
      const isDiscarded = p.restStatus === 'DISCARDED';
      await tx.productionBatch.create({
        data: {
          id: p.id,
          wineryId: p.wineryId,
          fermentationTankId: p.fermentationTankId,
          processType: p.processType,
          equipmentIdentifier: p.equipmentIdentifier,
          processStartDate: date(p.processStartDate),
          processEndDate: optionalDate(p.processEndDate),
          inputVolumeLiters: p.inputVolumeLiters,
          outputVolumeLiters: p.outputVolumeLiters,
          wasteVolumeLiters: p.wasteVolumeLiters,
          initialAlcoholPercentage: p.initialAlcoholPercentage,
          isDoEligible: p.isDoEligible,
          mandatoryRestUntil: optionalDate(p.mandatoryRestUntil),
          restStatus: p.restStatus,
          additionalParams: json(p.additionalParams),
          notes: p.notes,
          createdAt: date(p.createdAt),
          lotId: lot.id,
          headsLiters: p.headsLiters,
          heartLiters: p.heartLiters,
          tailsLiters: p.tailsLiters,
          vinasseLiters: p.vinasseLiters,
          heartAbvPercent: p.heartAbvPercent,
          discardedAt: isDiscarded && discarded ? date(discarded.at) : null,
          discardReason: isDiscarded ? (discarded?.reason ?? null) : null,
        },
      });
    }

    let bottleCodes = 0;
    if (bottling) {
      await tx.bottlingBatch.create({
        data: {
          id: bottling.id,
          wineryId: bottling.wineryId,
          wineAgingBatchId: bottling.wineAgingBatchId,
          productionBatchId: bottling.productionBatchId,
          productType: bottling.productType,
          internationalLotCode: bottling.internationalLotCode,
          finalAlcoholAbv: bottling.finalAlcoholAbv,
          waterDilutionLiters: bottling.waterDilutionLiters,
          totalBottlesPackaged: bottling.totalBottlesPackaged,
          packagingFormatCl: bottling.packagingFormatCl,
          bottleType: bottling.bottleType,
          labelDesignUrl: bottling.labelDesignUrl,
          bottlingDate: date(bottling.bottlingDate),
          releasedByMemberId: member(bottling.releasedByMemberId),
          blockchainAnchorTxHash: bottling.blockchainAnchorTxHash,
          blockchainDataHash: bottling.blockchainDataHash,
          isAnchoredOnChain: bottling.isAnchoredOnChain,
          anchoredAt: optionalDate(bottling.anchoredAt),
          qrBatchUrl: passportUrl(
            deps.passportBaseUrl,
            bottling.internationalLotCode,
          ),
          createdAt: date(bottling.createdAt),
          lotId: lot.id,
          availableLiters: decimal(bottling.balance?.availableLiters ?? null),
          leftoverLiters: decimal(bottling.leftover?.liters ?? null),
          leftoverDisposition: bottling.leftover?.disposition ?? null,
          leftoverNotes: bottling.leftover?.notes ?? null,
          createdByMembershipId: member(bottling.releasedByMemberId),
        },
      });
      bottleCodes = await generateBottleUnits(tx, {
        lotId: lot.id,
        bottlingBatchId: bottling.id,
        count: bottling.totalBottlesPackaged,
      });
      // Los códigos nacen con el embotellado (no hoy): el expediente y la
      // prueba Merkle distinguen los que existían al cerrar
      await tx.bottleUnit.updateMany({
        where: { lotId: lot.id },
        data: { createdAt: date(bottling.createdAt) },
      });
      // Códigos anulados uno a uno (etiqueta dañada): con o sin sustituto
      for (const e of events.filter((e) => e.type === 'BOTTLE_CODE_VOIDED')) {
        const serial = Number(e.data.serial);
        const unit = await tx.bottleUnit.findFirst({
          where: { lotId: lot.id, serial, status: 'ACTIVE' },
          select: { id: true, code: true },
        });
        if (!unit) continue;
        const reason =
          typeof e.data.reason === 'string' ? e.data.reason : e.summary;
        await tx.bottleUnit.update({
          where: { id: unit.id },
          data: {
            status: 'VOIDED',
            voidedAt: date(e.occurredAt),
            voidedByMembershipId: actor(e.actor),
            voidReason: reason,
          },
        });
        if (e.data.replaced === true) {
          // El sustituto: un código nuevo con la misma serie (§7.2)
          const replacement = generateBottleCode();
          await tx.bottleUnit.create({
            data: {
              code: replacement,
              serial,
              lotId: lot.id,
              bottlingBatchId: bottling.id,
              salt: generateBottleSalt(),
              replacesCode: unit.code,
              createdAt: date(e.occurredAt),
            },
          });
          await tx.bottleUnit.update({
            where: { id: unit.id },
            data: { replacedByCode: replacement },
          });
        }
      }
      // Lote descartado: todos sus códigos quedan anulados (§2.2)
      if (discarded) {
        await tx.bottleUnit.updateMany({
          where: { lotId: lot.id, status: 'ACTIVE' },
          data: {
            status: 'VOIDED',
            voidedAt: date(discarded.at),
            voidedByMembershipId: actor(discarded.by),
            voidReason: `Lote descartado: ${discarded.reason}`,
          },
        });
      }

      // Laboratorio: la conformidad se calcula aquí con la instantánea del lote
      for (const l of labs) {
        const methanolAa =
          l.methanolMg100mlAa ??
          (l.methanolContentMgL !== null
            ? methanolToAnhydrous(l.methanolContentMgL, l.actualAlcoholAbv)
            : null);
        const conformity = computeLabConformity({
          productType: lot.productType,
          values: {
            actualAlcoholAbv: l.actualAlcoholAbv,
            volatileAcidityAceticGl: l.volatileAcidityAceticGl,
            methanolMg100mlAa: methanolAa,
            copperContentMgL: l.copperContentMgL,
          },
          limits: rules.lab.limits,
          labeledAbv: bottling.finalAlcoholAbv,
          rulesTakenAt: rules.takenAt,
        });
        if (conformity.status !== l.conformityStatus) {
          summary.warnings.push(
            `Análisis ${l.accreditedLabCertificationCode} de "${lot.name}": la conformidad calculada es ${conformity.status} y los fixtures dicen ${l.conformityStatus}`,
          );
        }
        const reportKey = storageKey(l.report?.key);
        await tx.batchLabAnalysis.create({
          data: {
            id: l.id,
            bottlingBatchId: bottling.id,
            certifiedLaboratoryName: l.certifiedLaboratoryName,
            accreditedLabCertificationCode: l.accreditedLabCertificationCode,
            analysisRequestDate: optionalDate(l.analysisRequestDate),
            testPerformedAt: date(l.testPerformedAt),
            actualAlcoholAbv: l.actualAlcoholAbv,
            totalAlcoholAbv: l.totalAlcoholAbv,
            totalAcidityTartaricGl: l.totalAcidityTartaricGl,
            volatileAcidityAceticGl: l.volatileAcidityAceticGl,
            freeSulfurDioxideMgL: l.freeSulfurDioxideMgL,
            totalSulfurDioxideMgL: l.totalSulfurDioxideMgL,
            reducingSugarsGl: l.reducingSugarsGl,
            totalDryExtractGl: l.totalDryExtractGl,
            sugarFreeDryExtractGl: l.sugarFreeDryExtractGl,
            overpressureBar: l.overpressureBar,
            methanolContentMgL: l.methanolContentMgL,
            copperContentMgL: l.copperContentMgL,
            additionalParams: json(l.additionalParams),
            laboratoryReportPdfUrl: l.laboratoryReportPdfUrl,
            laboratoryReportKey: reportKey,
            laboratoryReportSha256: reportKey
              ? (l.report?.sha256 ?? null)
              : null,
            conformsToSenasagStandards: conformity.status === 'CONFORMING',
            conformsToEuStandards: l.conformsToEuStandards,
            conformsToUsaStandards: l.conformsToUsaStandards,
            reviewedByMemberId: member(l.reviewedByMemberId),
            createdAt: date(l.createdAt),
            lotId: lot.id,
            methanolMg100mlAa: decimal(methanolAa),
            conformity: conformity as unknown as Prisma.InputJsonObject,
            conformityStatus: conformity.status,
            supersededAt: optionalDate(l.supersededAt),
            createdByMembershipId:
              actor(l.recordedBy) ?? member(l.reviewedByMemberId),
          },
        });
      }
    }

    const corrections = correctionsByLot.get(lot.id) ?? [];
    if (corrections.length > 0) {
      await tx.traceCorrection.createMany({
        data: corrections.map((c) => ({
          id: c.id,
          lotId: lot.id,
          wineryId: lot.wineryId,
          targetType: c.target.type,
          targetId: c.target.id,
          kind: c.kind,
          changes: c.changes as unknown as Prisma.InputJsonArray,
          reason: c.reason,
          createdAt: date(c.createdAt),
          createdByMembershipId: actor(c.createdBy),
        })),
      });
    }

    // Línea de tiempo de los mocks, con `seq` consecutivo. Fuera quedan los
    // archivos adjuntos (la semilla no sube archivos) y el cierre del
    // expediente, que se escribe abajo con la huella real
    const timeline = events.filter(
      (e) => e.type !== 'FILE_ATTACHED' && e.type !== 'DOSSIER_CLOSED',
    );
    if (timeline.length > 0) {
      await tx.lotEvent.createMany({
        data: timeline.map((e, index) => ({
          id: e.id,
          lotId: lot.id,
          seq: index + 1,
          type: e.type,
          occurredAt: date(e.occurredAt),
          recordedAt: date(e.recordedAt),
          stage: e.stage,
          actorMembershipId: actor(e.actor),
          summary: e.summary,
          data: e.data as Prisma.InputJsonObject,
          resourceType: e.resource.type,
          resourceId: e.resource.id,
          visibility: e.visibility,
          corrected: e.corrected,
        })),
      });
    }

    // Expediente cerrado: la huella se calcula con los registros recién
    // sembrados (los códigos de botella son aleatorios: no es la de los mocks)
    let dossierClosed = false;
    if (lot.dossierStatus === 'CLOSED' && closing) {
      const data = await loadDossierData(tx, lot.id, lot.wineryId);
      if (!data?.ready || !data.bottleCodes) {
        const missing = (data?.requirements ?? [])
          .filter((r) => !r.met)
          .map((r) => r.key)
          .join(', ');
        summary.warnings.push(
          `Expediente de "${lot.name}" sin cerrar: faltan requisitos (${missing || 'lote sin datos'})`,
        );
      } else {
        const closedAt = date(closing.occurredAt);
        const closedByMembershipId = actor(closing.actor);
        const sealed = await sealLotDossier(tx, data, {
          closedAt,
          closedByMembershipId,
        });
        await tx.lotDossier.create({
          data: {
            lotId: lot.id,
            schema: DOSSIER_SCHEMA,
            status: 'CLOSED',
            hash: sealed.hash,
            canonical: sealed.canonical,
            bottleCount: data.bottleCodes.count,
            bottleMerkleRoot: data.bottleCodes.merkleRoot,
            closedAt,
            closedByMembershipId,
          },
        });
        await tx.lotEvent.create({
          data: {
            id: closing.id,
            lotId: lot.id,
            seq: timeline.length + 1,
            type: 'DOSSIER_CLOSED',
            occurredAt: closedAt,
            recordedAt: date(closing.recordedAt),
            stage: 'CERTIFIED',
            actorMembershipId: closedByMembershipId,
            summary: `Expediente cerrado con la huella ${sealed.hash.slice(0, 12)}… (${data.bottleCodes.count.toLocaleString('es-BO')} códigos de botella)`,
            data: {
              schema: DOSSIER_SCHEMA,
              algorithm: 'sha256/jcs-rfc8785',
              hash: sealed.hash,
              bottleCount: data.bottleCodes.count,
              bottleMerkleRoot: data.bottleCodes.merkleRoot,
            },
            resourceType: 'lot_dossier',
            resourceId: lot.id,
            visibility: 'PUBLIC',
          },
        });
        dossierClosed = true;
      }
    }

    // La etapa la calcula el servidor a partir de los registros (§2.2)
    const stage = await refreshLotStage(tx, lot.id, date(lot.stageChangedAt));
    await tx.lot.update({
      where: { id: lot.id },
      data: {
        stageChangedAt: date(lot.stageChangedAt),
        updatedAt: date(lot.updatedAt),
      },
    });
    if (stage !== lot.stage) {
      summary.warnings.push(
        `Lote "${lot.name}" (${reference}): la etapa calculada es ${stage} y los fixtures dicen ${lot.stage}`,
      );
    }

    summary.created.push({
      id: lot.id,
      wineryId: lot.wineryId,
      reference,
      name: lot.name,
      stage,
      lotCode: bottling?.internationalLotCode ?? null,
      bottleCodes,
      dossierClosed,
    });
    summary.bottleCodes += bottleCodes;
    deps.audit({
      action: 'LOT_MIGRATED',
      resource: { type: 'lot', id: lot.id },
      organizationId: lot.wineryId,
      actor: null,
      after: {
        reference,
        name: lot.name,
        stage,
        productType: lot.productType,
        lotCode: bottling?.internationalLotCode ?? null,
        rulesOrigin: rules.origin,
        bottleCodes,
        dossierClosed,
      },
      reason: `Semilla de demostración (${fx.source.package} ${fx.source.git ?? fx.source.version})`,
    });
  }
  return summary;
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`Semilla: falta ${what} en los fixtures`);
  }
  return value;
}
