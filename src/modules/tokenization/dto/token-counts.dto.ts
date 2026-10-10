import { ApiProperty } from '@nestjs/swagger';

const count = (description: string) =>
  ApiProperty({ type: 'integer', minimum: 0, description });

/**
 * NFT de una colección por estado (contrato O3 §6.2). En la Ola 3 solo se
 * mueven `minted`, `available` y `burned`; el resto, en las Olas 4 y 5.
 */
export class TokenCountsDto {
  @count('Emitidos confirmados (incluye los quemados)')
  minted!: number;

  @count('`MINTED` no reservados')
  available!: number;

  @count('Apartados por un pedido (Ola 4)')
  reserved!: number;

  @count('Pagados y entregados (Ola 4)')
  sold!: number;

  @count('Canjeables: lote anclado, dentro de la ventana')
  redeemable!: number;

  @count('Con pase de canje vigente (Ola 5)')
  passActive!: number;

  @count('Canje confirmado (Ola 5)')
  redeemed!: number;

  @count('Quema confirmada (canje o cierre con faltante)')
  burned!: number;

  @count('Ventana de canje vencida (Ola 5)')
  expired!: number;
}

/** Estado del NFT (§6.3) → contador de `TokenCounts` al que suma. */
export const TOKEN_COUNT_KEYS: Record<string, keyof TokenCountsDto> = {
  MINTED: 'available',
  RESERVED: 'reserved',
  SOLD: 'sold',
  REDEEMABLE: 'redeemable',
  PASS_ACTIVE: 'passActive',
  REDEEMED: 'redeemed',
  BURNED: 'burned',
  EXPIRED: 'expired',
};

/** Suma de los contadores de varias colecciones (cuenta de la bodega, §3.4). */
export function sumTokenCounts(
  counts: readonly TokenCountsDto[],
): TokenCountsDto {
  const total: TokenCountsDto = { ...ZERO_TOKEN_COUNTS };
  for (const item of counts) {
    for (const key of Object.keys(total) as (keyof TokenCountsDto)[]) {
      total[key] += item[key];
    }
  }
  return total;
}

export const ZERO_TOKEN_COUNTS: TokenCountsDto = {
  minted: 0,
  available: 0,
  reserved: 0,
  sold: 0,
  redeemable: 0,
  passActive: 0,
  redeemed: 0,
  burned: 0,
  expired: 0,
};
