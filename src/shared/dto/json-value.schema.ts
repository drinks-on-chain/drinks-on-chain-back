import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';

/**
 * Esquema OpenAPI de "cualquier valor JSON" (número, texto, booleano, lista,
 * objeto o `null`). Para campos `unknown` como `expected`/`actual` de un
 * error de regla o los valores de la instantánea de reglas: sin él,
 * `@nestjs/swagger` los declara `object` y un número no pasaría la
 * validación del contrato.
 */
export const JSON_VALUE_SCHEMA: { nullable: boolean; oneOf: SchemaObject[] } = {
  nullable: true,
  oneOf: [
    { type: 'string' },
    { type: 'number' },
    { type: 'boolean' },
    { type: 'array', items: {} },
    { type: 'object', additionalProperties: true },
  ],
};

/** Igual que `JSON_VALUE_SCHEMA` pero sin `null` (valor siempre presente). */
export const JSON_VALUE_NOT_NULL_SCHEMA: { oneOf: SchemaObject[] } = {
  oneOf: JSON_VALUE_SCHEMA.oneOf,
};
