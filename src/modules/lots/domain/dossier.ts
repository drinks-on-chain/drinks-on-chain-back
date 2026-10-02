import { createHash } from 'node:crypto';
import { computeBottlingBalance } from './bottling-balance';
import { dateOnly, laPazDate } from './dates';
import { canonicalBytes } from './jcs';
import { agingLock, restLock } from './locks';
import { parseLotRules } from './lot-rules';
import { BOTTLE_MERKLE_ALGORITHM } from './merkle';

/**
 * Expediente del lote (contrato O2 §10, ERP-19): requisitos del cierre y
 * contenido canónico `doc-dossier/1`, cuyo SHA-256 (sobre los bytes UTF-8 del
 * JSON canónico RFC 8785) es la huella del lote que la Ola 3 ancla en la red.
 *
 * Reglas del contenido canónico:
 * - Las medidas (columnas decimales: kilos, litros, grados, pH…) van como
 *   **cadenas de escala fija**, con la escala de su columna (`"18400.000"`).
 * - Los documentos guardados como JSON (instantánea de reglas, conformidad
 *   del laboratorio, valores de las correcciones) van **tal cual se
 *   guardaron**; sus números se serializan como manda JCS.
 * - Instantes en ISO 8601 UTC con milisegundos; fechas de calendario
 *   `YYYY-MM-DD`.
 * - Listas ordenadas por fecha e id (comparación binaria, no la de la base).
 * - Personas como `{ membershipId, role }`: sin nombres ni correos. Tampoco
 *   van los textos libres (notas, motivos) ni las URL o claves de archivos:
 *   el expediente es público.
 * - Los códigos de botella no van en claro: va su raíz Merkle (`merkle.ts`).
 */
export const DOSSIER_SCHEMA = 'doc-dossier/1';
export const DOSSIER_HASH_ALGORITHM = 'sha256/jcs-rfc8785';

// ── Requisitos del cierre ──────────────────────────────────────────────────

export type DossierRequirementKey =
  | 'BOTTLED'
  | 'LAB_CONFORMING'
  | 'BOTTLE_CODES_READY'
  | 'NO_OPEN_COMPLIANCE_ISSUES'
  | 'NO_OPEN_SOURCES';

export interface DossierRequirement {
  key: DossierRequirementKey;
  met: boolean;
  message: string;
}

export type DossierLabStatus =
  'NOT_RECORDED' | 'CONFORMING' | 'NON_CONFORMING' | 'INCOMPLETE';

export interface DossierReadinessInput {
  /** Botellas del embotellado; `null` si el lote no está embotellado. */
  bottles: number | null;
  labStatus: DossierLabStatus;
  /** Códigos de botella activos. */
  activeCodes: number;
  /** Series (1…N) con algún código, activo o anulado. */
  serialsWithCode: number;
  /** Series con más de un código activo (nunca debería ocurrir). */
  duplicatedActiveSerials: number;
  openComplianceIssues: number;
  /** Crianzas y destilaciones abiertas (ni embotelladas ni descartadas). */
  openSources: number;
}

const LAB_MESSAGES: Record<DossierLabStatus, string> = {
  CONFORMING: 'El análisis de laboratorio vigente es conforme',
  NOT_RECORDED: 'Falta el análisis de laboratorio del lote',
  INCOMPLETE:
    'El análisis de laboratorio vigente está incompleto: faltan parámetros exigidos',
  NON_CONFORMING: 'El análisis de laboratorio vigente no es conforme',
};

/** Los cinco requisitos del cierre (§10), en el orden del contrato. */
export function dossierRequirements(
  input: DossierReadinessInput,
): DossierRequirement[] {
  const bottled = input.bottles !== null;
  const codesReady =
    bottled &&
    input.activeCodes > 0 &&
    input.duplicatedActiveSerials === 0 &&
    input.serialsWithCode === input.bottles;
  let codesMessage: string;
  if (!bottled) {
    codesMessage = 'Los códigos de botella se generan al embotellar';
  } else if (codesReady) {
    codesMessage = `${input.activeCodes} códigos de botella activos`;
  } else if (input.activeCodes === 0) {
    codesMessage = 'El lote no tiene ningún código de botella activo';
  } else if (input.duplicatedActiveSerials > 0) {
    codesMessage = `${input.duplicatedActiveSerials} series tienen más de un código activo`;
  } else {
    codesMessage = `Hay códigos para ${input.serialsWithCode} de las ${input.bottles} botellas`;
  }
  return [
    {
      key: 'BOTTLED',
      met: bottled,
      message: bottled
        ? 'El lote está embotellado'
        : 'El lote aún no está embotellado',
    },
    {
      key: 'LAB_CONFORMING',
      met: input.labStatus === 'CONFORMING',
      message: LAB_MESSAGES[input.labStatus],
    },
    { key: 'BOTTLE_CODES_READY', met: codesReady, message: codesMessage },
    {
      key: 'NO_OPEN_COMPLIANCE_ISSUES',
      met: input.openComplianceIssues === 0,
      message:
        input.openComplianceIssues === 0
          ? 'Sin incidencias de cumplimiento abiertas'
          : `${input.openComplianceIssues} incidencias de cumplimiento abiertas: corrígelas o descarta el lote`,
    },
    {
      key: 'NO_OPEN_SOURCES',
      met: input.openSources === 0,
      message:
        input.openSources === 0
          ? 'Sin crianzas ni destilaciones abiertas'
          : `${input.openSources} crianzas o destilaciones abiertas: descártalas antes de cerrar`,
    },
  ];
}

// ── Contenido canónico ─────────────────────────────────────────────────────

/** Decimal de Prisma, número o ausente. */
type Dec = { toFixed(scale: number): string } | number | null | undefined;

/** Decimal como cadena de escala fija (`"18400.000"`), o `null`. */
export function fixed(value: Dec, scale: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    // Evita `-0.000`
    const text = value.toFixed(scale);
    return Number(text) === 0 ? (0).toFixed(scale) : text;
  }
  return value.toFixed(scale);
}

function toNumber(value: Dec): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' ? value : Number(value.toFixed(6));
}

const instant = (value: Date | null | undefined): string | null =>
  value ? value.toISOString() : null;
const day = (value: Date | null | undefined): string | null =>
  value ? dateOnly(value) : null;

export interface DossierHarvest {
  id: string;
  harvestBatchCode: string;
  intakeDate: Date;
  harvestYear: number;
  grossWeightKg: Dec;
  tareWeightKg: Dec;
  netWeightKg: Dec;
  temperatureAtIntakeC: Dec;
  phytosanitaryStatus: string;
  createdAt: Date;
  createdByMembershipId: string | null;
  /** `{ parcelName, altitudeMasl, varietyName, rawMaterialType, takenAt }` al pesar. */
  terroirSnapshot: unknown;
  terroir: {
    id: string;
    parcelName: string;
    altitudeMasl: Dec;
    varietyName: string;
    rawMaterialType: string;
  };
  maturityAnalyses: {
    id: string;
    brixDegrees: Dec;
    ph: Dec;
    acidityGl: Dec;
    measuredAt: Date;
    recordedAt: Date;
    recordedByMembershipId: string | null;
    source: string;
    voidedAt: Date | null;
  }[];
  phytoDecisions: {
    id: string;
    decision: string;
    decidedAt: Date;
    recordedAt: Date;
    decidedByMembershipId: string | null;
    inspectionReportSha256: string | null;
    source: string;
    voidedAt: Date | null;
  }[];
}

export interface DossierTank {
  id: string;
  tankCode: string;
  material: string | null;
  capacityLiters: Dec;
  volumeFilledLiters: Dec;
  finalVolumeLiters: Dec;
  destinationType: string | null;
  status: string;
  startDate: Date;
  endDate: Date | null;
  createdAt: Date;
  createdByMembershipId: string | null;
  inputs: { harvestBatchId: string; kg: Dec }[];
  logs: {
    id: string;
    recordedAt: Date;
    temperatureCelsius: Dec;
    specificGravity: Dec;
    phValue: Dec;
    voidedAt: Date | null;
  }[];
  treatments: {
    id: string;
    treatmentType: string;
    additiveName: string;
    dosageAppliedGPerHl: Dec;
    totalAppliedG: Dec;
    regulatoryAuthCode: string;
    appliedAt: Date;
    voidedAt: Date | null;
  }[];
}

export interface DossierAging {
  id: string;
  fermentationTankId: string;
  containerType: string;
  containerMaterial: string | null;
  containerCount: number | null;
  barrelUseCycle: number | null;
  volumeLiters: Dec;
  plannedMonths: number;
  startDate: Date | null;
  lockUntilDate: Date;
  agingStatus: string;
  discardedAt: Date | null;
  createdAt: Date;
  createdByMembershipId: string | null;
}

export interface DossierDistillation {
  id: string;
  fermentationTankId: string;
  processType: string;
  equipmentIdentifier: string;
  processStartDate: Date;
  processEndDate: Date | null;
  inputVolumeLiters: Dec;
  outputVolumeLiters: Dec;
  headsLiters: Dec;
  heartLiters: Dec;
  tailsLiters: Dec;
  vinasseLiters: Dec;
  heartAbvPercent: Dec;
  initialAlcoholPercentage: Dec;
  mandatoryRestUntil: Date | null;
  restStatus: string;
  discardedAt: Date | null;
  createdAt: Date;
  createdByMembershipId: string | null;
}

export interface DossierBottling {
  id: string;
  internationalLotCode: string;
  productType: string;
  bottlingDate: Date;
  packagingFormatCl: number;
  totalBottlesPackaged: number;
  finalAlcoholAbv: Dec;
  waterDilutionLiters: Dec;
  leftoverLiters: Dec;
  leftoverDisposition: string | null;
  bottleType: string | null;
  createdAt: Date;
  createdByMembershipId: string | null;
  /** Σ litros de las fuentes embotelladas; `null` si falta algún volumen. */
  availableLiters: number | null;
  /** Singani: alcohol puro del corazón de las fuentes (L); `null` si falta. */
  pureAlcoholAvailableLiters: number | null;
}

export interface DossierLabAnalysis {
  id: string;
  certifiedLaboratoryName: string;
  accreditedLabCertificationCode: string;
  analysisRequestDate: Date | null;
  testPerformedAt: Date;
  actualAlcoholAbv: Dec;
  totalAlcoholAbv: Dec;
  totalAcidityTartaricGl: Dec;
  volatileAcidityAceticGl: Dec;
  freeSulfurDioxideMgL: Dec;
  totalSulfurDioxideMgL: Dec;
  reducingSugarsGl: Dec;
  totalDryExtractGl: Dec;
  sugarFreeDryExtractGl: Dec;
  overpressureBar: Dec;
  methanolContentMgL: Dec;
  methanolMg100mlAa: Dec;
  copperContentMgL: Dec;
  conformity: unknown;
  conformityStatus: string | null;
  supersededAt: Date | null;
  voidedAt: Date | null;
  createdAt: Date;
  createdByMembershipId: string | null;
}

export interface DossierCorrection {
  id: string;
  targetType: string;
  targetId: string;
  kind: string;
  changes: unknown;
  createdAt: Date;
  createdByMembershipId: string | null;
}

export interface DossierSource {
  winery: { id: string; lotPrefix: string | null; commercialName: string };
  lot: {
    id: string;
    reference: string;
    lotCode: string | null;
    name: string;
    productType: string | null;
    harvestYear: number;
    createdAt: Date;
    createdByMembershipId: string | null;
    /** Instantánea de reglas tal como se guardó (`lots.rules`). */
    rules: unknown;
  };
  harvests: DossierHarvest[];
  tanks: DossierTank[];
  agings: DossierAging[];
  distillations: DossierDistillation[];
  bottling: DossierBottling | null;
  labAnalyses: DossierLabAnalysis[];
  corrections: DossierCorrection[];
  attachments: {
    kind: string;
    sha256: string | null;
    createdAt: Date;
    id: string;
  }[];
  bottleCodes: { count: number; merkleRoot: string } | null;
  /** Rol de cada membresía que aparece en el expediente. */
  roles: ReadonlyMap<string, string>;
  /** `null` en la vista previa (expediente abierto). */
  closedAt: Date | null;
  closedByMembershipId: string | null;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Copia de un documento JSON guardado, sin `undefined` ni tipos raros. */
function plainJson(value: unknown): Json {
  if (value === null || value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as Json;
}

/** Campos de texto libre que no van en el expediente público. */
const FREE_TEXT_FIELD = /(^|\.)(notes|reason|discardReason|voidReason)$/i;

/** Orden estable: por `key` (fecha ISO o texto) y después por id. */
function byKeyThenId<T extends { id: string }>(
  rows: readonly T[],
  key: (row: T) => string,
): T[] {
  return [...rows].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka !== kb) return ka < kb ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Id del análisis de laboratorio vigente: el último sin sustituir ni anular
 * (un análisis anulado por una corrección `VOID` deja de contar).
 */
export function currentLabAnalysisId(
  analyses: readonly {
    id: string;
    supersededAt: Date | null;
    voidedAt?: Date | null;
    createdAt: Date;
  }[],
  corrections: readonly Pick<
    DossierCorrection,
    'kind' | 'targetType' | 'targetId'
  >[] = [],
): string | null {
  const voided = new Set(
    corrections
      .filter((c) => c.kind === 'VOID' && c.targetType === 'LAB_ANALYSIS')
      .map((c) => c.targetId),
  );
  const candidates = analyses
    .filter((a) => a.supersededAt === null && !a.voidedAt && !voided.has(a.id))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return candidates[0]?.id ?? null;
}

/** Contenido canónico `doc-dossier/1` (objeto listo para `canonicalize`). */
export function buildCanonicalDossier(source: DossierSource): Json {
  const rules = parseLotRules(source.lot.rules);
  const actor = (membershipId: string | null | undefined): Json =>
    membershipId
      ? { membershipId, role: source.roles.get(membershipId) ?? null }
      : null;

  const harvests = byKeyThenId(source.harvests, (h) =>
    dateOnly(h.intakeDate),
  ).map((h): Json => {
    const snapshot = (
      typeof h.terroirSnapshot === 'object' && h.terroirSnapshot !== null
        ? h.terroirSnapshot
        : {}
    ) as Record<string, unknown>;
    const text = (key: string, fallback: string): string =>
      typeof snapshot[key] === 'string' ? snapshot[key] : fallback;
    return {
      id: h.id,
      code: h.harvestBatchCode,
      intakeDate: dateOnly(h.intakeDate),
      harvestYear: h.harvestYear,
      grossWeightKg: fixed(h.grossWeightKg, 3),
      tareWeightKg: fixed(h.tareWeightKg, 3),
      netWeightKg: fixed(h.netWeightKg, 3),
      temperatureAtIntakeC: fixed(h.temperatureAtIntakeC, 2),
      phytosanitaryStatus: h.phytosanitaryStatus,
      terroir: {
        id: h.terroir.id,
        parcelName: text('parcelName', h.terroir.parcelName),
        altitudeMasl: fixed(
          typeof snapshot.altitudeMasl === 'number'
            ? snapshot.altitudeMasl
            : h.terroir.altitudeMasl,
          2,
        ),
        varietyName: text('varietyName', h.terroir.varietyName),
        rawMaterialType: text('rawMaterialType', h.terroir.rawMaterialType),
        takenAt: typeof snapshot.takenAt === 'string' ? snapshot.takenAt : null,
      },
      recordedAt: instant(h.createdAt),
      recordedBy: actor(h.createdByMembershipId),
      maturityAnalyses: byKeyThenId(h.maturityAnalyses, (m) =>
        m.measuredAt.toISOString(),
      ).map((m): Json => ({
        id: m.id,
        brixDegrees: fixed(m.brixDegrees, 2),
        ph: fixed(m.ph, 2),
        acidityGl: fixed(m.acidityGl, 3),
        measuredAt: instant(m.measuredAt),
        recordedAt: instant(m.recordedAt),
        recordedBy: actor(m.recordedByMembershipId),
        source: m.source,
        voidedAt: instant(m.voidedAt),
      })),
      phytoDecisions: byKeyThenId(h.phytoDecisions, (d) =>
        d.decidedAt.toISOString(),
      ).map((d): Json => ({
        id: d.id,
        decision: d.decision,
        decidedAt: instant(d.decidedAt),
        recordedAt: instant(d.recordedAt),
        decidedBy: actor(d.decidedByMembershipId),
        inspectionReportSha256: d.inspectionReportSha256,
        source: d.source,
        voidedAt: instant(d.voidedAt),
      })),
    };
  });

  const tanks = byKeyThenId(source.tanks, (t) => t.startDate.toISOString()).map(
    (t): Json => ({
      id: t.id,
      tankCode: t.tankCode,
      material: t.material,
      capacityLiters: fixed(t.capacityLiters, 2),
      volumeFilledLiters: fixed(t.volumeFilledLiters, 2),
      finalVolumeLiters: fixed(t.finalVolumeLiters, 2),
      destinationType: t.destinationType,
      status: t.status,
      startDate: instant(t.startDate),
      endDate: instant(t.endDate),
      recordedAt: instant(t.createdAt),
      recordedBy: actor(t.createdByMembershipId),
      inputs: [...t.inputs]
        .sort((a, b) =>
          a.harvestBatchId < b.harvestBatchId
            ? -1
            : a.harvestBatchId > b.harvestBatchId
              ? 1
              : 0,
        )
        .map((i): Json => ({
          harvestBatchId: i.harvestBatchId,
          kg: fixed(i.kg, 3),
        })),
      readings: byKeyThenId(t.logs, (l) => l.recordedAt.toISOString()).map(
        (l): Json => ({
          id: l.id,
          recordedAt: instant(l.recordedAt),
          temperatureCelsius: fixed(l.temperatureCelsius, 2),
          specificGravity: fixed(l.specificGravity, 4),
          phValue: fixed(l.phValue, 2),
          voidedAt: instant(l.voidedAt),
        }),
      ),
      treatments: byKeyThenId(t.treatments, (x) =>
        x.appliedAt.toISOString(),
      ).map((x): Json => ({
        id: x.id,
        treatmentType: x.treatmentType,
        additiveName: x.additiveName,
        dosageAppliedGPerHl: fixed(x.dosageAppliedGPerHl, 4),
        totalAppliedG: fixed(x.totalAppliedG, 4),
        regulatoryAuthCode: x.regulatoryAuthCode,
        appliedAt: instant(x.appliedAt),
        voidedAt: instant(x.voidedAt),
      })),
    }),
  );

  const agingStart = (a: DossierAging): string =>
    a.startDate ? dateOnly(a.startDate) : laPazDate(a.createdAt);
  const agings = byKeyThenId(source.agings, agingStart).map((a): Json => ({
    id: a.id,
    fermentationTankId: a.fermentationTankId,
    containerType: a.containerType,
    containerMaterial: a.containerMaterial,
    containerCount: a.containerCount,
    barrelUseCycle: a.barrelUseCycle,
    volumeLiters: fixed(a.volumeLiters, 2),
    plannedMonths: a.plannedMonths,
    startDate: agingStart(a),
    unlockDate: agingLock(
      {
        id: a.id,
        startDate: agingStart(a),
        plannedMonths: a.plannedMonths,
        storedUnlockDate: dateOnly(a.lockUntilDate),
      },
      rules,
      agingStart(a),
    ).unlockDate,
    status: a.agingStatus,
    discardedAt: instant(a.discardedAt),
    recordedAt: instant(a.createdAt),
    recordedBy: actor(a.createdByMembershipId),
  }));

  const distillations = byKeyThenId(source.distillations, (p) =>
    dateOnly(p.processStartDate),
  ).map((p): Json => {
    const end = day(p.processEndDate);
    return {
      id: p.id,
      fermentationTankId: p.fermentationTankId,
      processType: p.processType,
      equipmentIdentifier: p.equipmentIdentifier,
      processStartDate: dateOnly(p.processStartDate),
      processEndDate: end,
      inputVolumeLiters: fixed(p.inputVolumeLiters, 3),
      headsLiters: fixed(p.headsLiters, 3),
      heartLiters: fixed(p.heartLiters ?? p.outputVolumeLiters, 3),
      tailsLiters: fixed(p.tailsLiters, 3),
      vinasseLiters: fixed(p.vinasseLiters, 3),
      heartAbvPercent: fixed(
        p.heartAbvPercent ?? p.initialAlcoholPercentage,
        2,
      ),
      restUntil:
        restLock(
          {
            id: p.id,
            processEndDate: end,
            storedUnlockDate: day(p.mandatoryRestUntil),
          },
          rules,
          end ?? dateOnly(p.processStartDate),
        )?.unlockDate ?? null,
      status: p.restStatus,
      discardedAt: instant(p.discardedAt),
      recordedAt: instant(p.createdAt),
      recordedBy: actor(p.createdByMembershipId),
    };
  });

  let bottling: Json = null;
  if (source.bottling) {
    const b = source.bottling;
    const productType = b.productType === 'SINGANI' ? 'SINGANI' : 'WINE';
    const balance =
      b.availableLiters !== null
        ? computeBottlingBalance({
            productType,
            availableLiters: b.availableLiters,
            waterDilutionLiters: toNumber(b.waterDilutionLiters) ?? 0,
            bottles: b.totalBottlesPackaged,
            formatCl: b.packagingFormatCl,
            leftoverLiters: toNumber(b.leftoverLiters) ?? 0,
            maxLossPercent: rules.bottling.maxLossPercent,
            finalAbv: toNumber(b.finalAlcoholAbv) ?? 0,
            pureAlcoholAvailableLiters: b.pureAlcoholAvailableLiters,
          })
        : null;
    bottling = {
      id: b.id,
      lotCode: b.internationalLotCode,
      productType: b.productType,
      bottlingDate: dateOnly(b.bottlingDate),
      packagingFormatCl: b.packagingFormatCl,
      totalBottlesPackaged: b.totalBottlesPackaged,
      finalAlcoholAbv: fixed(b.finalAlcoholAbv, 2),
      waterDilutionLiters: fixed(b.waterDilutionLiters, 3),
      bottleType: b.bottleType,
      leftover:
        b.leftoverLiters !== null && b.leftoverLiters !== undefined
          ? {
              liters: fixed(b.leftoverLiters, 3),
              disposition: b.leftoverDisposition ?? 'RETAINED',
            }
          : null,
      balance: balance
        ? {
            availableLiters: fixed(balance.availableLiters, 3),
            waterDilutionLiters: fixed(balance.waterDilutionLiters, 3),
            bottledLiters: fixed(balance.bottledLiters, 3),
            leftoverLiters: fixed(balance.leftoverLiters, 3),
            lossLiters: fixed(balance.lossLiters, 3),
            lossPercent: fixed(balance.lossPercent, 2),
            pureAlcohol: balance.pureAlcohol
              ? {
                  availableLiters: fixed(
                    balance.pureAlcohol.availableLiters,
                    3,
                  ),
                  bottledLiters: fixed(balance.pureAlcohol.bottledLiters, 3),
                }
              : null,
          }
        : null,
      recordedAt: instant(b.createdAt),
      recordedBy: actor(b.createdByMembershipId),
    };
  }

  const currentLab = currentLabAnalysisId(
    source.labAnalyses,
    source.corrections,
  );
  const labAnalyses = byKeyThenId(source.labAnalyses, (l) =>
    l.createdAt.toISOString(),
  ).map((l): Json => ({
    id: l.id,
    laboratoryName: l.certifiedLaboratoryName,
    certificationCode: l.accreditedLabCertificationCode,
    analysisRequestDate: day(l.analysisRequestDate),
    testPerformedAt: dateOnly(l.testPerformedAt),
    actualAlcoholAbv: fixed(l.actualAlcoholAbv, 2),
    totalAlcoholAbv: fixed(l.totalAlcoholAbv, 2),
    totalAcidityTartaricGl: fixed(l.totalAcidityTartaricGl, 3),
    volatileAcidityAceticGl: fixed(l.volatileAcidityAceticGl, 3),
    freeSulfurDioxideMgL: fixed(l.freeSulfurDioxideMgL, 3),
    totalSulfurDioxideMgL: fixed(l.totalSulfurDioxideMgL, 3),
    reducingSugarsGl: fixed(l.reducingSugarsGl, 3),
    totalDryExtractGl: fixed(l.totalDryExtractGl, 3),
    sugarFreeDryExtractGl: fixed(l.sugarFreeDryExtractGl, 3),
    overpressureBar: fixed(l.overpressureBar, 2),
    methanolContentMgL: fixed(l.methanolContentMgL, 3),
    methanolMg100mlAa: fixed(l.methanolMg100mlAa, 3),
    copperContentMgL: fixed(l.copperContentMgL, 3),
    conformityStatus: l.conformityStatus,
    conformity: plainJson(l.conformity),
    current: l.id === currentLab,
    supersededAt: instant(l.supersededAt),
    voidedAt: instant(l.voidedAt),
    recordedAt: instant(l.createdAt),
    recordedBy: actor(l.createdByMembershipId),
  }));

  const corrections = byKeyThenId(source.corrections, (c) =>
    c.createdAt.toISOString(),
  ).map((c): Json => {
    const changes = Array.isArray(c.changes) ? (c.changes as unknown[]) : [];
    return {
      id: c.id,
      target: { type: c.targetType, id: c.targetId },
      kind: c.kind,
      changes: changes.map((raw): Json => {
        const change = (
          typeof raw === 'object' && raw !== null ? raw : {}
        ) as Record<string, unknown>;
        const field = typeof change.field === 'string' ? change.field : '';
        // Los textos libres no son públicos: queda constancia del campo
        return FREE_TEXT_FIELD.test(field)
          ? { field }
          : {
              field,
              before: plainJson(change.before),
              after: plainJson(change.after),
            };
      }),
      createdAt: instant(c.createdAt),
      createdBy: actor(c.createdByMembershipId),
    };
  });

  const attachments = byKeyThenId(source.attachments, (a) =>
    a.createdAt.toISOString(),
  ).map((a): Json => ({ kind: a.kind, sha256: a.sha256 }));

  return {
    schema: DOSSIER_SCHEMA,
    closedAt: instant(source.closedAt),
    closedBy: actor(source.closedByMembershipId),
    winery: {
      id: source.winery.id,
      lotPrefix: source.winery.lotPrefix,
      tradeName: source.winery.commercialName,
    },
    lot: {
      id: source.lot.id,
      reference: source.lot.reference,
      lotCode: source.lot.lotCode,
      name: source.lot.name,
      productType: source.lot.productType,
      harvestYear: source.lot.harvestYear,
      createdAt: instant(source.lot.createdAt),
      createdBy: actor(source.lot.createdByMembershipId),
      bottledAt: source.bottling
        ? dateOnly(source.bottling.bottlingDate)
        : null,
    },
    rules: plainJson(source.lot.rules),
    harvests,
    tanks,
    agings,
    distillations,
    bottling,
    labAnalyses,
    corrections,
    attachments,
    bottleCodes: source.bottleCodes
      ? {
          count: source.bottleCodes.count,
          merkleRoot: source.bottleCodes.merkleRoot,
          algorithm: BOTTLE_MERKLE_ALGORITHM,
        }
      : null,
  };
}

/** Bytes canónicos del expediente y su huella SHA-256 (hexadecimal). */
export function sealDossier(source: DossierSource): {
  canonical: string;
  hash: string;
} {
  const bytes = canonicalBytes(buildCanonicalDossier(source));
  return {
    canonical: bytes.toString('utf8'),
    hash: createHash('sha256').update(bytes).digest('hex'),
  };
}
