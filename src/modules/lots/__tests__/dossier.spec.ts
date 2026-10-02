import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import {
  buildCanonicalDossier,
  currentLabAnalysisId,
  dossierRequirements,
  DossierReadinessInput,
  DossierSource,
  fixed,
  sealDossier,
} from '../domain/dossier';
import { canonicalize } from '../domain/jcs';
import { bottleLeafHash, merkleRoot } from '../domain/merkle';

const D = (value: string) => new Prisma.Decimal(value);
const at = (iso: string) => new Date(iso);

const RULES = {
  takenAt: '2026-03-01T12:00:00.000Z',
  origin: 'LOT_CREATION',
  singani: {
    minAltitudeMasl: 1600,
    requiredVarieties: ['Moscatel de Alejandría'],
    minRestDays: 180,
  },
  wine: { minAgingMonths: 6 },
  phytosanitary: { requireApproved: true },
  bottling: { maxLossPercent: 5 },
  lab: { limits: { cobre: { max: 0.5, unidad: 'mg/l' } } },
  legalExceptions: [],
  sources: {},
  values: { 'trazabilidad.singani.reposoMinimoDias': 180 },
};

const OWNER = 'aaaaaaaa-0000-4000-8000-000000000001';
const OPERATOR = 'aaaaaaaa-0000-4000-8000-000000000002';

function source(overrides: Partial<DossierSource> = {}): DossierSource {
  const codes = [
    { serial: 1, code: 'K7M2Q9XA', salt: '11'.repeat(16) },
    { serial: 2, code: 'P3R8T2W7', salt: '22'.repeat(16) },
  ];
  return {
    winery: {
      id: 'bbbbbbbb-0000-4000-8000-000000000001',
      lotPrefix: 'CVJ',
      commercialName: 'Destilería Cinti Viejo',
    },
    lot: {
      id: 'cccccccc-0000-4000-8000-000000000001',
      reference: 'CVJ-L2026-004',
      lotCode: 'CVJ-2026-SINGANI-004',
      name: 'Singani Gran Reserva 2026',
      productType: 'SINGANI',
      harvestYear: 2026,
      createdAt: at('2026-03-01T12:00:00.000Z'),
      createdByMembershipId: OWNER,
      rules: RULES,
    },
    harvests: [
      {
        id: 'dddddddd-0000-4000-8000-000000000002',
        harvestBatchCode: 'HARV-2026-PARRALES-002',
        intakeDate: at('2026-03-16T00:00:00.000Z'),
        harvestYear: 2026,
        grossWeightKg: D('2100'),
        tareWeightKg: D('100'),
        netWeightKg: D('2000'),
        temperatureAtIntakeC: null,
        phytosanitaryStatus: 'APPROVED',
        createdAt: at('2026-03-16T15:00:00.000Z'),
        createdByMembershipId: OPERATOR,
        terroirSnapshot: null,
        terroir: {
          id: 'eeeeeeee-0000-4000-8000-000000000001',
          parcelName: 'Los Parrales',
          altitudeMasl: D('1850'),
          varietyName: 'Moscatel de Alejandría',
          rawMaterialType: 'Uva',
        },
        maturityAnalyses: [],
        phytoDecisions: [],
      },
      {
        id: 'dddddddd-0000-4000-8000-000000000001',
        harvestBatchCode: 'HARV-2026-PARRALES-001',
        intakeDate: at('2026-03-15T00:00:00.000Z'),
        harvestYear: 2026,
        grossWeightKg: D('18500'),
        tareWeightKg: D('100'),
        netWeightKg: D('18400'),
        temperatureAtIntakeC: D('12.5'),
        phytosanitaryStatus: 'APPROVED',
        createdAt: at('2026-03-15T15:00:00.000Z'),
        createdByMembershipId: OPERATOR,
        terroirSnapshot: {
          parcelName: 'Los Parrales (al pesar)',
          altitudeMasl: 1850,
          varietyName: 'Moscatel de Alejandría',
          rawMaterialType: 'Uva',
          takenAt: '2026-03-15T15:00:00.000Z',
        },
        terroir: {
          id: 'eeeeeeee-0000-4000-8000-000000000001',
          parcelName: 'Los Parrales (renombrada después)',
          altitudeMasl: D('1900'),
          varietyName: 'Moscatel de Alejandría',
          rawMaterialType: 'Uva',
        },
        maturityAnalyses: [
          {
            id: 'ffffffff-0000-4000-8000-000000000002',
            brixDegrees: D('24'),
            ph: D('3.4'),
            acidityGl: D('5.9'),
            measuredAt: at('2026-03-16T09:00:00.000Z'),
            recordedAt: at('2026-03-16T10:00:00.000Z'),
            recordedByMembershipId: OWNER,
            source: 'ERP',
            voidedAt: null,
          },
          {
            id: 'ffffffff-0000-4000-8000-000000000001',
            brixDegrees: D('23.5'),
            ph: D('3.5'),
            acidityGl: D('5.8'),
            measuredAt: at('2026-03-15T09:00:00.000Z'),
            recordedAt: at('2026-03-15T15:00:00.000Z'),
            recordedByMembershipId: OPERATOR,
            source: 'ERP',
            voidedAt: null,
          },
        ],
        phytoDecisions: [
          {
            id: '99999999-0000-4000-8000-000000000001',
            decision: 'APPROVED',
            decidedAt: at('2026-03-16T12:00:00.000Z'),
            recordedAt: at('2026-03-16T12:05:00.000Z'),
            decidedByMembershipId: OWNER,
            inspectionReportSha256: null,
            source: 'ERP',
            voidedAt: null,
          },
        ],
      },
    ],
    tanks: [
      {
        id: '11111111-0000-4000-8000-000000000001',
        tankCode: 'TK-01',
        material: 'Acero inoxidable',
        capacityLiters: D('15000'),
        volumeFilledLiters: D('12100'),
        finalVolumeLiters: null,
        destinationType: 'SINGANI_DIST',
        status: 'TRANSFERRED',
        startDate: at('2026-03-17T14:00:00.000Z'),
        endDate: null,
        createdAt: at('2026-03-17T14:10:00.000Z'),
        createdByMembershipId: OWNER,
        inputs: [
          {
            harvestBatchId: 'dddddddd-0000-4000-8000-000000000002',
            kg: D('2000'),
          },
          {
            harvestBatchId: 'dddddddd-0000-4000-8000-000000000001',
            kg: D('18400'),
          },
        ],
        logs: [],
        treatments: [],
      },
    ],
    agings: [],
    distillations: [
      {
        id: '22222222-0000-4000-8000-000000000001',
        fermentationTankId: '11111111-0000-4000-8000-000000000001',
        processType: 'SINGANI_DISTILLATION',
        equipmentIdentifier: 'Alambique AL-01',
        processStartDate: at('2026-03-25T00:00:00.000Z'),
        processEndDate: at('2026-03-30T00:00:00.000Z'),
        inputVolumeLiters: D('12100'),
        outputVolumeLiters: D('1500'),
        headsLiters: D('120'),
        heartLiters: D('1500'),
        tailsLiters: D('210'),
        vinasseLiters: null,
        heartAbvPercent: D('60'),
        initialAlcoholPercentage: D('60'),
        mandatoryRestUntil: at('2026-09-26T00:00:00.000Z'),
        restStatus: 'BOTTLED',
        discardedAt: null,
        createdAt: at('2026-03-30T18:00:00.000Z'),
        createdByMembershipId: OWNER,
      },
    ],
    bottling: {
      id: '33333333-0000-4000-8000-000000000001',
      internationalLotCode: 'CVJ-2026-SINGANI-004',
      productType: 'SINGANI',
      bottlingDate: at('2026-09-29T00:00:00.000Z'),
      packagingFormatCl: 75,
      totalBottlesPackaged: 2950,
      finalAlcoholAbv: D('40'),
      waterDilutionLiters: D('750'),
      leftoverLiters: null,
      leftoverDisposition: null,
      bottleType: 'Vidrio Extra-Flint 750ml',
      createdAt: at('2026-09-29T16:00:00.000Z'),
      createdByMembershipId: OWNER,
      availableLiters: 1500,
      pureAlcoholAvailableLiters: 900,
    },
    labAnalyses: [
      {
        id: '44444444-0000-4000-8000-000000000001',
        certifiedLaboratoryName: 'Laboratorio ISO 17025',
        accreditedLabCertificationCode: 'LAB-1',
        analysisRequestDate: null,
        testPerformedAt: at('2026-09-30T00:00:00.000Z'),
        actualAlcoholAbv: D('40.05'),
        totalAlcoholAbv: null,
        totalAcidityTartaricGl: D('4.8'),
        volatileAcidityAceticGl: D('0.22'),
        freeSulfurDioxideMgL: null,
        totalSulfurDioxideMgL: null,
        reducingSugarsGl: null,
        totalDryExtractGl: null,
        sugarFreeDryExtractGl: null,
        overpressureBar: null,
        methanolContentMgL: D('48'),
        methanolMg100mlAa: D('11.985'),
        copperContentMgL: D('0.02'),
        conformity: {
          status: 'CONFORMING',
          checks: [
            {
              parameter: 'cobre',
              value: 0.02,
              unit: 'mg/L',
              limit: { max: 0.5, unidad: 'mg/l' },
              result: 'PASS',
            },
          ],
          warnings: [],
          rulesTakenAt: '2026-03-01T12:00:00.000Z',
        },
        conformityStatus: 'CONFORMING',
        supersededAt: null,
        createdAt: at('2026-09-30T18:00:00.000Z'),
        createdByMembershipId: OWNER,
      },
    ],
    corrections: [
      {
        id: '55555555-0000-4000-8000-000000000001',
        targetType: 'HARVEST_BATCH',
        targetId: 'dddddddd-0000-4000-8000-000000000001',
        kind: 'AMEND',
        changes: [
          { field: 'grossWeightKg', before: 18400, after: 18500 },
          { field: 'notes', before: 'Texto interno', after: 'Otro texto' },
        ],
        createdAt: at('2026-03-18T10:00:00.000Z'),
        createdByMembershipId: OWNER,
      },
    ],
    attachments: [
      {
        id: '66666666-0000-4000-8000-000000000001',
        kind: 'LABEL',
        sha256: 'ab'.repeat(32),
        createdAt: at('2026-09-29T17:00:00.000Z'),
      },
    ],
    bottleCodes: {
      count: codes.length,
      merkleRoot: merkleRoot(
        codes.map((c) => bottleLeafHash(c.serial, c.code, c.salt)),
      ),
    },
    roles: new Map([
      [OWNER, 'OWNER'],
      [OPERATOR, 'OPERATOR'],
    ]),
    closedAt: at('2026-10-01T15:04:05.123Z'),
    closedByMembershipId: OWNER,
    ...overrides,
  };
}

type Canonical = Record<string, unknown> & {
  harvests: Record<string, unknown>[];
  tanks: { inputs: { harvestBatchId: string; kg: string }[] }[];
  distillations: Record<string, unknown>[];
  bottling: { balance: Record<string, unknown> } & Record<string, unknown>;
  labAnalyses: Record<string, unknown>[];
  corrections: { changes: Record<string, unknown>[] }[];
};

describe('requisitos del cierre del expediente (§10)', () => {
  const ready: DossierReadinessInput = {
    bottles: 2950,
    labStatus: 'CONFORMING',
    activeCodes: 2950,
    serialsWithCode: 2950,
    duplicatedActiveSerials: 0,
    openComplianceIssues: 0,
    openSources: 0,
  };
  const unmet = (input: DossierReadinessInput) =>
    dossierRequirements(input)
      .filter((r) => !r.met)
      .map((r) => r.key);

  it('los cinco requisitos, en el orden del contrato, cumplidos', () => {
    const requirements = dossierRequirements(ready);
    expect(requirements.map((r) => r.key)).toEqual([
      'BOTTLED',
      'LAB_CONFORMING',
      'BOTTLE_CODES_READY',
      'NO_OPEN_COMPLIANCE_ISSUES',
      'NO_OPEN_SOURCES',
    ]);
    expect(requirements.every((r) => r.met && r.message.length > 0)).toBe(true);
  });

  it('el laboratorio solo cumple si es conforme (incompleto, no conforme o ausente no)', () => {
    for (const labStatus of [
      'NOT_RECORDED',
      'INCOMPLETE',
      'NON_CONFORMING',
    ] as const) {
      expect(unmet({ ...ready, labStatus })).toEqual(['LAB_CONFORMING']);
    }
  });

  it('sin embotellar faltan el embotellado y los códigos', () => {
    expect(
      unmet({
        ...ready,
        bottles: null,
        activeCodes: 0,
        serialsWithCode: 0,
        labStatus: 'NOT_RECORDED',
      }),
    ).toEqual(['BOTTLED', 'LAB_CONFORMING', 'BOTTLE_CODES_READY']);
  });

  it('códigos: una baja sin sustituto no impide cerrar; faltantes o duplicados sí', () => {
    expect(unmet({ ...ready, activeCodes: 2949 })).toEqual([]);
    expect(unmet({ ...ready, activeCodes: 0 })).toEqual(['BOTTLE_CODES_READY']);
    expect(unmet({ ...ready, serialsWithCode: 2900 })).toEqual([
      'BOTTLE_CODES_READY',
    ]);
    expect(unmet({ ...ready, duplicatedActiveSerials: 1 })).toEqual([
      'BOTTLE_CODES_READY',
    ]);
  });

  it('incidencias y fuentes abiertas bloquean el cierre', () => {
    expect(
      unmet({ ...ready, openComplianceIssues: 2, openSources: 1 }),
    ).toEqual(['NO_OPEN_COMPLIANCE_ISSUES', 'NO_OPEN_SOURCES']);
  });
});

describe('contenido canónico doc-dossier/1 (§10)', () => {
  it('decimales como cadenas de escala fija', () => {
    expect(fixed(D('18400'), 3)).toBe('18400.000');
    expect(fixed(D('0.1'), 2)).toBe('0.10');
    expect(fixed(1500, 3)).toBe('1500.000');
    expect(fixed(-0, 2)).toBe('0.00');
    expect(fixed(-0.0001, 3)).toBe('0.000');
    expect(fixed(null, 3)).toBeNull();
    expect(fixed(undefined, 3)).toBeNull();
  });

  it('tiene la forma del contrato: bodega, lote, reglas, cadena, balance, laboratorio, raíz Merkle y cierre', () => {
    const doc = buildCanonicalDossier(source()) as Canonical;
    expect(Object.keys(doc).sort()).toEqual(
      [
        'schema',
        'closedAt',
        'closedBy',
        'winery',
        'lot',
        'rules',
        'harvests',
        'tanks',
        'agings',
        'distillations',
        'bottling',
        'labAnalyses',
        'corrections',
        'attachments',
        'bottleCodes',
      ].sort(),
    );
    expect(doc).toMatchObject({
      schema: 'doc-dossier/1',
      closedAt: '2026-10-01T15:04:05.123Z',
      closedBy: { membershipId: OWNER, role: 'OWNER' },
      winery: { lotPrefix: 'CVJ', tradeName: 'Destilería Cinti Viejo' },
      lot: {
        reference: 'CVJ-L2026-004',
        lotCode: 'CVJ-2026-SINGANI-004',
        productType: 'SINGANI',
        harvestYear: 2026,
        bottledAt: '2026-09-29',
        createdBy: { membershipId: OWNER, role: 'OWNER' },
      },
      rules: RULES,
      attachments: [{ kind: 'LABEL', sha256: 'ab'.repeat(32) }],
      bottleCodes: { count: 2, algorithm: 'sha256-merkle/serial-code-salt' },
    });
    expect(doc.bottling).toMatchObject({
      lotCode: 'CVJ-2026-SINGANI-004',
      bottlingDate: '2026-09-29',
      packagingFormatCl: 75,
      totalBottlesPackaged: 2950,
      finalAlcoholAbv: '40.00',
      waterDilutionLiters: '750.000',
      leftover: null,
      balance: {
        availableLiters: '1500.000',
        waterDilutionLiters: '750.000',
        bottledLiters: '2212.500',
        leftoverLiters: '0.000',
        lossLiters: '37.500',
        lossPercent: '1.67',
        pureAlcohol: { availableLiters: '900.000', bottledLiters: '885.000' },
      },
    });
    expect(doc.distillations[0]).toMatchObject({
      inputVolumeLiters: '12100.000',
      headsLiters: '120.000',
      heartLiters: '1500.000',
      tailsLiters: '210.000',
      vinasseLiters: null,
      heartAbvPercent: '60.00',
      processEndDate: '2026-03-30',
      restUntil: '2026-09-26',
    });
    expect(doc.labAnalyses[0]).toMatchObject({
      actualAlcoholAbv: '40.05',
      methanolMg100mlAa: '11.985',
      copperContentMgL: '0.020',
      conformityStatus: 'CONFORMING',
      current: true,
      // El documento guardado va tal cual (números JSON)
      conformity: { status: 'CONFORMING', checks: [{ value: 0.02 }] },
    });
  });

  it('las listas van por fecha e id y la parcela, tal como era al pesar', () => {
    const doc = buildCanonicalDossier(source()) as Canonical;
    expect(doc.harvests.map((h) => h.code)).toEqual([
      'HARV-2026-PARRALES-001',
      'HARV-2026-PARRALES-002',
    ]);
    const first = doc.harvests[0] as {
      terroir: Record<string, unknown>;
      maturityAnalyses: { brixDegrees: string }[];
    };
    expect(first).toMatchObject({
      grossWeightKg: '18500.000',
      netWeightKg: '18400.000',
      temperatureAtIntakeC: '12.50',
      intakeDate: '2026-03-15',
    });
    expect(first.terroir).toMatchObject({
      parcelName: 'Los Parrales (al pesar)',
      altitudeMasl: '1850.00',
      takenAt: '2026-03-15T15:00:00.000Z',
    });
    expect(first.maturityAnalyses.map((m) => m.brixDegrees)).toEqual([
      '23.50',
      '24.00',
    ]);
    // Sin instantánea (dato anterior): la parcela actual
    expect(
      (doc.harvests[1] as { terroir: Record<string, unknown> }).terroir,
    ).toMatchObject({ parcelName: 'Los Parrales', takenAt: null });
    expect(doc.tanks[0].inputs).toEqual([
      {
        harvestBatchId: 'dddddddd-0000-4000-8000-000000000001',
        kg: '18400.000',
      },
      {
        harvestBatchId: 'dddddddd-0000-4000-8000-000000000002',
        kg: '2000.000',
      },
    ]);
  });

  it('personas como { membershipId, role }; sin nombres, textos libres, URL ni códigos en claro', () => {
    const base = source();
    const text = canonicalize(
      buildCanonicalDossier({
        ...base,
        // Aunque los registros traigan más campos (los de Prisma), no salen
        harvests: base.harvests.map((h) => ({
          ...h,
          notes: 'Nota interna del pesaje',
          phytoInspectionPdfUrl: 'https://archivos.test/informe.pdf',
        })),
      }),
    );
    expect(text).not.toMatch(/Nota interna|archivos\.test|fullName|email/);
    expect(text).not.toMatch(/Texto interno|Otro texto/);
    expect(text).not.toMatch(/K7M2Q9XA|P3R8T2W7/);
    const doc = JSON.parse(text) as Canonical;
    expect(doc.corrections[0].changes).toEqual([
      { field: 'grossWeightKg', before: 18400, after: 18500 },
      { field: 'notes' },
    ]);
  });

  it('la huella es el SHA-256 de los bytes canónicos y no depende del orden de entrada', () => {
    const a = sealDossier(source());
    const base = source();
    const shuffled = sealDossier({
      ...base,
      harvests: [...base.harvests].reverse().map((h) => ({
        ...h,
        maturityAnalyses: [...h.maturityAnalyses].reverse(),
      })),
      tanks: base.tanks.map((t) => ({ ...t, inputs: [...t.inputs].reverse() })),
    });
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).toBe(
      createHash('sha256')
        .update(Buffer.from(a.canonical, 'utf8'))
        .digest('hex'),
    );
    expect(shuffled.canonical).toBe(a.canonical);
    expect(shuffled.hash).toBe(a.hash);
    // Canónico: sin espacios y con las claves ordenadas
    expect(a.canonical.startsWith('{"agings":[],"attachments":[')).toBe(true);
  });

  it('cualquier cambio de un registro, de un código o del cierre cambia la huella', () => {
    const original = sealDossier(source()).hash;
    const base = source();
    const heavier = sealDossier({
      ...base,
      harvests: base.harvests.map((h) => ({
        ...h,
        netWeightKg: D('18400.001'),
      })),
    }).hash;
    const otherCodes = sealDossier({
      ...base,
      bottleCodes: { count: 2, merkleRoot: 'cd'.repeat(32) },
    }).hash;
    const later = sealDossier({
      ...base,
      closedAt: at('2026-10-01T15:04:05.124Z'),
    }).hash;
    const preview = sealDossier({
      ...base,
      closedAt: null,
      closedByMembershipId: null,
    });
    expect(
      new Set([original, heavier, otherCodes, later, preview.hash]).size,
    ).toBe(5);
    expect(JSON.parse(preview.canonical)).toMatchObject({
      closedAt: null,
      closedBy: null,
    });
  });

  it('un lote sin embotellar tiene vista previa (sin embotellado ni códigos)', () => {
    const doc = buildCanonicalDossier(
      source({ bottling: null, bottleCodes: null, labAnalyses: [] }),
    ) as Canonical;
    expect(doc.bottling).toBeNull();
    expect(doc.bottleCodes).toBeNull();
    expect((doc.lot as { bottledAt: unknown }).bottledAt).toBeNull();
  });

  it('el análisis vigente es el último sin sustituir ni anular', () => {
    const analyses = [
      {
        id: 'a',
        supersededAt: at('2026-10-01T00:00:00Z'),
        createdAt: at('2026-09-30T00:00:00Z'),
      },
      { id: 'b', supersededAt: null, createdAt: at('2026-10-01T00:00:00Z') },
      { id: 'c', supersededAt: null, createdAt: at('2026-10-02T00:00:00Z') },
    ];
    expect(currentLabAnalysisId(analyses)).toBe('c');
    expect(
      currentLabAnalysisId(analyses, [
        { kind: 'VOID', targetType: 'LAB_ANALYSIS', targetId: 'c' },
      ]),
    ).toBe('b');
    expect(currentLabAnalysisId([])).toBeNull();
  });
});
