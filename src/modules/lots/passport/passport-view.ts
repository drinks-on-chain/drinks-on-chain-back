import { Prisma } from '@prisma/client';
import type { WineryRole } from '@modules/organizations/organization.constants';
import { slugify } from '@modules/wineries/winery-identity';
import { dateOnly, laPazDate } from '../domain/dates';
import { doRulesFromLot, DoStatus, evaluateDo } from '../domain/do-evaluation';
import type { LabCheck } from '../domain/lab-conformity';
import { agingLock, restLock } from '../domain/locks';
import { LOT_RULE_KEYS, LotRules, parseLotRules } from '../domain/lot-rules';
import type { LotProductType } from '../domain/lot-stage';
import { distillationHeart, num } from '../domain/sources';
import type { LotEventType } from '../lot-events';
import { isLateEntry } from '../domain/late-entry';

/**
 * Pasaporte público del lote (contrato O2 §12.2–§12.3): función pura sobre
 * los registros cargados. Reglas de publicación:
 *
 * - Solo datos registrados (EA-05): lo que falta es `NOT_RECORDED` o `null`.
 * - Personas: solo el rol (S-21). Los textos de la línea de tiempo son los
 *   públicos de aquí, nunca el resumen interno del evento (que lleva kilos,
 *   litros, motivos y nombres).
 * - Sin pesos, volúmenes intermedios, dosis, mermas ni notas (S-22).
 */
export const PASSPORT_INCLUDE = {
  winery: {
    select: {
      slug: true,
      commercialName: true,
      geographicRegion: true,
      logoUrl: true,
      website: true,
      certificationStatus: true,
    },
  },
  harvestBatches: {
    orderBy: [{ intakeDate: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      intakeDate: true,
      phytosanitaryStatus: true,
      terroirSnapshot: true,
      terroir: {
        select: {
          id: true,
          parcelName: true,
          altitudeMasl: true,
          varietyName: true,
        },
      },
      maturityAnalyses: {
        where: { voidedAt: null },
        orderBy: { measuredAt: 'desc' },
        take: 1,
        select: {
          brixDegrees: true,
          ph: true,
          acidityGl: true,
          measuredAt: true,
        },
      },
      _count: { select: { tankInputs: true } },
    },
  },
  fermentationTanks: {
    orderBy: [{ startDate: 'asc' }, { createdAt: 'asc' }],
    select: {
      startDate: true,
      endDate: true,
      // Los registros anulados por una corrección no se publican (§9)
      treatments: {
        where: { voidedAt: null },
        orderBy: { appliedAt: 'asc' },
        select: {
          treatmentType: true,
          additiveName: true,
          regulatoryAuthCode: true,
          appliedAt: true,
        },
      },
      _count: { select: { logs: { where: { voidedAt: null } } } },
    },
  },
  wineAgingBatches: {
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      containerType: true,
      containerMaterial: true,
      plannedMonths: true,
      startDate: true,
      createdAt: true,
      lockUntilDate: true,
      discardedAt: true,
    },
  },
  productionBatches: {
    orderBy: [{ processStartDate: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      processStartDate: true,
      processEndDate: true,
      mandatoryRestUntil: true,
      heartLiters: true,
      outputVolumeLiters: true,
      heartAbvPercent: true,
      initialAlcoholPercentage: true,
      discardedAt: true,
    },
  },
  bottlingBatch: {
    select: {
      productType: true,
      bottlingDate: true,
      totalBottlesPackaged: true,
      packagingFormatCl: true,
      finalAlcoholAbv: true,
      labAnalyses: {
        where: { supersededAt: null, voidedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: {
          certifiedLaboratoryName: true,
          testPerformedAt: true,
          conformity: true,
          conformityStatus: true,
        },
      },
    },
  },
  dossier: { select: { status: true, hash: true, closedAt: true } },
  events: {
    where: { visibility: 'PUBLIC' },
    orderBy: { seq: 'asc' },
    select: {
      type: true,
      occurredAt: true,
      recordedAt: true,
      actorMembershipId: true,
      data: true,
      corrected: true,
      resourceId: true,
    },
  },
} satisfies Prisma.LotInclude;

export type PassportLot = Prisma.LotGetPayload<{
  include: typeof PASSPORT_INCLUDE;
}>;

export type RecordStatus =
  'RECORDED' | 'NOT_RECORDED' | 'NOT_APPLICABLE' | 'PENDING';

export interface PublicLotPassport {
  kind: 'LOT';
  lotCode: string;
  name: string;
  productType: LotProductType;
  vintage: number;
  stage: 'BOTTLED' | 'CERTIFIED' | 'ANCHORED' | 'DISCARDED';
  winery: {
    slug: string;
    tradeName: string;
    region: string;
    logoUrl: string | null;
    website: string | null;
    active: boolean;
  };
  denomination: {
    applies: boolean;
    status: DoStatus;
    rules: { minAltitudeMasl: number; requiredVarieties: string[] } | null;
    legalException: boolean;
  };
  origin: {
    status: RecordStatus;
    terroirs: {
      parcelName: string;
      region: string;
      altitudeMasl: number;
      variety: string;
      doStatus: DoStatus;
    }[];
  };
  harvest: {
    status: RecordStatus;
    firstIntakeDate: string | null;
    lastIntakeDate: string | null;
    phytosanitary: 'APPROVED' | 'NOT_RECORDED';
    maturity: { brixDegrees: number; ph: number; acidityGl: number } | null;
  };
  fermentation: {
    status: RecordStatus;
    startDate: string | null;
    endDate: string | null;
    readingsCount: number;
    treatments: {
      type: string;
      additive: string;
      regulatoryAuthCode: string;
      appliedAt: string;
    }[];
  };
  aging: {
    status: RecordStatus;
    containerType: string | null;
    containerMaterial: string | null;
    plannedMonths: number | null;
    startDate: string | null;
    unlockDate: string | null;
  };
  distillation: {
    status: RecordStatus;
    startDate: string | null;
    endDate: string | null;
    heartAbvPercent: number | null;
    restMinDays: number | null;
    restUntil: string | null;
  };
  bottling: {
    status: RecordStatus;
    date: string | null;
    bottles: number | null;
    formatCl: number | null;
    finalAbv: number | null;
  };
  lab: {
    status: 'CONFORMING' | 'NON_CONFORMING' | 'INCOMPLETE' | 'NOT_RECORDED';
    laboratoryName: string | null;
    testedAt: string | null;
    checks: LabCheck[];
  };
  rules: {
    takenAt: string;
    origin: LotRules['origin'];
    items: {
      key: string;
      label: string;
      value: unknown;
      unit: string | null;
      legalException: boolean;
    }[];
  };
  timeline: {
    type: LotEventType;
    occurredAt: string;
    recordedAt: string;
    lateEntry: boolean;
    summary: string;
    actorRole: WineryRole | null;
    corrected: boolean;
  }[];
  corrections: { count: number; lastAt: string | null };
  dossier: {
    status: 'OPEN' | 'CLOSED';
    hash: string | null;
    closedAt: string | null;
    canonicalUrl: string | null;
    anchor: null;
  };
  publicAttachments: { id: string; kind: string; title: string; url: string }[];
  generatedAt: string;
}

/** Lo que el pasaporte necesita además de los registros del lote. */
export interface PassportContext {
  /** `YYYY-MM-DD` de hoy en America/La_Paz (reloj de la base). */
  today: string;
  now: Date;
  /** Rol de cada membresía que aparece en la línea de tiempo. */
  roles: ReadonlyMap<string, string>;
  corrections: { count: number; lastAt: Date | null };
  /**
   * Registros anulados por una corrección `VOID` (§9): sus eventos no salen
   * en la línea de tiempo pública (un dictamen o un análisis anulado deja de
   * contar; de las correcciones se publica cuántas y cuándo, §12.3).
   */
  voidedRecordIds: ReadonlySet<string>;
  attachments: readonly { id: string; kind: string; title: string }[];
  /** URL pública de una ruta de la API (`/v1/public/lots/…`). */
  publicUrl: (path: string) => string;
}

const WINERY_ROLES: ReadonlySet<string> = new Set<WineryRole>([
  'OWNER',
  'ENOLOGIST',
  'AGRONOMIST',
  'OPERATOR',
  'ACCOUNTANT',
]);

const PUBLIC_STAGES = new Set([
  'BOTTLED',
  'CERTIFIED',
  'ANCHORED',
  'DISCARDED',
]);

const PHYTO_TEXT: Record<string, string> = {
  APPROVED: 'aprobado',
  REJECTED: 'rechazado',
  QUARANTINE: 'en cuarentena',
};

/**
 * Texto público de cada evento. Nunca se publica el resumen interno: lleva
 * cifras (S-22), motivos y, a veces, nombres (S-21).
 */
export function publicEventSummary(
  type: string,
  data: Record<string, unknown>,
): string {
  switch (type) {
    case 'HARVEST_WEIGHED':
      return 'Uva recibida y pesada en la bodega';
    case 'PHYTO_DECIDED': {
      const decision = PHYTO_TEXT[String(data.decision)];
      return decision
        ? `Dictamen fitosanitario: ${decision}`
        : 'Dictamen fitosanitario registrado';
    }
    case 'TANK_FILLED':
      return 'Mosto en tanque de fermentación';
    case 'FERMENTATION_STARTED':
      return 'Fermentación iniciada';
    case 'FERMENTATION_COMPLETED':
      return 'Fermentación completada';
    case 'PRODUCT_DECIDED':
      return data.productType === 'SINGANI'
        ? 'Destino del lote: singani'
        : data.productType === 'WINE'
          ? 'Destino del lote: vino'
          : 'Destino del lote decidido';
    case 'AGING_STARTED':
      return 'Crianza iniciada';
    case 'DISTILLATION_STARTED':
      return 'Destilación iniciada';
    case 'DISTILLATION_CLOSED':
      return 'Destilación cerrada: empieza el reposo';
    case 'LOCK_RELEASED':
      return 'Tiempo mínimo de crianza o reposo cumplido';
    case 'BOTTLED':
      return 'Lote embotellado';
    case 'LAB_REGISTERED':
      return 'Análisis de laboratorio registrado';
    case 'DOSSIER_CLOSED':
      return 'Expediente del lote cerrado';
    case 'LOT_DISCARDED':
      return 'Lote retirado por la bodega';
    default:
      return 'Registro del lote';
  }
}

interface SnapshotTerroir {
  parcelName?: unknown;
  altitudeMasl?: unknown;
  varietyName?: unknown;
}

/** La parcela tal como era al pesar (`terroirSnapshot`); si falta, la actual. */
function terroirAtIntake(h: PassportLot['harvestBatches'][number]) {
  const snapshot = (h.terroirSnapshot ?? null) as SnapshotTerroir | null;
  return {
    id: h.terroir.id,
    parcelName:
      typeof snapshot?.parcelName === 'string'
        ? snapshot.parcelName
        : h.terroir.parcelName,
    altitudeMasl:
      typeof snapshot?.altitudeMasl === 'number'
        ? snapshot.altitudeMasl
        : h.terroir.altitudeMasl.toNumber(),
    varietyName:
      typeof snapshot?.varietyName === 'string'
        ? snapshot.varietyName
        : h.terroir.varietyName,
  };
}

function ruleItems(rules: LotRules, productType: LotProductType) {
  const K = LOT_RULE_KEYS;
  const item = (
    key: string,
    label: string,
    value: unknown,
    unit: string | null,
  ) => ({
    key,
    label,
    value,
    unit,
    legalException: rules.legalExceptions.includes(key),
  });
  return [
    ...(productType === 'SINGANI'
      ? [
          item(
            K.minAltitudeMasl,
            'Altitud mínima del viñedo',
            rules.singani.minAltitudeMasl,
            'msnm',
          ),
          item(
            K.requiredVarieties,
            'Variedades exigidas',
            rules.singani.requiredVarieties,
            null,
          ),
          item(
            K.minRestDays,
            'Reposo mínimo',
            rules.singani.minRestDays,
            'días',
          ),
        ]
      : [
          item(
            K.minAgingMonths,
            'Crianza mínima',
            rules.wine.minAgingMonths,
            'meses',
          ),
        ]),
    item(
      K.requireApproved,
      'Dictamen fitosanitario aprobado antes de fermentar',
      rules.phytosanitary.requireApproved,
      null,
    ),
    item(K.labLimits, 'Límites de laboratorio', rules.lab.limits, null),
  ];
}

export function buildLotPassport(
  lot: PassportLot,
  ctx: PassportContext,
): PublicLotPassport {
  const rules = parseLotRules(lot.rules);
  const bottling = lot.bottlingBatch;
  const productType: LotProductType =
    (lot.productType as LotProductType | null) ??
    (bottling?.productType === 'SINGANI' ? 'SINGANI' : 'WINE');
  const isSingani = productType === 'SINGANI';
  const lotCode = lot.lotCode as string;
  const region = lot.winery.geographicRegion;

  // ── Origen y D.O. ───────────────────────────────────────────────────────
  const terroirs = new Map<string, ReturnType<typeof terroirAtIntake>>();
  for (const h of lot.harvestBatches) {
    const t = terroirAtIntake(h);
    if (!terroirs.has(t.id)) terroirs.set(t.id, t);
  }
  const doRules = doRulesFromLot(rules);
  const evaluate = (list: ReturnType<typeof terroirAtIntake>[]): DoStatus =>
    isSingani
      ? evaluateDo(list, doRules, 'LOT_SNAPSHOT', ctx.now).status
      : 'NOT_APPLICABLE';
  const doStatus = evaluate([...terroirs.values()]);

  // ── Vendimia ────────────────────────────────────────────────────────────
  const harvests = lot.harvestBatches;
  const crushed = harvests.filter((h) => h._count.tankInputs > 0);
  const judged =
    crushed.length > 0
      ? crushed
      : harvests.filter((h) => h.phytosanitaryStatus !== 'REJECTED');
  const maturity =
    harvests
      .flatMap((h) => h.maturityAnalyses)
      .sort((a, b) => b.measuredAt.getTime() - a.measuredAt.getTime())[0] ??
    null;

  // ── Fermentación ────────────────────────────────────────────────────────
  const tanks = lot.fermentationTanks;
  const ended = tanks.every((t) => t.endDate !== null);

  // ── Crianza (vino) y destilación (singani) ──────────────────────────────
  const agings = lot.wineAgingBatches
    .filter((a) => !a.discardedAt)
    .map((a) => ({
      row: a,
      startDate: a.startDate ? dateOnly(a.startDate) : laPazDate(a.createdAt),
    }))
    .map((a) => ({
      ...a,
      lock: agingLock(
        {
          id: a.row.id,
          startDate: a.startDate,
          plannedMonths: a.row.plannedMonths,
          storedUnlockDate: dateOnly(a.row.lockUntilDate),
        },
        rules,
        ctx.today,
      ),
    }))
    // La que fijó la disponibilidad del lote: la de desbloqueo más tardío
    .sort((a, b) => b.lock.unlockDate.localeCompare(a.lock.unlockDate));
  const aging = agings[0] ?? null;

  const distillations = lot.productionBatches.filter((p) => !p.discardedAt);
  const hearts = distillations.map((p) => distillationHeart(p));
  const allClosed =
    distillations.length > 0 &&
    distillations.every((p) => p.processEndDate !== null);
  const restUntil = distillations
    .map(
      (p) =>
        restLock(
          {
            id: p.id,
            processEndDate: p.processEndDate
              ? dateOnly(p.processEndDate)
              : null,
            storedUnlockDate: p.mandatoryRestUntil
              ? dateOnly(p.mandatoryRestUntil)
              : null,
          },
          rules,
          ctx.today,
        )?.unlockDate ?? null,
    )
    .filter((d): d is string => d !== null)
    .sort()
    .pop();
  let heartAbv: number | null = null;
  const abvs = hearts.map((h) => h.abv);
  if (abvs.length > 0 && abvs.every((v) => v !== null)) {
    if (new Set(abvs).size === 1) {
      heartAbv = abvs[0];
    } else if (hearts.every((h) => h.liters !== null)) {
      const liters = hearts.reduce((s, h) => s + (h.liters as number), 0);
      heartAbv =
        liters > 0
          ? Math.round(
              (hearts.reduce(
                (s, h) => s + (h.liters as number) * (h.abv as number),
                0,
              ) /
                liters) *
                100,
            ) / 100
          : null;
    }
  }

  // ── Laboratorio ─────────────────────────────────────────────────────────
  const lab = bottling?.labAnalyses[0] ?? null;
  const labStatus =
    lab?.conformityStatus === 'CONFORMING' ||
    lab?.conformityStatus === 'NON_CONFORMING' ||
    lab?.conformityStatus === 'INCOMPLETE'
      ? lab.conformityStatus
      : 'NOT_RECORDED';
  const rawChecks = (lab?.conformity as { checks?: unknown } | null)?.checks;

  const closed = lot.dossier?.status === 'CLOSED' && !!lot.dossier.hash;
  const timelineEvents = lot.events.filter(
    (e) => !ctx.voidedRecordIds.has(e.resourceId),
  );
  const lotPath = `/v1/public/lots/${encodeURIComponent(lotCode)}`;

  return {
    kind: 'LOT',
    lotCode,
    name: lot.name,
    productType,
    vintage: lot.harvestYear,
    stage: (PUBLIC_STAGES.has(lot.stage)
      ? lot.stage
      : 'BOTTLED') as PublicLotPassport['stage'],
    winery: {
      slug: lot.winery.slug ?? slugify(lot.winery.commercialName),
      tradeName: lot.winery.commercialName,
      region,
      logoUrl: lot.winery.logoUrl,
      website: lot.winery.website,
      active: lot.winery.certificationStatus === 'ACTIVE',
    },
    denomination: {
      applies: isSingani,
      status: doStatus,
      rules: isSingani
        ? {
            minAltitudeMasl: rules.singani.minAltitudeMasl,
            requiredVarieties: rules.singani.requiredVarieties,
          }
        : null,
      legalException: doStatus === 'ELIGIBLE_BY_EXCEPTION',
    },
    origin: {
      status: terroirs.size > 0 ? 'RECORDED' : 'NOT_RECORDED',
      terroirs: [...terroirs.values()].map((t) => ({
        parcelName: t.parcelName,
        region,
        altitudeMasl: t.altitudeMasl,
        variety: t.varietyName,
        doStatus: evaluate([t]),
      })),
    },
    harvest: {
      status: harvests.length > 0 ? 'RECORDED' : 'NOT_RECORDED',
      firstIntakeDate:
        harvests.length > 0 ? dateOnly(harvests[0].intakeDate) : null,
      lastIntakeDate:
        harvests.length > 0
          ? dateOnly(harvests[harvests.length - 1].intakeDate)
          : null,
      phytosanitary:
        judged.length > 0 &&
        judged.every((h) => h.phytosanitaryStatus === 'APPROVED')
          ? 'APPROVED'
          : 'NOT_RECORDED',
      maturity: maturity
        ? {
            brixDegrees: maturity.brixDegrees.toNumber(),
            ph: maturity.ph.toNumber(),
            acidityGl: maturity.acidityGl.toNumber(),
          }
        : null,
    },
    fermentation: {
      status: tanks.length > 0 ? 'RECORDED' : 'NOT_RECORDED',
      startDate: tanks.length > 0 ? tanks[0].startDate.toISOString() : null,
      endDate:
        tanks.length > 0 && ended
          ? new Date(
              Math.max(...tanks.map((t) => (t.endDate as Date).getTime())),
            ).toISOString()
          : null,
      readingsCount: tanks.reduce((s, t) => s + t._count.logs, 0),
      treatments: tanks
        .flatMap((t) => t.treatments)
        .sort((a, b) => a.appliedAt.getTime() - b.appliedAt.getTime())
        .map((t) => ({
          type: t.treatmentType,
          additive: t.additiveName,
          regulatoryAuthCode: t.regulatoryAuthCode,
          appliedAt: t.appliedAt.toISOString(),
        })),
    },
    aging: isSingani
      ? {
          status: 'NOT_APPLICABLE',
          containerType: null,
          containerMaterial: null,
          plannedMonths: null,
          startDate: null,
          unlockDate: null,
        }
      : {
          status: aging ? 'RECORDED' : 'NOT_RECORDED',
          containerType: aging?.row.containerType ?? null,
          containerMaterial: aging?.row.containerMaterial ?? null,
          plannedMonths: aging?.row.plannedMonths ?? null,
          startDate: aging?.startDate ?? null,
          unlockDate: aging?.lock.unlockDate ?? null,
        },
    distillation: !isSingani
      ? {
          status: 'NOT_APPLICABLE',
          startDate: null,
          endDate: null,
          heartAbvPercent: null,
          restMinDays: null,
          restUntil: null,
        }
      : {
          status: distillations.length > 0 ? 'RECORDED' : 'NOT_RECORDED',
          startDate:
            distillations.length > 0
              ? dateOnly(distillations[0].processStartDate)
              : null,
          endDate: allClosed
            ? (distillations
                .map((p) => dateOnly(p.processEndDate as Date))
                .sort()
                .pop() as string)
            : null,
          heartAbvPercent: heartAbv,
          restMinDays:
            distillations.length > 0 ? rules.singani.minRestDays : null,
          restUntil: restUntil ?? null,
        },
    bottling: {
      status: bottling ? 'RECORDED' : 'NOT_RECORDED',
      date: bottling ? dateOnly(bottling.bottlingDate) : null,
      bottles: bottling?.totalBottlesPackaged ?? null,
      formatCl: bottling?.packagingFormatCl ?? null,
      finalAbv: num(bottling?.finalAlcoholAbv),
    },
    lab: {
      status: labStatus,
      laboratoryName: lab?.certifiedLaboratoryName ?? null,
      testedAt: lab ? dateOnly(lab.testPerformedAt) : null,
      checks: Array.isArray(rawChecks) ? (rawChecks as LabCheck[]) : [],
    },
    rules: {
      takenAt: rules.takenAt,
      origin: rules.origin,
      items: ruleItems(rules, productType),
    },
    timeline: timelineEvents.map((e) => {
      const role = e.actorMembershipId
        ? ctx.roles.get(e.actorMembershipId)
        : undefined;
      return {
        type: e.type as LotEventType,
        occurredAt: e.occurredAt.toISOString(),
        recordedAt: e.recordedAt.toISOString(),
        lateEntry: isLateEntry(e.occurredAt, e.recordedAt),
        summary: publicEventSummary(
          e.type,
          (e.data ?? {}) as Record<string, unknown>,
        ),
        actorRole: role && WINERY_ROLES.has(role) ? (role as WineryRole) : null,
        corrected: e.corrected,
      };
    }),
    corrections: {
      count: ctx.corrections.count,
      lastAt: ctx.corrections.lastAt?.toISOString() ?? null,
    },
    dossier: {
      status: closed ? 'CLOSED' : 'OPEN',
      hash: closed ? (lot.dossier?.hash ?? null) : null,
      closedAt: closed ? (lot.dossier?.closedAt?.toISOString() ?? null) : null,
      canonicalUrl: closed ? ctx.publicUrl(`${lotPath}/dossier`) : null,
      anchor: null,
    },
    publicAttachments: ctx.attachments.map((a) => ({
      id: a.id,
      kind: a.kind,
      title: a.title,
      url: ctx.publicUrl(`${lotPath}/attachments/${a.id}`),
    })),
    generatedAt: ctx.now.toISOString(),
  };
}
