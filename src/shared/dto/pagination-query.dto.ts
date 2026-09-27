import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import type { Paginated } from '../interfaces/api-response.interface';

/** Tamaño de página por defecto (contrato O0 §2). */
export const DEFAULT_PAGE_LIMIT = 20;
/** Tamaño de página máximo; más → 422 `VALIDATION_ERROR` (contrato O0 §2). */
export const MAX_PAGE_LIMIT = 100;

/**
 * Parámetros comunes de toda colección (A-33: `limit`/`offset`, no `page`).
 * Las consultas con filtros extienden esta clase.
 */
export class PaginationQueryDto {
  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: MAX_PAGE_LIMIT,
    default: DEFAULT_PAGE_LIMIT,
    description: `Resultados por página (1–${MAX_PAGE_LIMIT})`,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_LIMIT)
  limit: number = DEFAULT_PAGE_LIMIT;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 0,
    default: 0,
    description: 'Resultados que se saltan desde el inicio',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}

/** Arma la página `{ items, total, limit, offset }` de una consulta. */
export function toPage<T>(
  items: T[],
  total: number,
  query: Pick<PaginationQueryDto, 'limit' | 'offset'>,
): Paginated<T> {
  return {
    items,
    total,
    limit: query.limit ?? DEFAULT_PAGE_LIMIT,
    offset: query.offset ?? 0,
  };
}

/** `take`/`skip` de Prisma para una consulta paginada. */
export function toPrismaPage(
  query: Pick<PaginationQueryDto, 'limit' | 'offset'>,
): { take: number; skip: number } {
  return {
    take: query.limit ?? DEFAULT_PAGE_LIMIT,
    skip: query.offset ?? 0,
  };
}
