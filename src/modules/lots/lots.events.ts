/**
 * Eventos del outbox de los lotes (contrato O2 §15) que publica el bloque de
 * códigos de botella y expediente.
 */

/**
 * Expediente cerrado: el lote pasa a `CERTIFIED`. Va por la cola `chain`
 * porque quien lo consume es el anclaje del hash (Ola 3); hasta entonces el
 * worker solo lo registra.
 */
export const LOT_CERTIFIED = 'lot.certified';

export interface LotCertifiedPayload {
  [key: string]: string | number;
  lotId: string;
  wineryId: string;
  lotCode: string;
  /** SHA-256 hex del expediente canónico. */
  hash: string;
  bottleMerkleRoot: string;
  bottleCount: number;
  closedAt: string;
}

export const LOT_AGGREGATE = 'lot';

/**
 * Expediente anclado en la red y verificado (contrato O3 §7.2): el lote pasó
 * de `CERTIFIED` a `ANCHORED`. Lo consumirán el catálogo y los avisos de la
 * Ola 4; hasta entonces el worker solo deja constancia.
 */
export const LOT_ANCHORED = 'lot.anchored';

export interface LotAnchoredPayload {
  [key: string]: string | number;
  lotId: string;
  wineryId: string;
  lotCode: string;
  /** SHA-256 hex del expediente (= memo de la transacción). */
  hash: string;
  txHash: string;
  ledger: number;
  anchoredAt: string;
}

/**
 * Tarea `trace.bottle-codes.export` (§15): genera en el worker el ZIP de una
 * exportación de códigos de botella para la imprenta.
 */
export const BOTTLE_CODES_EXPORT_JOB = 'trace.bottle-codes.export';

export interface BottleCodesExportPayload {
  [key: string]: string;
  exportId: string;
  lotId: string;
  wineryId: string;
}
