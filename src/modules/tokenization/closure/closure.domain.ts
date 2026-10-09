import type { TokenStatus } from '../tokenization.constants';

/**
 * Cierre del lote con faltante (contrato O3 §8.4; A-30, `docs-back/07` §6.6).
 * Funciones puras: cuántos NFT pierden su botella y cuáles, en qué orden.
 */

export interface ClosureToken {
  id: string;
  tokenId: number;
  bottleNumber: number;
  status: TokenStatus | string;
  /** Ola 4: fecha del pedido pagado (hoy, `soldAt` del NFT). */
  soldAt: Date | null;
}

/** NFT a nombre de un consumidor (§6.3): vendidos, canjeables, con pase… */
const SOLD_STATUSES: readonly string[] = [
  'SOLD',
  'REDEEMABLE',
  'PASS_ACTIVE',
  'REDEEMED',
  'EXPIRED',
];

export const isUnsold = (token: Pick<ClosureToken, 'status'>): boolean =>
  token.status === 'MINTED';
export const isBurned = (token: Pick<ClosureToken, 'status'>): boolean =>
  token.status === 'BURNED';

export interface ClosureCounts {
  minted: number;
  burned: number;
  sold: number;
  reserved: number;
  /** `MINTED` no reservados. */
  unsold: number;
  /** Emitidos que siguen vivos (no quemados). */
  alive: number;
}

export function closureCounts(
  minted: number,
  tokens: readonly Pick<ClosureToken, 'status'>[],
): ClosureCounts {
  let burned = 0;
  let sold = 0;
  let reserved = 0;
  let unsold = 0;
  for (const token of tokens) {
    if (token.status === 'BURNED') burned += 1;
    else if (token.status === 'RESERVED') reserved += 1;
    else if (token.status === 'MINTED') unsold += 1;
    else if (SOLD_STATUSES.includes(token.status)) sold += 1;
  }
  return { minted, burned, sold, reserved, unsold, alive: minted - burned };
}

/**
 * Orden en que los NFT pierden su botella (S-23, A-30):
 *
 * 1. los **no vendidos**, empezando por el número de botella más alto;
 * 2. los **reservados** (un pedido sin pagar cede antes que uno pagado), del
 *    número más alto al más bajo;
 * 3. los **vendidos**, empezando por el pedido pagado más reciente (a igual
 *    fecha, el número de botella más alto).
 *
 * Los quemados no cuentan: ya no tienen botella que perder.
 */
export function shortfallOrder<T extends ClosureToken>(
  tokens: readonly T[],
): T[] {
  const rank = (token: ClosureToken): number =>
    token.status === 'MINTED' ? 0 : token.status === 'RESERVED' ? 1 : 2;
  return tokens
    .filter((token) => !isBurned(token))
    .sort((a, b) => {
      const byRank = rank(a) - rank(b);
      if (byRank !== 0) return byRank;
      if (rank(a) === 2) {
        const bySale = (b.soldAt?.getTime() ?? 0) - (a.soldAt?.getTime() ?? 0);
        if (bySale !== 0) return bySale;
      }
      return b.bottleNumber - a.bottleNumber;
    });
}

export interface ShortfallPlan<T extends ClosureToken> {
  /** NFT vivos que hoy no tienen botella: `max(0, vivos − botellas)`. */
  need: number;
  /** De esos, los que ningún ítem del cierre cubre todavía. */
  extra: number;
  /** Los NFT que hay que añadir al cierre, en el orden de S-23. */
  added: T[];
  addedUnsold: number;
  addedSold: number;
}

/**
 * Qué NFT añadir al cierre: los que faltan para cubrir el faltante de hoy,
 * sin contar los que ya son ítems y siguen vivos (van a quemarse o se
 * resuelven a mano). Solo crece: una botella anulada después del primer
 * cálculo añade ítems, nunca los quita.
 */
export function planShortfall<T extends ClosureToken>(input: {
  bottles: number;
  minted: number;
  tokens: readonly T[];
  /** `tokens.id` que ya son ítems del cierre. */
  itemTokenIds: ReadonlySet<string>;
}): ShortfallPlan<T> {
  const counts = closureCounts(input.minted, input.tokens);
  const need = Math.max(0, counts.alive - input.bottles);
  const covered = input.tokens.filter(
    (token) => input.itemTokenIds.has(token.id) && !isBurned(token),
  ).length;
  const extra = Math.max(0, need - covered);
  const added = shortfallOrder(
    input.tokens.filter((token) => !input.itemTokenIds.has(token.id)),
  ).slice(0, extra);
  const addedUnsold = added.filter(isUnsold).length;
  return {
    need,
    extra,
    added,
    addedUnsold,
    addedSold: added.length - addedUnsold,
  };
}

/** ¿Queda algo por resolver en el cierre? */
export function closureSettled(
  items: readonly { outcome: string; resolvedAt: Date | null }[],
): boolean {
  return items.every(
    (item) => item.outcome !== 'PENDING' && item.resolvedAt !== null,
  );
}
