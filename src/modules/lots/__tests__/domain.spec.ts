import {
  CROCKFORD_ALPHABET,
  formatBottleCode,
  generateBottleCode,
  hasValidCheckChar,
  isValidBottleCode,
  luhnMod32CheckChar,
  normalizeBottleCode,
} from '../domain/bottle-code';
import {
  bottlingBalanceViolations,
  computeBottlingBalance,
  BottlingBalanceInput,
} from '../domain/bottling-balance';
import {
  addDays,
  addMonths,
  calendarDay,
  daysBetween,
  laPazDate,
} from '../domain/dates';
import { evaluateDo, normalizeVariety } from '../domain/do-evaluation';
import {
  computeLabConformity,
  methanolToAnhydrous,
  normalizeUnit,
} from '../domain/lab-conformity';
import { agingLock, nextLock, restLock } from '../domain/locks';
import { buildLotRules, parseLotRules, LotRules } from '../domain/lot-rules';
import { deriveLotStage } from '../domain/lot-stage';

function rules(
  overrides: Partial<Record<string, unknown>> = {},
  exceptions: string[] = [],
): LotRules {
  return buildLotRules(
    {
      wineryId: 'w',
      takenAt: '2026-09-27T12:00:00.000Z',
      values: {
        'trazabilidad.singani.altitudMinimaMsnm': 1600,
        'trazabilidad.singani.variedadesExigidas': ['Moscatel de Alejandría'],
        'trazabilidad.singani.reposoMinimoDias': 180,
        'trazabilidad.vino.crianzaMinimaMeses': 0,
        'trazabilidad.fitosanitario.exigirAprobado': true,
        'trazabilidad.embotellado.mermaMaximaPorcentaje': 5,
        'trazabilidad.laboratorio.limites': {
          metanol: { max: 200, unidad: 'mg/100 ml a.a.' },
          cobre: { max: 6, unidad: 'mg/l' },
          acidezVolatil: { max: 1.2, unidad: 'g/l' },
        },
        ...overrides,
      } as never,
      sources: {},
      legalExceptions: exceptions,
    },
    'LOT_CREATION',
  );
}

describe('códigos de botella (§7.1)', () => {
  it('generan 8 caracteres Crockford con un control Luhn mod 32 válido', () => {
    for (let i = 0; i < 500; i++) {
      const code = generateBottleCode();
      expect(code).toHaveLength(8);
      expect([...code].every((c) => CROCKFORD_ALPHABET.includes(c))).toBe(true);
      expect(isValidBottleCode(code)).toBe(true);
    }
  });

  it('detectan cualquier error de un carácter', () => {
    const code = '7M2Q9XA';
    const full = code + luhnMod32CheckChar(code);
    for (let pos = 0; pos < full.length; pos++) {
      for (const c of CROCKFORD_ALPHABET) {
        if (c === full[pos]) continue;
        const typo = full.slice(0, pos) + c + full.slice(pos + 1);
        expect(hasValidCheckChar(typo)).toBe(false);
      }
    }
  });

  it('normalizan lo que se teclea (O → 0, I/L → 1, sin espacios ni guiones)', () => {
    expect(normalizeBottleCode('k7m2-q9xa')).toBe('K7M2Q9XA');
    expect(normalizeBottleCode(' OIL 0-1 ')).toBe('01101');
    expect(formatBottleCode('K7M2Q9XA')).toBe('K7M2-Q9XA');
    expect(isValidBottleCode('K7M2Q9')).toBe(false);
    expect(isValidBottleCode('UUUUUUUU')).toBe(false);
  });
});

describe('fechas de producción en America/La_Paz (§0)', () => {
  it('toma el día de La Paz de un instante (UTC-4)', () => {
    expect(laPazDate(new Date('2026-09-28T03:30:00Z'))).toBe('2026-09-27');
    expect(calendarDay('2026-09-27')).toBe('2026-09-27');
    expect(calendarDay('2026-09-28T02:00:00Z')).toBe('2026-09-27');
  });

  it('suma meses de calendario (fin de mes) y días', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2025-11-03', 12)).toBe('2026-11-03');
    expect(addDays('2026-04-16', 180)).toBe('2026-10-13');
    expect(daysBetween('2026-09-27', '2026-10-13')).toBe(16);
  });
});

describe('D.O. calculada (§3.1, EA-03)', () => {
  const parcel = {
    id: 't1',
    altitudeMasl: 2350,
    varietyName: 'Moscatel de Alejandria',
  };

  it('compara la cepa sin mayúsculas, tildes ni espacios repetidos', () => {
    expect(normalizeVariety('  MOSCATEL  de Alejandría ')).toBe(
      normalizeVariety('moscatel de alejandria'),
    );
    const r = rules();
    expect(
      evaluateDo(
        [parcel],
        {
          minAltitudeMasl: 1600,
          requiredVarieties: r.singani.requiredVarieties,
          legalExceptions: [],
        },
        'LOT_SNAPSHOT',
      ).status,
    ).toBe('ELIGIBLE');
  });

  it('no es apta bajo la altitud mínima o con otra cepa (un check por regla)', () => {
    const evaluation = evaluateDo(
      [{ id: 't2', altitudeMasl: 1540, varietyName: 'Tannat' }],
      {
        minAltitudeMasl: 1600,
        requiredVarieties: ['Moscatel de Alejandría'],
        legalExceptions: [],
      },
      'LOT_SNAPSHOT',
    );
    expect(evaluation.status).toBe('NOT_ELIGIBLE');
    expect(evaluation.checks.filter((c) => !c.pass).map((c) => c.rule)).toEqual(
      ['ALTITUDE', 'VARIETY'],
    );
  });

  it('ELIGIBLE_BY_EXCEPTION si cumple solo por un valor bajo el mínimo legal autorizado (A-31)', () => {
    const evaluation = evaluateDo(
      [{ id: 't3', altitudeMasl: 1550, varietyName: 'Moscatel de Alejandría' }],
      {
        minAltitudeMasl: 1500,
        requiredVarieties: ['Moscatel de Alejandría'],
        legalExceptions: ['trazabilidad.singani.altitudMinimaMsnm'],
      },
      'EFFECTIVE_SETTINGS',
    );
    expect(evaluation.status).toBe('ELIGIBLE_BY_EXCEPTION');
  });

  it('sin parcelas que evaluar → NOT_APPLICABLE', () => {
    expect(
      evaluateDo(
        [],
        { minAltitudeMasl: 1600, requiredVarieties: [], legalExceptions: [] },
        'LOT_SNAPSHOT',
      ).status,
    ).toBe('NOT_APPLICABLE');
  });
});

describe('conformidad de laboratorio con unidades (§8, EA-08)', () => {
  const limits = rules().lab.limits;

  it('convierte el metanol de mg/L de producto a mg/100 mL a.a.', () => {
    expect(methanolToAnhydrous(48, 40)).toBe(12);
    expect(methanolToAnhydrous(48, 0)).toBeNull();
    expect(normalizeUnit('mg/100 ml a.a.')).toBe('mg/100ml a.a.');
    expect(normalizeUnit('mg/l')).toBe('mg/l');
  });

  it('singani conforme con metanol, cobre y grado dentro de sus límites', () => {
    const c = computeLabConformity({
      productType: 'SINGANI',
      values: {
        actualAlcoholAbv: 40.05,
        volatileAcidityAceticGl: 0.22,
        methanolMg100mlAa: 12,
        copperContentMgL: 0.02,
      },
      limits,
      labeledAbv: 40,
      rulesTakenAt: 't',
    });
    expect(c.status).toBe('CONFORMING');
    expect(c.warnings).toEqual([]);
  });

  it('falta un parámetro exigido → INCOMPLETE (nunca conforme por omisión)', () => {
    const c = computeLabConformity({
      productType: 'SINGANI',
      values: {
        actualAlcoholAbv: 40,
        volatileAcidityAceticGl: 0.2,
        methanolMg100mlAa: null,
        copperContentMgL: 0.02,
      },
      limits,
      labeledAbv: 40,
      rulesTakenAt: 't',
    });
    expect(c.status).toBe('INCOMPLETE');
    expect(c.checks.find((x) => x.parameter === 'metanol')?.result).toBe(
      'MISSING',
    );
  });

  it('un parámetro fuera de su límite → NON_CONFORMING; aviso por grado distinto del etiquetado', () => {
    const c = computeLabConformity({
      productType: 'WINE',
      values: {
        actualAlcoholAbv: 13.1,
        volatileAcidityAceticGl: 1.4,
        methanolMg100mlAa: null,
        copperContentMgL: null,
      },
      limits,
      labeledAbv: 14,
      rulesTakenAt: 't',
    });
    expect(c.status).toBe('NON_CONFORMING');
    expect(c.warnings.map((w) => w.code)).toEqual(['LAB_ABV_DEVIATION']);
  });

  it('unidad del límite desconocida → UNIT_UNKNOWN e INCOMPLETE', () => {
    const c = computeLabConformity({
      productType: 'SINGANI',
      values: {
        actualAlcoholAbv: 40,
        volatileAcidityAceticGl: 0.2,
        methanolMg100mlAa: 12,
        copperContentMgL: 0.02,
      },
      limits: { ...limits, cobre: { max: 6, unidad: 'ppm?' } },
      labeledAbv: 40,
      rulesTakenAt: 't',
    });
    expect(c.status).toBe('INCOMPLETE');
    expect(c.checks.find((x) => x.parameter === 'cobre')?.result).toBe(
      'UNIT_UNKNOWN',
    );
  });
});

describe('balance del embotellado (§6.2, EA-02)', () => {
  const base: BottlingBalanceInput = {
    productType: 'SINGANI',
    availableLiters: 1500,
    waterDilutionLiters: 750,
    bottles: 2950,
    formatCl: 75,
    leftoverLiters: 0,
    maxLossPercent: 5,
    finalAbv: 40,
    pureAlcoholAvailableLiters: 900,
  };

  it('el caso Singani Gran Reserva 2026 cumple (2.212,5 L; merma 1,7 %; 885 ≤ 900 L)', () => {
    const balance = computeBottlingBalance(base);
    expect(balance).toMatchObject({
      bottledLiters: 2212.5,
      lossLiters: 37.5,
      lossPercent: 1.67,
      pureAlcohol: { availableLiters: 900, bottledLiters: 885 },
      maxBottles: 3000,
    });
    expect(bottlingBalanceViolations(base, balance)).toEqual([]);
  });

  it('más botellas que litros → TRC_BOTTLING_EXCEEDS_VOLUME con maxBottles', () => {
    const input = { ...base, bottles: 3100 };
    const [v] = bottlingBalanceViolations(input, computeBottlingBalance(input));
    expect(v.code).toBe('TRC_BOTTLING_EXCEEDS_VOLUME');
    expect(v.expected).toBe(3000);
  });

  it('merma sobre la tolerada → TRC_BOTTLING_LOSS_ABOVE_TOLERANCE', () => {
    const input = { ...base, bottles: 2700 };
    expect(
      bottlingBalanceViolations(input, computeBottlingBalance(input)).map(
        (v) => v.code,
      ),
    ).toEqual(['TRC_BOTTLING_LOSS_ABOVE_TOLERANCE']);
  });

  it('más agua para inflar botellas → TRC_ALCOHOL_BALANCE_EXCEEDED', () => {
    const input = {
      ...base,
      waterDilutionLiters: 1100,
      bottles: 3400,
      finalAbv: 40,
    };
    expect(
      bottlingBalanceViolations(input, computeBottlingBalance(input)).map(
        (v) => v.code,
      ),
    ).toContain('TRC_ALCOHOL_BALANCE_EXCEEDED');
  });

  it('agua en un vino → TRC_DILUTION_NOT_ALLOWED', () => {
    const input = {
      ...base,
      productType: 'WINE' as const,
      waterDilutionLiters: 10,
      bottles: 2010,
      pureAlcoholAvailableLiters: null,
    };
    expect(
      bottlingBalanceViolations(input, computeBottlingBalance(input)).map(
        (v) => v.code,
      ),
    ).toContain('TRC_DILUTION_NOT_ALLOWED');
  });
});

describe('candados con la instantánea (§5.3)', () => {
  it('reposo: fin de la destilación + mínimo de la instantánea, con días restantes', () => {
    const lock = restLock(
      { id: 'p1', processEndDate: '2026-04-16', storedUnlockDate: null },
      rules(),
      '2026-09-27',
    );
    expect(lock).toMatchObject({
      kind: 'REST',
      unlockDate: '2026-10-13',
      released: false,
      daysRemaining: 16,
    });
    expect(
      restLock(
        { id: 'p2', processEndDate: null, storedUnlockDate: null },
        rules(),
        '2026-09-27',
      ),
    ).toBeNull();
  });

  it('la instantánea manda: un reposo mínimo mayor alarga el candado', () => {
    const lock = restLock(
      { id: 'p1', processEndDate: '2026-01-01', storedUnlockDate: null },
      rules({ 'trazabilidad.singani.reposoMinimoDias': 365 }),
      '2026-09-27',
    );
    expect(lock?.unlockDate).toBe('2027-01-01');
  });

  it('crianza: nunca menos que el mínimo; manda la fecha más tardía con la guardada', () => {
    const lock = agingLock(
      {
        id: 'a1',
        startDate: '2025-11-03',
        plannedMonths: 6,
        storedUnlockDate: '2026-11-03',
      },
      rules({ 'trazabilidad.vino.crianzaMinimaMeses': 8 }),
      '2026-09-27',
    );
    expect(lock.unlockDate).toBe('2026-11-03');
    expect(lock.rule).toMatchObject({ minimum: 8, applied: 8, unit: 'meses' });
    expect(nextLock([lock])).toBe(lock);
  });
});

describe('instantánea y etapa del lote', () => {
  it('la instantánea se conserva al leerla de la base', () => {
    const original = rules({}, ['trazabilidad.singani.altitudMinimaMsnm']);
    const parsed = parseLotRules(JSON.parse(JSON.stringify(original)));
    expect(parsed).toEqual(original);
  });

  it('la etapa sale de los registros (§2.2)', () => {
    const empty = {
      discarded: false,
      dossierClosed: false,
      productType: null,
      harvestStatuses: [],
      tanks: [],
      agings: [],
      distillations: [],
      bottled: false,
    };
    expect(deriveLotStage(empty)).toBe('ORIGIN');
    expect(
      deriveLotStage({ ...empty, harvestStatuses: ['REJECTED', 'REJECTED'] }),
    ).toBe('REJECTED');
    expect(
      deriveLotStage({
        ...empty,
        harvestStatuses: ['APPROVED'],
        tanks: [{ status: 'FERMENTING' }],
      }),
    ).toBe('FERMENTING');
    expect(
      deriveLotStage({
        ...empty,
        productType: 'SINGANI',
        distillations: [{ closed: false, discarded: false }],
      }),
    ).toBe('DISTILLING');
    expect(
      deriveLotStage({
        ...empty,
        productType: 'SINGANI',
        distillations: [{ closed: true, discarded: false }],
      }),
    ).toBe('RESTING');
    expect(deriveLotStage({ ...empty, bottled: true })).toBe('BOTTLED');
    expect(deriveLotStage({ ...empty, bottled: true, discarded: true })).toBe(
      'DISCARDED',
    );
  });
});
