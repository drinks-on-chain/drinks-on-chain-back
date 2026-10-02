import { Prisma } from '@prisma/client';
import { ErrorCode } from '@shared/exceptions/error-codes';
import {
  currentLabAnalysisId,
  DossierLabStatus,
  DossierReadinessInput,
  DossierRequirement,
  dossierRequirements,
  DossierSource,
  sealDossier,
} from './domain/dossier';
import {
  bottleLeafHash,
  merkleProof,
  merkleRoot,
  MerkleStep,
} from './domain/merkle';
import { distillationHeart, num } from './domain/sources';
import { stateError, violation } from './domain/trace-errors';
import type { DbClient, DbClock } from './trace-db';

/** Todo lo que entra en el expediente de un lote (contrato O2 §10). */
const DOSSIER_INCLUDE = {
  winery: { select: { id: true, lotPrefix: true, commercialName: true } },
  harvestBatches: {
    include: {
      terroir: {
        select: {
          id: true,
          parcelName: true,
          altitudeMasl: true,
          varietyName: true,
          rawMaterialType: true,
        },
      },
      maturityAnalyses: true,
      phytoDecisions: true,
    },
  },
  fermentationTanks: {
    include: { inputs: true, logs: true, treatments: true },
  },
  wineAgingBatches: { include: { bottlingBatches: { select: { id: true } } } },
  productionBatches: { include: { bottlingBatches: { select: { id: true } } } },
  bottlingBatch: { include: { labAnalyses: true } },
  labAnalyses: true,
  corrections: true,
  attachments: true,
  dossier: true,
  complianceIssues: { where: { resolvedAt: null }, select: { id: true } },
} satisfies Prisma.LotInclude;

type LotWithDossier = Prisma.LotGetPayload<{ include: typeof DOSSIER_INCLUDE }>;

export interface DossierData {
  lot: LotWithDossier;
  /** Análisis del lote (por `lot_id` o por su embotellado), sin repetir. */
  labAnalyses: LotWithDossier['labAnalyses'];
  labStatus: DossierLabStatus;
  /** Códigos activos, por serie: las hojas de la raíz Merkle. */
  bottleCodes: { count: number; merkleRoot: string } | null;
  readiness: DossierReadinessInput;
  requirements: DossierRequirement[];
  ready: boolean;
  openIssueIds: string[];
  openSourceIds: string[];
  /** Membresías que aparecen en el expediente. */
  membershipIds: string[];
}

function isOpenSource(source: {
  status: string;
  discardedAt: Date | null;
  bottlingBatches: { id: string }[];
}): boolean {
  return (
    source.status !== 'BOTTLED' &&
    source.status !== 'DISCARDED' &&
    source.discardedAt === null &&
    source.bottlingBatches.length === 0
  );
}

/**
 * Carga el lote con todos los registros del expediente y evalúa los
 * requisitos del cierre. `null` si el lote no existe (o no es de la bodega).
 */
export async function loadDossierData(
  client: DbClient,
  lotId: string,
  wineryId?: string,
): Promise<DossierData | null> {
  const lot = await client.lot.findFirst({
    where: { id: lotId, ...(wineryId && { wineryId }) },
    include: DOSSIER_INCLUDE,
  });
  if (!lot) return null;

  const seen = new Set<string>();
  const labAnalyses = [
    ...lot.labAnalyses,
    ...(lot.bottlingBatch?.labAnalyses ?? []),
  ].filter((l) => (seen.has(l.id) ? false : (seen.add(l.id), true)));
  const currentId = currentLabAnalysisId(
    labAnalyses,
    lot.corrections.map((c) => ({
      kind: c.kind,
      targetType: c.targetType,
      targetId: c.targetId,
    })),
  );
  const current = labAnalyses.find((l) => l.id === currentId);
  const labStatus: DossierLabStatus =
    current?.conformityStatus === 'CONFORMING' ||
    current?.conformityStatus === 'NON_CONFORMING' ||
    current?.conformityStatus === 'INCOMPLETE'
      ? current.conformityStatus
      : current
        ? 'INCOMPLETE'
        : 'NOT_RECORDED';

  let bottleCodes: DossierData['bottleCodes'] = null;
  let activeCodes = 0;
  let serialsWithCode = 0;
  let duplicatedActiveSerials = 0;
  if (lot.bottlingBatch) {
    const units = await client.bottleUnit.findMany({
      where: { lotId: lot.id },
      select: { serial: true, code: true, salt: true, status: true },
    });
    const active = units
      .filter((u) => u.status === 'ACTIVE')
      .sort((a, b) =>
        a.serial !== b.serial ? a.serial - b.serial : a.code < b.code ? -1 : 1,
      );
    activeCodes = active.length;
    serialsWithCode = new Set(units.map((u) => u.serial)).size;
    duplicatedActiveSerials =
      active.length - new Set(active.map((u) => u.serial)).size;
    bottleCodes = {
      count: active.length,
      merkleRoot: merkleRoot(
        active.map((u) => bottleLeafHash(u.serial, u.code, u.salt)),
      ),
    };
  }

  const openSourceIds = [
    ...lot.wineAgingBatches
      .filter((a) => isOpenSource({ ...a, status: a.agingStatus }))
      .map((a) => a.id),
    ...lot.productionBatches
      .filter((p) => isOpenSource({ ...p, status: p.restStatus }))
      .map((p) => p.id),
  ];
  const openIssueIds = lot.complianceIssues.map((i) => i.id);
  const readiness: DossierReadinessInput = {
    bottles: lot.bottlingBatch?.totalBottlesPackaged ?? null,
    labStatus,
    activeCodes,
    serialsWithCode,
    duplicatedActiveSerials,
    openComplianceIssues: openIssueIds.length,
    openSources: openSourceIds.length,
  };
  const requirements = dossierRequirements(readiness);

  const membershipIds = [
    lot.createdByMembershipId,
    ...lot.harvestBatches.flatMap((h) => [
      h.createdByMembershipId,
      ...h.maturityAnalyses.map((m) => m.recordedByMembershipId),
      ...h.phytoDecisions.map((d) => d.decidedByMembershipId),
    ]),
    ...lot.fermentationTanks.map((t) => t.createdByMembershipId),
    ...lot.wineAgingBatches.map((a) => a.createdByMembershipId),
    ...lot.productionBatches.map((p) => p.createdByMembershipId),
    lot.bottlingBatch?.createdByMembershipId,
    ...labAnalyses.map((l) => l.createdByMembershipId),
    ...lot.corrections.map((c) => c.createdByMembershipId),
    lot.dossier?.closedByMembershipId,
  ].filter((id): id is string => !!id);

  return {
    lot,
    labAnalyses,
    labStatus,
    bottleCodes,
    readiness,
    requirements,
    ready: requirements.every((r) => r.met),
    openIssueIds,
    openSourceIds,
    membershipIds: [...new Set(membershipIds)],
  };
}

/**
 * Fuente del contenido canónico a partir de los registros cargados.
 * `closedAt`/`closedByMembershipId` son `null` en la vista previa.
 */
export function toDossierSource(
  data: DossierData,
  roles: ReadonlyMap<string, string>,
  closing: { closedAt: Date | null; closedByMembershipId: string | null },
): DossierSource {
  const { lot } = data;
  const b = lot.bottlingBatch;
  let bottling: DossierSource['bottling'] = null;
  if (b) {
    // Fuentes que entraron al embotellado: las que quedaron `BOTTLED`
    const agings = lot.wineAgingBatches.filter(
      (a) => a.agingStatus === 'BOTTLED' || a.id === b.wineAgingBatchId,
    );
    const distillations = lot.productionBatches.filter(
      (p) => p.restStatus === 'BOTTLED' || p.id === b.productionBatchId,
    );
    const liters = [
      ...agings.map((a) => num(a.volumeLiters)),
      ...distillations.map((p) => distillationHeart(p).liters),
    ];
    const summed =
      liters.length > 0 && liters.every((l) => l !== null)
        ? (liters as number[]).reduce((sum, l) => sum + l, 0)
        : null;
    const hearts = distillations.map((p) => distillationHeart(p));
    const pure =
      hearts.length > 0 &&
      agings.length === 0 &&
      hearts.every((h) => h.liters !== null && h.abv !== null)
        ? hearts.reduce(
            (sum, h) => sum + ((h.liters as number) * (h.abv as number)) / 100,
            0,
          )
        : null;
    bottling = {
      ...b,
      availableLiters: num(b.availableLiters) ?? summed,
      pureAlcoholAvailableLiters: pure,
    };
  }
  return {
    winery: lot.winery,
    lot: {
      id: lot.id,
      reference: lot.reference,
      lotCode: lot.lotCode,
      name: lot.name,
      productType: lot.productType,
      harvestYear: lot.harvestYear,
      createdAt: lot.createdAt,
      createdByMembershipId: lot.createdByMembershipId,
      rules: lot.rules,
    },
    harvests: lot.harvestBatches,
    tanks: lot.fermentationTanks,
    agings: lot.wineAgingBatches,
    distillations: lot.productionBatches,
    bottling,
    labAnalyses: data.labAnalyses,
    corrections: lot.corrections,
    attachments: lot.attachments,
    bottleCodes: data.bottleCodes,
    roles,
    closedAt: closing.closedAt,
    closedByMembershipId: closing.closedByMembershipId,
  };
}

/** Rol de cada membresía (el expediente lleva `{ membershipId, role }`). */
export async function membershipRoles(
  client: DbClient,
  membershipIds: readonly string[],
): Promise<Map<string, string>> {
  const roles = new Map<string, string>();
  if (membershipIds.length === 0) return roles;
  const rows = await client.membership.findMany({
    where: { id: { in: [...membershipIds] } },
    select: { id: true, role: true },
  });
  for (const row of rows) roles.set(row.id, row.role);
  return roles;
}

/** Contenido canónico y huella del expediente con los registros actuales. */
export async function sealLotDossier(
  client: DbClient,
  data: DossierData,
  closing: { closedAt: Date | null; closedByMembershipId: string | null },
): Promise<{ canonical: string; hash: string }> {
  const roles = await membershipRoles(client, [
    ...data.membershipIds,
    ...(closing.closedByMembershipId ? [closing.closedByMembershipId] : []),
  ]);
  return sealDossier(toDossierSource(data, roles, closing));
}

/**
 * Reloj de la base **en este instante** (`clock_timestamp()`), para leerlo
 * con la fila del lote ya bloqueada. `now()` es el inicio de la transacción,
 * que puede ser anterior al de otra que tomó antes el bloqueo; con este
 * reloj, el orden de las fechas del cierre del expediente y de las
 * anulaciones de códigos coincide con el orden real en que ocurrieron (las
 * dos operaciones bloquean el lote).
 */
export async function lockedClock(
  tx: Prisma.TransactionClient,
): Promise<DbClock> {
  const rows = await tx.$queryRaw<{ now: Date; today: string }[]>`
    SELECT clock_timestamp() AS now,
           to_char(clock_timestamp() AT TIME ZONE 'America/La_Paz', 'YYYY-MM-DD') AS today`;
  return { now: new Date(rows[0].now), today: rows[0].today };
}

export interface ClosedDossierLeaves {
  /** Códigos que formaron la raíz, por serie (el orden de las hojas). */
  units: { serial: number; code: string; salt: string }[];
  leaves: string[];
  merkleRoot: string;
}

/**
 * Hojas de la raíz Merkle de un expediente **cerrado**: los códigos que
 * estaban activos al cerrar (los activos hoy más los anulados después del
 * cierre; tras el cierre no se emiten códigos nuevos, S-14), por serie.
 * Comprueba que reproducen la raíz guardada: si no, `null` (nunca devuelve
 * hojas que no lleven a la raíz del expediente).
 */
export async function closedDossierLeaves(
  client: DbClient,
  lotId: string,
): Promise<ClosedDossierLeaves | null> {
  const dossier = await client.lotDossier.findUnique({
    where: { lotId },
    select: { status: true, closedAt: true, bottleMerkleRoot: true },
  });
  if (
    dossier?.status !== 'CLOSED' ||
    !dossier.closedAt ||
    !dossier.bottleMerkleRoot
  ) {
    return null;
  }
  const units = await client.bottleUnit.findMany({
    where: {
      lotId,
      createdAt: { lte: dossier.closedAt },
      OR: [{ status: 'ACTIVE' }, { voidedAt: { gt: dossier.closedAt } }],
    },
    select: { serial: true, code: true, salt: true },
  });
  units.sort((a, b) =>
    a.serial !== b.serial ? a.serial - b.serial : a.code < b.code ? -1 : 1,
  );
  const leaves = units.map((u) => bottleLeafHash(u.serial, u.code, u.salt));
  if (merkleRoot(leaves) !== dossier.bottleMerkleRoot) return null;
  return { units, leaves, merkleRoot: dossier.bottleMerkleRoot };
}

/**
 * Prueba Merkle de un código de botella contra la raíz de su expediente
 * (`PublicBottlePassport.bottle.merkleProof`, contrato O2 §12.2): la sal de
 * la hoja y el camino hasta la raíz. `null` si el expediente no está cerrado
 * o el código no formó parte de la raíz (anulado antes del cierre).
 *
 * Verificación: `hoja = SHA-256("{serie}:{código}:{sal}")` y
 * `verifyMerkleProof(hoja, path, raíz)` (`domain/merkle.ts`).
 */
export async function bottleMerkleProof(
  client: DbClient,
  lotId: string,
  code: string,
): Promise<{ salt: string; path: MerkleStep[]; merkleRoot: string } | null> {
  const closed = await closedDossierLeaves(client, lotId);
  if (!closed) return null;
  const index = closed.units.findIndex((u) => u.code === code);
  if (index < 0) return null;
  return {
    salt: closed.units[index].salt,
    path: merkleProof(closed.leaves, index),
    merkleRoot: closed.merkleRoot,
  };
}

/**
 * 409 `TRC_DOSSIER_CLOSED` si el expediente del lote ya está cerrado
 * (contrato O2 §13: escritura tras el cierre, con `meta.closedAt`). Para las
 * escrituras del lote que el contrato marca con este código (laboratorio,
 * correcciones, sustitución de códigos): llámala antes de `lockLot(…,
 * { writable: true })`, que respondería `TRC_LOT_TERMINAL`.
 */
export async function assertDossierOpen(
  client: DbClient,
  lotId: string,
): Promise<void> {
  const dossier = await client.lotDossier.findUnique({
    where: { lotId },
    select: { status: true, closedAt: true, hash: true },
  });
  if (dossier?.status !== 'CLOSED') return;
  throw stateError(
    ErrorCode.TRC_DOSSIER_CLOSED,
    'El expediente del lote está cerrado: ya no admite registros',
    [
      violation(ErrorCode.TRC_DOSSIER_CLOSED, 'Expediente cerrado', {
        meta: {
          closedAt: dossier.closedAt?.toISOString() ?? null,
          hash: dossier.hash,
        },
      }),
    ],
  );
}
