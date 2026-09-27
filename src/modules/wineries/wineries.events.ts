/**
 * Eventos del outbox que publica el módulo de bodegas (docs-back/03 §5).
 * Cargas mínimas: identificadores, sin datos personales.
 */

export const WINERY_AGGREGATE = 'winery';

/** Bodega registrada (INVITED) con su membresía de dueño y su billetera. */
export const WINERY_CREATED = 'winery.created';

export type WineryCreatedPayload = {
  wineryId: string;
  ownerUserId: string;
  walletId: string;
  vaultId: string;
  stellarPublicKey: string;
};

/** Miembro nuevo creado e incorporado a una bodega, con su billetera. */
export const MEMBER_ADDED = 'member.added';

export type MemberAddedPayload = {
  wineryId: string;
  userId: string;
  memberId: string;
  memberRole: string;
  walletId: string;
  vaultId: string;
};

/**
 * Bodega activada (ORG-05): el dueño aceptó su invitación, la bodega está
 * `ACTIVE` y tiene su prefijo de lote. La Ola 3 crea aquí su identidad en la
 * red (doc 06 §3); hasta entonces el worker solo lo registra.
 */
export const WINERY_ACTIVATED = 'winery.activated';

export type WineryActivatedPayload = {
  wineryId: string;
  lotPrefix: string;
  ownerUserId: string;
  activatedAt: string;
};
