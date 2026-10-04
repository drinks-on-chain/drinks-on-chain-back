import type { FixtureLotEvent, MockFixtures } from './fixtures';

/**
 * Correcciones de realismo de la semilla: datos de los fixtures de
 * `@drinks-on-chain/mocks` que incumplen las reglas de la trazabilidad
 * confiable (contrato O2). No se falsea nada para que "pase": se corrige lo
 * físicamente imposible y se deja constancia aquí, para que los mocks adopten
 * lo mismo. Los fixtures copiados (`pnpm seed:sync`) no se editan: la
 * corrección se aplica al cargarlos.
 *
 * Las cuatro de la apertura de la Ola 2 (agua de CVJ-2026-SINGANI-002, la
 * segunda destilación de TK-02, el tanque TK-07 y la crianza de
 * CVJ-2026-WINE-003) ya están en los mocks 0.5.0. Estas son las del cierre H2.
 */
export interface SeedCorrection {
  id: string;
  what: string;
  reason: string;
}

/** Tanques sin mosto (0 L de 0 kg) que los mocks usan como ejemplo de `CLEANED`. */
export const EMPTY_TANK_IDS: readonly string[] = [
  '04e8d15f-24ff-5943-83db-6f915387071c', // TK-06 (Altos)
  'c66f62ff-e355-5e2c-8a47-1ac5282b77b2', // TK-09 (Cinti Viejo)
  '75d30fdf-eff5-596b-a2c3-d0d04db104ae', // TK-RED-04 (Altos)
];
/** TK-08 de Cinti Viejo: su destilación se llevó los 6.300 L. */
const TK_08 = 'd78d6307-f96b-533b-8f6e-710f6533bb42';
/** TK-01 de Cinti Viejo: lote embotellado; queda como el ejemplo de `CLEANED`. */
const TK_01 = 'd4e37fed-41e1-5399-9b50-e8263a6ca797';
const TK_01_CLEANED_AT = '2025-05-26T14:00:00Z';

export const SEED_CORRECTIONS: readonly SeedCorrection[] = [
  {
    id: 'tanques-vacios',
    what: 'Se retiran los tanques TK-06, TK-09 y TK-RED-04 (CLEANED, 0 L de 0 kg) y sus eventos',
    reason:
      'Un tanque se llena con mosto (volumen y kilos mayores que cero) y TK-06 estaba fechado el 05-01-2026, dos meses antes del pesaje del que decía salir (09-03-2026): la cronología del lote es pesaje → tanque',
  },
  {
    id: TK_08,
    what: 'Tanque TK-08 (lote CVJ-L2026-001): COMPLETED → TRANSFERRED',
    reason:
      'Su destilación del 10-09-2026 se llevó los 6.300 L: un tanque pasa a TRANSFERRED al agotarse su volumen (contrato O2 §4.2)',
  },
  {
    id: TK_01,
    what: 'Tanque TK-01 de Cinti Viejo (lote CVJ-2026-SINGANI-001): TRANSFERRED → CLEANED el 26-05-2025',
    reason:
      'Ejemplo real del estado CLEANED en lugar de los tanques vacíos retirados: el tanque se limpió al terminar su destilación (25-05-2025) y su código queda libre (S-7)',
  },
];

/** Fixtures con las correcciones aplicadas (no modifica los originales). */
export function applySeedCorrections(fx: MockFixtures): MockFixtures {
  const emptyTanks = new Set(
    fx.fermentationTanks
      .filter(
        (t) =>
          EMPTY_TANK_IDS.includes(t.id) && !(Number(t.volumeFilledLiters) > 0),
      )
      .map((t) => t.id),
  );
  // Los eventos de un tanque retirado se van con él; `seq` se renumera
  const perLot = new Map<string, FixtureLotEvent[]>();
  for (const event of fx.lotEvents) {
    const list = perLot.get(event.lotId) ?? [];
    list.push(event);
    perLot.set(event.lotId, list);
  }
  const lotEvents: FixtureLotEvent[] = [];
  for (const events of perLot.values()) {
    events
      .sort((a, b) => a.seq - b.seq)
      .filter((e) => !emptyTanks.has(e.resource.id))
      .forEach((e, index) => lotEvents.push({ ...e, seq: index + 1 }));
  }
  return {
    ...fx,
    fermentationTanks: fx.fermentationTanks
      .filter((t) => !emptyTanks.has(t.id))
      .map((t) => {
        if (t.id === TK_08 && t.status === 'COMPLETED') {
          return { ...t, status: 'TRANSFERRED' as const };
        }
        if (t.id === TK_01 && t.status === 'TRANSFERRED') {
          return {
            ...t,
            status: 'CLEANED' as const,
            transitions: [
              ...(t.transitions ?? []),
              { status: 'CLEANED' as const, at: TK_01_CLEANED_AT, by: null },
            ],
          };
        }
        return t;
      }),
    fermentationLogs: fx.fermentationLogs.filter(
      (l) => !emptyTanks.has(l.fermentationTankId),
    ),
    enologicalTreatments: fx.enologicalTreatments.filter(
      (t) => !emptyTanks.has(t.fermentationTankId),
    ),
    lotEvents,
  };
}
