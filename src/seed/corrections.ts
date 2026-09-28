import type { MockFixtures } from './fixtures';

/**
 * Correcciones de realismo de la semilla (Ola 2, O2-BE-1): datos de los
 * fixtures de `@drinks-on-chain/mocks` 0.3.x que incumplen las reglas de la
 * trazabilidad confiable (contrato O2). No se falsea nada para que "pase":
 * se corrige lo físicamente imposible y se deja constancia aquí, para que los
 * mocks v2 (O2-PK-1) adopten lo mismo. Los fixtures copiados (`pnpm
 * seed:sync`) no se editan: la corrección se aplica al cargarlos.
 */
export interface SeedCorrection {
  id: string;
  what: string;
  reason: string;
}

export const SEED_CORRECTIONS: readonly SeedCorrection[] = [
  {
    id: '16887e29-6c0f-5820-85df-951b7372e1aa',
    what: 'CVJ-2026-SINGANI-002: agua de dilución 620 L → 630 L',
    reason:
      'Balance de volumen (EA-02): 2.140 botellas de 75 cL son 1.605 L y el corazón (980 L) más 620 L de agua solo daba 1.600 L. Con 630 L la merma es del 0,3 % y el alcohol puro no cambia (642 L ≤ 640,9 L × 1,005)',
  },
  {
    id: 'a6dd3060-8612-5595-b9b4-33a7d039159c',
    what: 'Se retira la segunda destilación del tanque TK-02 (Alambique AL-02, 3.000 L, marzo de 2026)',
    reason:
      'El tanque TK-02 (6.100 L) ya se había destilado entero en mayo de 2025 y su lote (HARV-2025-MOLINO-03) se embotelló en febrero de 2026: 3.000 L más del mismo tanque superan su volumen y un lote embotellado no admite nuevas destilaciones (un embotellado por lote, S-10)',
  },
  {
    id: 'f28ea298-cf7f-5d30-a92e-aad6379b8158',
    what: 'Se retira el tanque TK-07 (FILLING) lleno con HARV-2026-ANGOSTURA-11',
    reason:
      'Ese pesaje está en cuarentena: la uva sin dictamen aprobado no entra a un tanque (EA-04, S-2)',
  },
  {
    id: 'a48ddc67-0e24-51fe-a43d-877f55ac9de6',
    what: 'Crianza de CVJ-2026-WINE-003: estado READY → BOTTLED',
    reason:
      'La crianza se embotelló el 20-09-2026 (CVJ-2026-WINE-003): una fuente embotellada queda en BOTTLED (estado terminal, EA-02)',
  },
];

/** Fixtures con las correcciones aplicadas (no modifica los originales). */
export function applySeedCorrections(fx: MockFixtures): MockFixtures {
  const excludedProductions = new Set(['a6dd3060-8612-5595-b9b4-33a7d039159c']);
  const excludedTanks = new Set(['f28ea298-cf7f-5d30-a92e-aad6379b8158']);
  return {
    ...fx,
    fermentationTanks: fx.fermentationTanks.filter(
      (t) => !excludedTanks.has(t.id),
    ),
    fermentationLogs: fx.fermentationLogs.filter(
      (l) => !excludedTanks.has(l.fermentationTankId),
    ),
    enologicalTreatments: fx.enologicalTreatments.filter(
      (t) => !excludedTanks.has(t.fermentationTankId),
    ),
    productionBatches: fx.productionBatches.filter(
      (p) => !excludedProductions.has(p.id),
    ),
    wineAgings: fx.wineAgings.map((a) =>
      a.id === 'a48ddc67-0e24-51fe-a43d-877f55ac9de6' &&
      a.agingStatus === 'READY'
        ? { ...a, agingStatus: 'BOTTLED' as const }
        : a,
    ),
    bottlingBatches: fx.bottlingBatches.map((b) =>
      b.id === '16887e29-6c0f-5820-85df-951b7372e1aa' &&
      b.waterDilutionLiters === 620
        ? { ...b, waterDilutionLiters: 630 }
        : b,
    ),
  };
}
