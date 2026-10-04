import { readSettingsSnapshot } from '@modules/settings/settings.resolve';
import { buildLotRules } from './domain/lot-rules';
import {
  doRulesFromLot,
  DoEvaluation,
  DoRules,
  evaluateDo,
  isDoEligible,
} from './domain/do-evaluation';
import type { DbClient } from './trace-db';

/**
 * Reglas D.O. con los valores **efectivos** de la bodega (para la aptitud de
 * las parcelas, §3.1): no se fijan en ningún lote.
 */
export async function effectiveDoRules(
  client: DbClient,
  wineryId: string,
): Promise<DoRules> {
  const snapshot = await readSettingsSnapshot(client, wineryId);
  return doRulesFromLot(buildLotRules(snapshot, 'LOT_CREATION'));
}

export interface TerroirDoFields {
  isDoEligible: boolean;
  doEvaluation: DoEvaluation;
}

/** Aptitud D.O. de una parcela con los valores efectivos (EA-03). */
export function terroirDo(
  terroir: {
    id: string;
    altitudeMasl: { toNumber(): number } | number;
    varietyName: string;
  },
  rules: DoRules,
  now: Date = new Date(),
): TerroirDoFields {
  const evaluation = evaluateDo(
    [
      {
        id: terroir.id,
        altitudeMasl:
          typeof terroir.altitudeMasl === 'number'
            ? terroir.altitudeMasl
            : terroir.altitudeMasl.toNumber(),
        varietyName: terroir.varietyName,
      },
    ],
    rules,
    'EFFECTIVE_SETTINGS',
    now,
  );
  return {
    isDoEligible: isDoEligible(evaluation.status),
    doEvaluation: evaluation,
  };
}
