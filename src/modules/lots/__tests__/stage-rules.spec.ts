import {
  canCorrect,
  CORRECTABLE_FIELDS,
  parseCorrectionChanges,
  sameValue,
  toChangeValue,
  VOIDABLE_TARGETS,
} from '../domain/corrections';
import {
  BOTTLED_RULE_CODES,
  compareIntegrity,
  IntegrityLot,
  lotIntegrityViolations,
  violationKey,
} from '../domain/lot-integrity';
import type { LotRules } from '../domain/lot-rules';
import { cutsTotal, massBalanceViolation } from '../domain/mass-balance';
import {
  parseTankTransitions,
  TANK_TRANSITIONS,
  tankTransitionHistory,
  tankTransitionViolation,
  tankVolumes,
} from '../domain/tank-transitions';

const rules: LotRules = {
  takenAt: '2026-01-01T00:00:00.000Z',
  origin: 'LOT_CREATION',
  singani: {
    minAltitudeMasl: 1600,
    requiredVarieties: ['Moscatel de Alejandría'],
    minRestDays: 180,
  },
  wine: { minAgingMonths: 6 },
  phytosanitary: { requireApproved: true },
  bottling: { maxLossPercent: 5 },
  lab: { limits: {} },
  legalExceptions: [],
  sources: {},
  values: {},
};

const codes = (details: { code?: string }[]): string[] =>
  details.map((d) => d.code as string);

describe('transiciones del tanque (contrato O2 §4.2)', () => {
  it('cada acción solo vale desde su estado de partida', () => {
    expect(TANK_TRANSITIONS).toEqual({
      start: { from: 'FILLING', to: 'FERMENTING' },
      complete: { from: 'FERMENTING', to: 'COMPLETED' },
      clean: { from: 'TRANSFERRED', to: 'CLEANED' },
    });
    expect(tankTransitionViolation('start', 'FILLING', 'TK-01')).toBeNull();
    expect(
      tankTransitionViolation('complete', 'FERMENTING', 'TK-01'),
    ).toBeNull();
    expect(tankTransitionViolation('clean', 'TRANSFERRED', 'TK-01')).toBeNull();
  });

  it('una transición no válida lleva `meta: { from, to }`', () => {
    const skipped = tankTransitionViolation('complete', 'FILLING', 'TK-01');
    expect(skipped).toMatchObject({
      code: 'TRC_TANK_INVALID_TRANSITION',
      meta: { from: 'FILLING', to: 'COMPLETED' },
    });
    expect(
      tankTransitionViolation('clean', 'COMPLETED', 'TK-01')?.meta,
    ).toMatchObject({ from: 'COMPLETED', to: 'CLEANED' });
    expect(
      tankTransitionViolation('start', 'FERMENTING', 'TK-01')?.meta,
    ).toMatchObject({ from: 'FERMENTING', to: 'FERMENTING' });
    expect(tankTransitionViolation('clean', 'CLEANED', 'TK-01')).not.toBeNull();
  });

  it('el historial empieza por el llenado y sigue con lo registrado', () => {
    const startDate = new Date('2026-03-01T14:00:00.000Z');
    const filling = tankTransitionHistory({
      status: 'COMPLETED',
      startDate,
      createdByMembershipId: 'm-1',
      transitionLog: [
        { status: 'FERMENTING', at: '2026-03-02T10:00:00.000Z' },
        {
          status: 'COMPLETED',
          at: '2026-03-20T16:00:00.000Z',
          byMembershipId: 'm-2',
        },
        { status: 'DESCONOCIDO', at: '2026-03-21T16:00:00.000Z' },
        'basura',
      ],
    });
    expect(filling.map((t) => t.status)).toEqual([
      'FILLING',
      'FERMENTING',
      'COMPLETED',
    ]);
    expect(filling[0]).toEqual({
      status: 'FILLING',
      at: startDate.toISOString(),
      byMembershipId: 'm-1',
    });
    expect(filling[1].byMembershipId).toBeNull();

    // Nació fermentando (`startFermentation`): no hubo `start`
    const born = tankTransitionHistory({
      status: 'FERMENTING',
      startDate,
      createdByMembershipId: null,
      transitionLog: [],
    });
    expect(born).toEqual([
      {
        status: 'FERMENTING',
        at: startDate.toISOString(),
        byMembershipId: null,
      },
    ]);
    expect(parseTankTransitions(null)).toEqual([]);
  });

  it('lo que queda en el tanque y la merma de trasiego', () => {
    expect(
      tankVolumes({ status: 'COMPLETED', liters: 2000, drawnLiters: 500 }),
    ).toEqual({ availableLiters: 1500, transferLossLiters: null });
    expect(
      tankVolumes({ status: 'TRANSFERRED', liters: 2000, drawnLiters: 1900 }),
    ).toEqual({ availableLiters: 0, transferLossLiters: 100 });
    expect(
      tankVolumes({ status: 'CLEANED', liters: 2000, drawnLiters: 2000 }),
    ).toEqual({ availableLiters: 0, transferLossLiters: 0 });
    expect(
      tankVolumes({ status: 'FERMENTING', liters: null, drawnLiters: 0 }),
    ).toEqual({ availableLiters: null, transferLossLiters: null });
    // Nunca negativo, aunque los datos anteriores estén descuadrados
    expect(
      tankVolumes({ status: 'COMPLETED', liters: 100, drawnLiters: 150 })
        .availableLiters,
    ).toBe(0);
  });
});

describe('balance de masa de la destilación (§5.2)', () => {
  it('cabezas + corazón + colas (+ vinaza) ≤ entrada', () => {
    const cuts = { headsLiters: 120, heartLiters: 1500, tailsLiters: 210 };
    expect(cutsTotal(cuts)).toBe(1830);
    expect(massBalanceViolation(12100, cuts)).toBeNull();
    expect(
      massBalanceViolation(12100, { ...cuts, vinasseLiters: 10270 }),
    ).toBeNull();
    const over = massBalanceViolation(12100, {
      ...cuts,
      vinasseLiters: 10270.5,
    });
    expect(over).toMatchObject({
      code: 'TRC_MASS_BALANCE_EXCEEDED',
      expected: 12100,
      actual: 12100.5,
      meta: { inputLiters: 12100, outputLiters: 12100.5 },
    });
  });
});

describe('correcciones: lista cerrada de campos (§9)', () => {
  it('acepta los campos corregibles y normaliza sus valores', () => {
    const parsed = parseCorrectionChanges('HARVEST_BATCH', {
      grossWeightKg: 18650.5,
      intakeDate: '2026-03-12T15:00:00.000Z',
      notes: '  ticket reemitido  ',
      temperatureAtIntakeC: null,
    });
    expect(parsed.notCorrectable).toEqual([]);
    expect(parsed.invalid).toEqual([]);
    expect(parsed.values).toEqual({
      grossWeightKg: 18650.5,
      // Un instante se lee como su día de calendario en America/La_Paz
      intakeDate: '2026-03-12',
      notes: 'ticket reemitido',
      temperatureAtIntakeC: null,
    });
  });

  it('un campo fuera de la lista → TRC_CORRECTION_FIELD_NOT_CORRECTABLE', () => {
    const parsed = parseCorrectionChanges('BOTTLING', {
      totalBottlesPackaged: 5000,
      lotCode: 'CVJ-2026-SINGANI-999',
      finalAlcoholAbv: 40,
    });
    expect(codes(parsed.notCorrectable)).toEqual([
      'TRC_CORRECTION_FIELD_NOT_CORRECTABLE',
      'TRC_CORRECTION_FIELD_NOT_CORRECTABLE',
    ]);
    expect(parsed.notCorrectable[0]).toMatchObject({
      field: 'changes.totalBottlesPackaged',
      meta: { field: 'totalBottlesPackaged' },
    });
    expect(parsed.values).toEqual({ finalAlcoholAbv: 40 });
    // Ni el lote, ni el tipo de producto, ni los códigos son corregibles
    for (const fields of Object.values(CORRECTABLE_FIELDS)) {
      for (const forbidden of [
        'lotId',
        'productType',
        'lotCode',
        'internationalLotCode',
        'totalBottlesPackaged',
        'harvestBatchCode',
      ]) {
        expect(Object.keys(fields)).not.toContain(forbidden);
      }
    }
  });

  it('un dictamen no se enmienda: solo se anula', () => {
    expect(Object.keys(CORRECTABLE_FIELDS.PHYTO_DECISION)).toEqual([]);
    expect(VOIDABLE_TARGETS).toEqual([
      'MATURITY_ANALYSIS',
      'PHYTO_DECISION',
      'FERMENTATION_LOG',
      'TREATMENT',
      'LAB_ANALYSIS',
    ]);
    const parsed = parseCorrectionChanges('PHYTO_DECISION', {
      decision: 'APPROVED',
    });
    expect(parsed.notCorrectable).toHaveLength(1);
  });

  it('valores con tipo o rango inválido → detalle por campo', () => {
    const parsed = parseCorrectionChanges('WINE_AGING', {
      plannedMonths: 6.5,
      volumeLiters: 0,
      startDate: 'ayer',
    });
    expect(parsed.invalid.map((d) => d.field)).toEqual([
      'changes.plannedMonths',
      'changes.volumeLiters',
      'changes.startDate',
    ]);
    expect(
      parseCorrectionChanges('MATURITY_ANALYSIS', { ph: 7, brixDegrees: '22' })
        .invalid,
    ).toHaveLength(2);
    expect(
      parseCorrectionChanges('HARVEST_BATCH', { grossWeightKg: null }).invalid,
    ).toHaveLength(1);
  });

  it('el remanente del embotellado es un objeto o null', () => {
    const ok = parseCorrectionChanges('BOTTLING', {
      leftover: { liters: 12.5, disposition: 'RETAINED', notes: ' barrica ' },
    });
    expect(ok.values.leftover).toEqual({
      liters: 12.5,
      disposition: 'RETAINED',
      notes: 'barrica',
    });
    expect(
      parseCorrectionChanges('BOTTLING', { leftover: null }).values.leftover,
    ).toBeNull();
    expect(
      parseCorrectionChanges('BOTTLING', {
        leftover: { liters: -1, disposition: 'RETAINED' },
      }).invalid,
    ).toHaveLength(1);
    expect(
      parseCorrectionChanges('BOTTLING', {
        leftover: { liters: 1, disposition: 'VENDIDO' },
      }).invalid,
    ).toHaveLength(1);
  });

  it('S-17: corrige quien puede crear el registro', () => {
    expect(canCorrect('HARVEST_BATCH', 'OPERATOR')).toBe(true);
    expect(canCorrect('FERMENTATION_LOG', 'OPERATOR')).toBe(true);
    expect(canCorrect('PHYTO_DECISION', 'AGRONOMIST')).toBe(true);
    expect(canCorrect('PHYTO_DECISION', 'OPERATOR')).toBe(false);
    expect(canCorrect('WINE_AGING', 'AGRONOMIST')).toBe(false);
    expect(canCorrect('BOTTLING', 'ENOLOGIST')).toBe(true);
    expect(canCorrect('LAB_ANALYSIS', 'ACCOUNTANT')).toBe(false);
    expect(canCorrect('TERROIR', 'ENOLOGIST')).toBe(false);
    expect(canCorrect('TERROIR', null)).toBe(false);
  });

  it('compara valores vigentes y nuevos', () => {
    const decimal = { toNumber: () => 18400 };
    expect(toChangeValue(decimal)).toBe(18400);
    expect(toChangeValue(new Date('2026-03-12T00:00:00.000Z'))).toBe(
      '2026-03-12T00:00:00.000Z',
    );
    expect(sameValue(decimal, 18400)).toBe(true);
    expect(sameValue(decimal, 18400.001)).toBe(false);
    expect(sameValue(null, null)).toBe(true);
    expect(sameValue('2026-03-12', '2026-03-12')).toBe(true);
    expect(sameValue(null, 'x')).toBe(false);
  });
});

describe('revisión de integridad del lote (§9: candados, balances, D.O.)', () => {
  const eligible = {
    id: 't-1',
    parcelName: 'Cinti 02',
    altitudeMasl: 2350,
    varietyName: 'Moscatel de Alejandría',
  };
  const base = (): IntegrityLot => ({
    productType: 'SINGANI',
    rules,
    harvests: [
      {
        id: 'h-1',
        code: 'HARV-2026-CINTI-001',
        netKg: 18400,
        phytoStatus: 'APPROVED',
        inputsKg: 18400,
        terroir: eligible,
      },
    ],
    tanks: [
      {
        id: 'tk-1',
        tankCode: 'TK-01',
        capacityLiters: 15000,
        filledLiters: 12100,
        finalLiters: 12100,
        drawnLiters: 12100,
      },
    ],
    agings: [],
    distillations: [
      {
        id: 'p-1',
        inputLiters: 12100,
        headsLiters: 120,
        heartLiters: 1500,
        tailsLiters: 210,
        vinasseLiters: null,
        heartAbvPercent: 60,
        processEndDate: '2026-01-10',
        discarded: false,
        bottled: true,
      },
    ],
    bottling: {
      id: 'b-1',
      bottlingDay: '2026-08-01',
      bottles: 2950,
      formatCl: 75,
      finalAbv: 40,
      waterLiters: 750,
      leftoverLiters: 0,
    },
  });

  it('el caso "Singani Gran Reserva 2026" cumple todas las reglas', () => {
    expect(lotIntegrityViolations(base())).toEqual([]);
  });

  it('detecta cada regla incumplida con su código', () => {
    const lot = base();
    lot.harvests[0].terroir = { ...eligible, altitudeMasl: 1540 };
    lot.harvests[0].phytoStatus = 'QUARANTINE';
    lot.harvests[0].inputsKg = 19000;
    lot.tanks[0].filledLiters = 16000;
    lot.tanks[0].finalLiters = 16500;
    lot.tanks[0].drawnLiters = 17000;
    lot.distillations[0].heartLiters = 12000;
    expect(new Set(codes(lotIntegrityViolations(lot)))).toEqual(
      new Set([
        'TRC_DO_NOT_ELIGIBLE',
        'TRC_PHYTO_NOT_APPROVED',
        'TRC_VOLUME_EXCEEDS_AVAILABLE',
        'TRC_TANK_CAPACITY_EXCEEDED',
        'TRC_MASS_BALANCE_EXCEEDED',
        // Con 12.000 L de corazón sobra producto: merma muy por encima
        'TRC_BOTTLING_LOSS_ABOVE_TOLERANCE',
      ]),
    );
  });

  it('candado a la fecha del embotellado, con la instantánea del lote', () => {
    const lot = base();
    lot.distillations[0].processEndDate = '2026-03-01';
    const [lock] = lotIntegrityViolations(lot);
    expect(lock).toMatchObject({
      code: 'TRC_LOCK_NOT_RELEASED',
      rule: 'trazabilidad.singani.reposoMinimoDias',
      expected: '2026-08-28',
      actual: '2026-08-01',
      meta: { sourceId: 'p-1', kind: 'REST', daysRemaining: 27 },
    });
    // Con otra instantánea (90 días), el mismo lote cumple
    expect(
      lotIntegrityViolations({
        ...lot,
        rules: { ...rules, singani: { ...rules.singani, minRestDays: 90 } },
      }),
    ).toEqual([]);
  });

  it('balance de alcohol y de volumen del embotellado ya hecho', () => {
    const weak = base();
    weak.distillations[0].heartAbvPercent = 55;
    expect(codes(lotIntegrityViolations(weak))).toEqual([
      'TRC_ALCOHOL_BALANCE_EXCEEDED',
    ]);
    const short = base();
    short.distillations[0].heartLiters = 1000;
    expect(codes(lotIntegrityViolations(short))).toContain(
      'TRC_BOTTLING_EXCEEDS_VOLUME',
    );
  });

  it('vino: crianza bajo el mínimo, agua y fuentes abiertas tras embotellar', () => {
    const lot: IntegrityLot = {
      ...base(),
      productType: 'WINE',
      distillations: [],
      agings: [
        {
          id: 'a-1',
          startDate: '2026-01-01',
          plannedMonths: 3,
          storedUnlockDate: null,
          volumeLiters: 1900,
          discarded: false,
          bottled: true,
        },
        {
          id: 'a-2',
          startDate: '2026-01-01',
          plannedMonths: 6,
          storedUnlockDate: null,
          volumeLiters: 500,
          discarded: false,
          bottled: false,
        },
      ],
      bottling: {
        id: 'b-1',
        bottlingDay: '2026-08-01',
        bottles: 2500,
        formatCl: 75,
        finalAbv: 13.5,
        waterLiters: 10,
        leftoverLiters: 0,
      },
    };
    expect(new Set(codes(lotIntegrityViolations(lot)))).toEqual(
      new Set([
        'TRC_AGING_BELOW_MINIMUM',
        'TRC_BOTTLING_SOURCES_PENDING',
        'TRC_DILUTION_NOT_ALLOWED',
      ]),
    );
    // Una crianza descartada no cuenta ni como fuente ni como pendiente
    lot.agings[1].discarded = true;
    expect(codes(lotIntegrityViolations(lot))).not.toContain(
      'TRC_BOTTLING_SOURCES_PENDING',
    );
    // Con un registro anterior a la Ola 2 manda la fecha de candado más tardía
    lot.agings[0].plannedMonths = 6;
    expect(codes(lotIntegrityViolations(lot))).not.toContain(
      'TRC_LOCK_NOT_RELEASED',
    );
    lot.agings[0].storedUnlockDate = '2026-09-15';
    expect(codes(lotIntegrityViolations(lot))).toContain(
      'TRC_LOCK_NOT_RELEASED',
    );
  });

  it('un lote sin embotellar no evalúa las reglas del embotellado', () => {
    const lot = base();
    lot.bottling = null;
    lot.distillations[0].bottled = false;
    lot.distillations[0].processEndDate = null;
    expect(lotIntegrityViolations(lot)).toEqual([]);
  });

  it('compara antes y después: lo que se rechaza, lo que queda como incidencia y lo que se resuelve', () => {
    const before = base();
    before.distillations[0].processEndDate = '2026-03-01'; // candado sin cumplir
    const after = base();
    after.distillations[0].heartAbvPercent = 55; // alcohol: embotellado ya hecho
    after.tanks[0].finalLiters = 13000; // final > llenado: se rechaza
    const comparison = compareIntegrity(
      lotIntegrityViolations(before),
      lotIntegrityViolations(after),
    );
    expect(codes(comparison.rejected)).toEqual([
      'TRC_VOLUME_EXCEEDS_AVAILABLE',
    ]);
    expect(codes(comparison.recorded)).toEqual([
      'TRC_ALCOHOL_BALANCE_EXCEEDED',
    ]);
    expect(comparison.clearedCodes).toContain('TRC_LOCK_NOT_RELEASED');
    expect(comparison.clearedCodes).not.toContain(
      'TRC_ALCOHOL_BALANCE_EXCEEDED',
    );
    expect(BOTTLED_RULE_CODES).toContain('TRC_ALCOHOL_BALANCE_EXCEEDED');
  });

  it('una violación que ya existía no se atribuye a la corrección', () => {
    const lot = base();
    lot.tanks[0].drawnLiters = 13000;
    const violations = lotIntegrityViolations(lot);
    const comparison = compareIntegrity(violations, violations);
    expect(comparison.rejected).toEqual([]);
    expect(comparison.recorded).toEqual([]);
    // Lo que no se incumplía antes tampoco se da por resuelto
    expect(comparison.clearedCodes).toEqual([]);
    expect(compareIntegrity([], []).clearedCodes).toEqual([]);
    expect(violationKey(violations[0])).toBe(
      'TRC_VOLUME_EXCEEDS_AVAILABLE:tk-1:TRANSFERS',
    );
  });
});
