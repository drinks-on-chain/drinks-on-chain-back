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
