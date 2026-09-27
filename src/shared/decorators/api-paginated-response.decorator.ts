import { Type, applyDecorators } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiOkResponse,
  ApiUnprocessableEntityResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import { ApiErrorResponseDto } from '../dto/api-error-response.dto';
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
} from '../dto/pagination-query.dto';

/**
 * Declara en OpenAPI la respuesta de una colección (contrato O0 §2):
 * `data: { items: Model[], total, limit, offset }`. Como el resto de
 * respuestas del documento, describe `data` (el envoltorio es común).
 * Añade el 422 de `limit`/`offset` fuera de rango.
 */
export function ApiPaginatedResponse<TModel extends Type<unknown>>(
  model: TModel,
  options: { description?: string } = {},
) {
  return applyDecorators(
    ApiExtraModels(model, ApiErrorResponseDto),
    ApiOkResponse({
      description: options.description ?? 'Página de resultados',
      schema: paginatedSchema(getSchemaPath(model)),
    }),
    ApiUnprocessableEntityResponse({
      description: `VALIDATION_ERROR: filtros inválidos o \`limit\` fuera de 1–${MAX_PAGE_LIMIT}`,
      type: ApiErrorResponseDto,
    }),
  );
}

/** Esquema OpenAPI de una página cuyos elementos son `itemRef`. */
export function paginatedSchema(itemRef: string) {
  return {
    type: 'object' as const,
    required: ['items', 'total', 'limit', 'offset'],
    properties: {
      items: { type: 'array' as const, items: { $ref: itemRef } },
      total: {
        type: 'integer' as const,
        minimum: 0,
        example: 1,
        description: 'Total de resultados con los filtros aplicados',
      },
      limit: {
        type: 'integer' as const,
        minimum: 1,
        maximum: MAX_PAGE_LIMIT,
        example: DEFAULT_PAGE_LIMIT,
      },
      offset: { type: 'integer' as const, minimum: 0, example: 0 },
    },
  };
}
