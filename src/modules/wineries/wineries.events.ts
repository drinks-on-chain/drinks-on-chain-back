/**
 * Eventos del outbox que publica el módulo de bodegas (docs-back/03 §5).
 * Cargas mínimas: identificadores, sin datos personales.
 */

export const WINERY_AGGREGATE = 'winery';

/**
 * Bodega activada (ORG-05): el dueño aceptó su invitación, la bodega está
 * `ACTIVE` y tiene su prefijo de lote. La Ola 3 crea aquí su identidad en la
 * red (doc 06 §3; contrato O3 §3.1, paso 3.2); hasta entonces el worker solo
 * lo registra. Los eventos `winery.created` y `member.added` de 0.4, que
 * activaban una bóveda simulada, se retiraron con SE-02 (nadie los emitía
 * desde H1).
 */
export const WINERY_ACTIVATED = 'winery.activated';

export type WineryActivatedPayload = {
  wineryId: string;
  lotPrefix: string;
  ownerUserId: string;
  activatedAt: string;
};
