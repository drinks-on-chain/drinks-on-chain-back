import type { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import type { ChainIntentInput } from '../tx/chain-intents.service';

/** Quién pide el anclaje (persona o proceso). */
export type AnchorRequestedBy = NonNullable<ChainIntentInput['requestedBy']>;

/**
 * Puerto del anclaje del expediente (A-22): publicar la huella del expediente
 * cerrado de un lote en un registro público e inmutable. El dominio de los
 * lotes solo conoce este puerto; **dónde** y **cómo** se ancla lo decide la
 * implementación:
 *
 * - `STELLAR` (`DossierAnchorService`): transacción clásica con `MEMO_HASH`
 *   firmada por la cuenta de anclaje y enviada por el firmante del worker.
 * - `SIMULATED` (`SimulatedDossierAnchorLedger`): da el anclaje por
 *   confirmado sin salir a ninguna red, con los mismos efectos (lote
 *   `ANCHORED`, línea de tiempo, bitácora, `lot.anchored`). Para probar el
 *   recorrido completo antes de conectar la red.
 *
 * Cambiar de red o de forma de anclar (otro memo, un contrato, otra cadena)
 * es escribir otra implementación de este puerto y elegirla con
 * `ANCHOR_LEDGER`; los lotes, el pasaporte y las apps no cambian.
 */
export interface DossierAnchorLedger {
  /** Qué implementación es (aparece en los logs). */
  readonly kind: AnchorLedgerKind;

  /**
   * Pide el anclaje del expediente cerrado del lote, dentro de la
   * transacción de base de datos de quien llama. Idempotente: repetirlo no
   * crea otro anclaje.
   */
  request(
    db: Prisma.TransactionClient,
    lotId: string,
    requestedBy?: AnchorRequestedBy,
  ): Promise<AnchorRequestResult>;

  /**
   * Relleno: expedientes cerrados que aún no tienen anclaje en este registro
   * (los certificados antes de habilitarlo). Por tandas.
   */
  backfill(limit?: number): Promise<{ requested: number; more: boolean }>;
}

export type AnchorRequestResult =
  /** Anclaje pedido (en Stellar, intención `ANCHOR_DOSSIER` registrada). */
  | 'REQUESTED'
  /** Ya había un anclaje en curso para ese expediente. */
  | 'IN_PROGRESS'
  | 'ALREADY_ANCHORED'
  /** El expediente no está cerrado (o no existe). */
  | 'NOT_CLOSED'
  /** La cuenta de anclaje aún no está registrada: lo recoge el relleno. */
  | 'NO_ANCHOR_ACCOUNT'
  /** El registro está deshabilitado (Stellar sin custodio ni RPC). */
  | 'DISABLED';

export const ANCHOR_LEDGER_KINDS = ['STELLAR', 'SIMULATED'] as const;
export type AnchorLedgerKind = (typeof ANCHOR_LEDGER_KINDS)[number];

/** Token de inyección del puerto. */
export const DOSSIER_ANCHOR_LEDGER = Symbol('DOSSIER_ANCHOR_LEDGER');

/** Lotes por pasada del relleno (cada anclaje va en su propia transacción). */
export const ANCHOR_BACKFILL_BATCH = 25;

/** `ANCHOR_LEDGER` (por defecto `STELLAR`). */
export function anchorLedgerFromConfig(
  config: Pick<ConfigService, 'get'>,
): AnchorLedgerKind {
  const raw = String(config.get<string>('ANCHOR_LEDGER') ?? '')
    .trim()
    .toUpperCase();
  return raw === 'SIMULATED' ? 'SIMULATED' : 'STELLAR';
}
