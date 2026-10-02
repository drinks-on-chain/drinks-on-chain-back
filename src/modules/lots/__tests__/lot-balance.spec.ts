import {
  computeLotBalance,
  distillationLossPercent,
  LotBalanceInput,
  productionFigures,
  productionTotals,
  projectBottles,
  transferLoss,
} from '../domain/lot-balance';
import {
  csvCell,
  PRODUCTION_REPORT_COLUMNS,
  productionReportCsv,
  ProductionReportRow,
} from '../views/trace-insights.service';

/** Singani del recorrido H2 (contrato O2 §18) antes de embotellar. */
function singani(overrides: Partial<LotBalanceInput> = {}): LotBalanceInput {
  return {
    productType: 'SINGANI',
    harvests: [{ netKg: 18400, status: 'APPROVED' }],
    tanks: [
      {
        filledLiters: 12100,
        finalLiters: null,
        inputKg: 18400,
        drawnLiters: 12100,
        transferred: true,
      },
    ],
    agings: [],
    distillations: [
      {
        inputLiters: 12100,
        headsLiters: 120,
        heartLiters: 1500,
        tailsLiters: 210,
        vinasseLiters: null,
        heartAbvPercent: 60,
        closed: true,
        discarded: false,
      },
    ],
    bottling: null,
    activeBottles: null,
    plannedFormatCl: 75,
    targetAbvPercent: 40,
    estimatedBottles: 3000,
    maxLossPercent: 5,
    ...overrides,
  };
}

function wine(overrides: Partial<LotBalanceInput> = {}): LotBalanceInput {
  return {
    productType: 'WINE',
    harvests: [
      { netKg: 3000, status: 'APPROVED' },
      { netKg: 500, status: 'REJECTED' },
      { netKg: 250, status: 'QUARANTINE' },
      { netKg: 250, status: 'PENDING_INSPECTION' },
    ],
    tanks: [
      {
        filledLiters: 2100,
        finalLiters: 2000,
        inputKg: 3000,
        drawnLiters: 1950,
        transferred: true,
      },
    ],
    agings: [{ liters: 1950, tankLiters: 2000, discarded: false }],
    distillations: [],
    bottling: null,
    activeBottles: null,
    plannedFormatCl: 75,
    targetAbvPercent: null,
    estimatedBottles: 2000,
    maxLossPercent: 5,
    ...overrides,
  };
}

describe('balance del lote (contrato O2 §11.3)', () => {
  it('singani: kilos, mosto, cortes y alcohol puro; sin volumen final no hay merma de fermentación', () => {
    const balance = computeLotBalance(singani());
    expect(balance).toEqual({
      harvest: { netKg: 18400, approvedKg: 18400, rejectedKg: 0, pendingKg: 0 },
      must: { filledLiters: 12100, litersPerKg: 0.658 },
      fermentation: { finalLiters: null, lossLiters: null, lossPercent: null },
      distillation: {
        inputLiters: 12100,
        headsLiters: 120,
        heartLiters: 1500,
        tailsLiters: 210,
        heartAbvPercent: 60,
        pureAlcoholLiters: 900,
      },
      bottling: null,
      projection: { bottles: 2850, basis: 'DISTILLATE' },
    });
    expect(balance.aging).toBeUndefined();
  });

  it('vino: dictámenes por kilos, merma de fermentación y de trasiego', () => {
    const balance = computeLotBalance(wine());
    expect(balance.harvest).toEqual({
      netKg: 4000,
      approvedKg: 3000,
      rejectedKg: 500,
      pendingKg: 500,
    });
    // El rendimiento usa los kilos que entraron a tanques, no todo lo recibido
    expect(balance.must).toEqual({ filledLiters: 2100, litersPerKg: 0.7 });
    expect(balance.fermentation).toEqual({
      finalLiters: 2000,
      lossLiters: 100,
      lossPercent: 4.76,
    });
    expect(balance.aging).toEqual({ liters: 1950, lossLiters: 50 });
    expect(balance.distillation).toBeUndefined();
    expect(transferLoss(wine().tanks)).toEqual({ liters: 50, percent: 2.5 });
  });

  it('una crianza descartada no cuenta', () => {
    const balance = computeLotBalance(
      wine({ agings: [{ liters: 1950, tankLiters: 2000, discarded: true }] }),
    );
    expect(balance.aging).toBeUndefined();
  });

  it('varias destilaciones: grado medio ponderado; sin grado no hay alcohol puro', () => {
    const second = { ...singani().distillations[0], heartLiters: 500 };
    const weighted = computeLotBalance(
      singani({
        distillations: [
          singani().distillations[0],
          { ...second, heartAbvPercent: 64 },
        ],
      }),
    );
    expect(weighted.distillation).toMatchObject({
      heartLiters: 2000,
      heartAbvPercent: 61,
      pureAlcoholLiters: 1220,
    });
    const unknown = computeLotBalance(
      singani({
        distillations: [
          singani().distillations[0],
          { ...second, heartAbvPercent: null },
        ],
      }),
    );
    expect(unknown.distillation).toMatchObject({
      heartAbvPercent: null,
      pureAlcoholLiters: null,
    });
  });
});

describe('proyección de botellas (S-19)', () => {
  it('singani: corazón × grado ÷ grado previsto × (1 − merma) ÷ formato', () => {
    expect(projectBottles(singani())).toEqual({
      bottles: 2850,
      basis: 'DISTILLATE',
    });
  });

  it('singani sin destilación cerrada, sin grado previsto o sin formato: la estimación declarada', () => {
    const open = { ...singani().distillations[0], closed: false };
    expect(projectBottles(singani({ distillations: [open] }))).toEqual({
      bottles: 3000,
      basis: 'DECLARED',
    });
    expect(projectBottles(singani({ targetAbvPercent: null })).basis).toBe(
      'DECLARED',
    );
    expect(projectBottles(singani({ plannedFormatCl: null })).basis).toBe(
      'DECLARED',
    );
    expect(
      projectBottles(
        singani({ plannedFormatCl: null, estimatedBottles: null }),
      ),
    ).toEqual({ bottles: null, basis: 'DECLARED' });
  });

  it('vino: desde la crianza; si no hay, desde el vino base o el mosto del tanque', () => {
    expect(projectBottles(wine())).toEqual({
      bottles: 2470, // 1950 L × 0,95 ÷ 0,75 L
      basis: 'BASE_WINE',
    });
    expect(projectBottles(wine({ agings: [] }))).toEqual({
      bottles: 2533, // 2000 L finales × 0,95 ÷ 0,75 L
      basis: 'BASE_WINE',
    });
    const must = [{ ...wine().tanks[0], finalLiters: null }];
    expect(projectBottles(wine({ agings: [], tanks: must }))).toEqual({
      bottles: 2660, // 2100 L de mosto × 0,95 ÷ 0,75 L
      basis: 'MUST',
    });
    expect(projectBottles(wine({ agings: [], tanks: [] }))).toEqual({
      bottles: 2000,
      basis: 'DECLARED',
    });
  });

  it('embotellado: los códigos activos', () => {
    expect(projectBottles(singani({ activeBottles: 2949 }))).toEqual({
      bottles: 2949,
      basis: 'BOTTLED',
    });
  });
});

describe('reporte de producción (contrato O2 §11.4)', () => {
  const bottling = {
    availableLiters: 1500,
    waterDilutionLiters: 750,
    bottledLiters: 2212.5,
    leftoverLiters: 0,
    lossLiters: 37.5,
    lossPercent: 1.67,
    maxLossPercent: 5,
    pureAlcohol: { availableLiters: 900, bottledLiters: 885 },
    maxBottles: 3000,
  };

  it('cifras de una fila: litros, mermas por etapa y rendimientos', () => {
    const input = singani({ bottling, activeBottles: 2950 });
    const figures = productionFigures(input, computeLotBalance(input), 2950);
    expect(figures).toEqual({
      netKg: 18400,
      mustLiters: 12100,
      baseWineLiters: null,
      heartLiters: 1500,
      bottledLiters: 2212.5,
      bottles: 2950,
      lossPercentByStage: {
        fermentation: null,
        transfer: 0,
        distillation: 84.88,
        bottling: 1.67,
      },
      litersPerKg: 0.658,
      bottlesPerTonne: 160.33,
    });
  });

  it('lote sin tanques ni embotellado: todo sin registrar', () => {
    const input = singani({ tanks: [], distillations: [] });
    expect(productionFigures(input, computeLotBalance(input), null)).toEqual({
      netKg: 18400,
      mustLiters: null,
      baseWineLiters: null,
      heartLiters: null,
      bottledLiters: null,
      bottles: null,
      lossPercentByStage: {
        fermentation: null,
        transfer: null,
        distillation: null,
        bottling: null,
      },
      litersPerKg: null,
      bottlesPerTonne: null,
    });
  });

  it('la merma de destilación descuenta también las vinazas y solo mira las cerradas', () => {
    const d = singani().distillations[0];
    expect(distillationLossPercent([{ ...d, vinasseLiters: 10000 }])).toBe(
      2.23,
    );
    expect(distillationLossPercent([{ ...d, closed: false }])).toBeNull();
    expect(distillationLossPercent([{ ...d, discarded: true }])).toBeNull();
  });

  it('totales: sumas y ratios agregados; sin kilos, sin ratios', () => {
    const a = singani({ bottling, activeBottles: 2950 });
    const b = singani();
    const rows = [
      productionFigures(a, computeLotBalance(a), 2950),
      productionFigures(b, computeLotBalance(b), null),
    ];
    expect(productionTotals(rows)).toEqual({
      lots: 2,
      netKg: 36800,
      mustLiters: 24200,
      baseWineLiters: 0,
      heartLiters: 3000,
      bottledLiters: 2212.5,
      bottles: 2950,
      litersPerKg: 0.658,
      bottlesPerTonne: 80.16,
    });
    expect(productionTotals([])).toMatchObject({
      lots: 0,
      netKg: 0,
      litersPerKg: null,
      bottlesPerTonne: null,
    });
  });

  it('CSV: mismas columnas, vacíos sin registrar y celdas seguras para la hoja de cálculo', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(-12.5)).toBe('-12.5');
    expect(csvCell('Singani "Gran Reserva", 2026')).toBe(
      '"Singani ""Gran Reserva"", 2026"',
    );
    // Lo que una hoja de cálculo leería como fórmula lleva un apóstrofo
    expect(csvCell('=HYPERLINK("http://x")')).toBe(
      '"\'=HYPERLINK(""http://x"")"',
    );
    expect(csvCell('+591 lote')).toBe("'+591 lote");
    expect(csvCell('@lote')).toBe("'@lote");

    const input = singani();
    const row: ProductionReportRow = {
      lotId: '6b2f4c1e-0000-4000-8000-000000000001',
      reference: 'CVJ-L2026-004',
      lotCode: null,
      name: '=Singani, "reserva"',
      productType: 'SINGANI',
      harvestYear: 2026,
      stage: 'RESTING',
      ...productionFigures(input, computeLotBalance(input), null),
      formatCl: 75,
      bottlingDate: null,
      labStatus: 'NOT_RECORDED',
    };
    const csv = productionReportCsv([row]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const [header, line, rest] = csv.slice(1).split('\r\n');
    expect(header).toBe(PRODUCTION_REPORT_COLUMNS.join(','));
    expect(line).toBe(
      '6b2f4c1e-0000-4000-8000-000000000001,CVJ-L2026-004,,"\'=Singani, ""reserva""",SINGANI,2026,RESTING,' +
        '18400,12100,,1500,,,75,,0,84.88,,0.658,,,NOT_RECORDED',
    );
    expect(rest).toBe('');
  });
});
