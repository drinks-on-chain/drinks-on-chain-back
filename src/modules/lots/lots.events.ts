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
