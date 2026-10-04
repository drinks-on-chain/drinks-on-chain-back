import type { PrismaClient } from '@prisma/client';

type Db = Pick<
  PrismaClient,
  | 'bottleCodeExport'
  | 'bottleUnit'
  | 'lotEvent'
  | 'lotComplianceIssue'
  | 'lotAttachment'
  | 'lotDossier'
  | 'traceCorrection'
  | 'batchLabAnalysis'
  | 'bottlingBatch'
  | 'phytoDecision'
  | 'maturityAnalysis'
  | 'fermentationTankInput'
  | 'fermentationLog'
  | 'enologicalTreatment'
  | 'wineAgingBatch'
  | 'productionBatch'
  | 'fermentationTank'
  | 'harvestBatch'
  | 'lot'
  | 'lotSequence'
  | 'lotBackfillPending'
  | 'terroir'
>;

/**
 * Borra la trazabilidad de unas bodegas de prueba en el orden que exigen las
 * claves foráneas `Restrict` de la Ola 2 (lote, eventos, códigos…). Solo para
 * limpiar las suites e2e: la API no borra trazabilidad (append-only).
 */
export async function deleteTraceabilityData(
  prisma: Db,
  wineryIds: string[],
): Promise<void> {
  const ids = wineryIds.filter(Boolean);
  if (ids.length === 0) return;
  const lot = { lot: { wineryId: { in: ids } } };
  await prisma.bottleCodeExport.deleteMany({ where: lot });
  await prisma.bottleUnit.deleteMany({ where: lot });
  await prisma.lotEvent.deleteMany({ where: lot });
  await prisma.lotComplianceIssue.deleteMany({ where: lot });
  await prisma.lotAttachment.deleteMany({ where: lot });
  await prisma.lotDossier.deleteMany({ where: lot });
  await prisma.traceCorrection.deleteMany({ where: { wineryId: { in: ids } } });
  await prisma.batchLabAnalysis.deleteMany({
    where: { bottlingBatch: { wineryId: { in: ids } } },
  });
  await prisma.bottlingBatch.deleteMany({ where: { wineryId: { in: ids } } });
  const harvest = { harvestBatch: { wineryId: { in: ids } } };
  await prisma.phytoDecision.deleteMany({ where: harvest });
  await prisma.maturityAnalysis.deleteMany({ where: harvest });
  await prisma.fermentationTankInput.deleteMany({ where: harvest });
  const tank = { fermentationTank: { wineryId: { in: ids } } };
  await prisma.fermentationLog.deleteMany({ where: tank });
  await prisma.enologicalTreatment.deleteMany({ where: tank });
  await prisma.wineAgingBatch.deleteMany({ where: { wineryId: { in: ids } } });
  await prisma.productionBatch.deleteMany({ where: { wineryId: { in: ids } } });
  await prisma.fermentationTank.deleteMany({
    where: { wineryId: { in: ids } },
  });
  const harvests = await prisma.harvestBatch.findMany({
    where: { wineryId: { in: ids } },
    select: { id: true },
  });
  await prisma.lotBackfillPending.deleteMany({
    where: { harvestBatchId: { in: harvests.map((h) => h.id) } },
  });
  await prisma.harvestBatch.deleteMany({ where: { wineryId: { in: ids } } });
  await prisma.lot.deleteMany({ where: { wineryId: { in: ids } } });
  await prisma.lotSequence.deleteMany({ where: { wineryId: { in: ids } } });
  await prisma.terroir.deleteMany({ where: { wineryId: { in: ids } } });
}
