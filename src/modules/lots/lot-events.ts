import { Prisma } from '@prisma/client';
import type { LotStage } from './domain/lot-stage';

/** Tipos de evento de la línea de tiempo (contrato O2 §11.1). */
export type LotEventType =
  | 'LOT_CREATED'
  | 'ESTIMATE_CHANGED'
  | 'HARVEST_WEIGHED'
  | 'MATURITY_ANALYZED'
  | 'PHYTO_DECIDED'
  | 'TANK_FILLED'
  | 'FERMENTATION_STARTED'
  | 'FERMENTATION_READINGS'
  | 'TREATMENT_APPLIED'
  | 'FERMENTATION_COMPLETED'
  | 'PRODUCT_DECIDED'
  | 'AGING_STARTED'
  | 'DISTILLATION_STARTED'
  | 'DISTILLATION_CLOSED'
  | 'LOCK_RELEASED'
  | 'BOTTLED'
  | 'BOTTLE_CODES_GENERATED'
  | 'BOTTLE_CODE_VOIDED'
  | 'LAB_REGISTERED'
  | 'CORRECTION'
  | 'FILE_ATTACHED'
  | 'DOSSIER_CLOSED'
  | 'LOT_REJECTED'
  | 'LOT_DISCARDED'
  // Ola 3 (contrato O3 §11): tokenización y anclaje
  | 'TOKENIZATION_AUTHORIZED'
  | 'NFT_MINTED'
  | 'COLLECTION_PUBLISHED'
  | 'DOSSIER_ANCHORED'
  | 'TOKENS_REDEEMABLE'
  | 'SHORTFALL_DETECTED';

export const LOT_EVENT_TYPES: readonly LotEventType[] = [
  'LOT_CREATED',
  'ESTIMATE_CHANGED',
  'HARVEST_WEIGHED',
  'MATURITY_ANALYZED',
  'PHYTO_DECIDED',
  'TANK_FILLED',
  'FERMENTATION_STARTED',
  'FERMENTATION_READINGS',
  'TREATMENT_APPLIED',
  'FERMENTATION_COMPLETED',
  'PRODUCT_DECIDED',
  'AGING_STARTED',
  'DISTILLATION_STARTED',
  'DISTILLATION_CLOSED',
  'LOCK_RELEASED',
  'BOTTLED',
  'BOTTLE_CODES_GENERATED',
  'BOTTLE_CODE_VOIDED',
  'LAB_REGISTERED',
  'CORRECTION',
  'FILE_ATTACHED',
  'DOSSIER_CLOSED',
  'LOT_REJECTED',
  'LOT_DISCARDED',
  // Ola 3 (contrato O3 §11): tokenización y anclaje
  'TOKENIZATION_AUTHORIZED',
  'NFT_MINTED',
  'COLLECTION_PUBLISHED',
  'DOSSIER_ANCHORED',
  'TOKENS_REDEEMABLE',
  'SHORTFALL_DETECTED',
];

/** Eventos que ve el pasaporte público (§12). */
const PUBLIC_TYPES = new Set<LotEventType>([
  'HARVEST_WEIGHED',
  'PHYTO_DECIDED',
  'TANK_FILLED',
  'FERMENTATION_STARTED',
  'FERMENTATION_COMPLETED',
  'PRODUCT_DECIDED',
  'AGING_STARTED',
  'DISTILLATION_STARTED',
  'DISTILLATION_CLOSED',
  'LOCK_RELEASED',
  'BOTTLED',
  'LAB_REGISTERED',
  'DOSSIER_CLOSED',
  'LOT_DISCARDED',
  // Ola 3: `TOKENIZATION_AUTHORIZED` y `SHORTFALL_DETECTED` son internos
  'NFT_MINTED',
  'COLLECTION_PUBLISHED',
  'DOSSIER_ANCHORED',
  'TOKENS_REDEEMABLE',
]);

export interface LotEventInput {
  type: LotEventType;
  occurredAt: Date;
  /** Etapa del lote tras el evento. */
  stage: LotStage;
  actorMembershipId: string | null;
  summary: string;
  data?: Record<string, unknown>;
  resource: { type: string; id: string };
  recordedAt?: Date;
  /** Por defecto, la del tipo de evento (§12: lo que ve el pasaporte). */
  visibility?: 'PUBLIC' | 'INTERNAL';
}

/**
 * Añade un evento a la línea de tiempo del lote en la transacción `tx`. Quien
 * llama tiene la fila del lote bloqueada (`lockLotRow`), así que `seq` es
 * consecutivo sin carreras.
 */
export async function appendLotEvent(
  tx: Prisma.TransactionClient,
  lotId: string,
  input: LotEventInput,
): Promise<void> {
  const last = await tx.lotEvent.findFirst({
    where: { lotId },
    orderBy: { seq: 'desc' },
    select: { seq: true },
  });
  await tx.lotEvent.create({
    data: {
      lotId,
      seq: (last?.seq ?? 0) + 1,
      type: input.type,
      occurredAt: input.occurredAt,
      ...(input.recordedAt && { recordedAt: input.recordedAt }),
      stage: input.stage,
      actorMembershipId: input.actorMembershipId,
      summary: input.summary,
      data: (input.data ?? {}) as Prisma.InputJsonObject,
      resourceType: input.resource.type,
      resourceId: input.resource.id,
      visibility:
        input.visibility ??
        (PUBLIC_TYPES.has(input.type) ? 'PUBLIC' : 'INTERNAL'),
    },
  });
}

/** `18.400` (miles con punto, como el ERP en es-BO). */
export function formatQuantity(value: number, decimals = 0): string {
  return value.toLocaleString('es-BO', {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}
