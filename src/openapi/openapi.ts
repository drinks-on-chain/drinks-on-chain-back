import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { ApiErrorResponseDto } from '../shared/dto/api-error-response.dto';

/** Nombre del esquema de seguridad del documento (SE-08). */
export const BEARER_AUTH = 'bearer';
/** Extensión que `@Public()` pone en sus operaciones; se retira al generar. */
export const PUBLIC_OPERATION_EXTENSION = 'x-public';
/** Pública que además acepta una sesión (`@Public() @OptionalAuth()`). */
export const OPTIONAL_AUTH_OPERATION_EXTENSION = 'x-optional-auth';

export function buildOpenApiConfig(): Omit<OpenAPIObject, 'paths'> {
  return new DocumentBuilder()
    .setTitle('Drinks on Chain API')
    .setDescription(
      'Backend API para Trazabilidad B2B y Tokenización NFT de Bebidas en Stellar Soroban. ' +
        'Todas las respuestas usan el envoltorio `{ success, statusCode, timestamp, path, data }` ' +
        '(los esquemas de respuesta describen `data`); los errores, `{ success: false, …, error: { code, message, details } }`. ' +
        'Las colecciones devuelven `{ items, total, limit, offset }`.',
    )
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Token de acceso: `Authorization: Bearer <access>`',
      },
      BEARER_AUTH,
    )
    .addTag('System', 'Endpoints de salud y configuración del sistema')
    .build();
}

/**
 * Documento OpenAPI de la aplicación: el mismo que sirve `/docs-json` y el que
 * `pnpm openapi:generate` guarda en `openapi.json`.
 */
export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  const document = SwaggerModule.createDocument(app, buildOpenApiConfig(), {
    extraModels: [ApiErrorResponseDto],
  });
  markPublicOperations(document);
  return sortOpenApiDocument(document);
}

/** Las operaciones `@Public()` no llevan candado (`security: []`). */
export function markPublicOperations(document: OpenAPIObject): void {
  for (const pathItem of Object.values(document.paths)) {
    for (const operation of Object.values(pathItem) as Array<
      Record<string, unknown>
    >) {
      if (
        operation &&
        typeof operation === 'object' &&
        PUBLIC_OPERATION_EXTENSION in operation
      ) {
        delete operation[PUBLIC_OPERATION_EXTENSION];
        operation.security = [];
      }
      if (
        operation &&
        typeof operation === 'object' &&
        OPTIONAL_AUTH_OPERATION_EXTENSION in operation
      ) {
        delete operation[OPTIONAL_AUTH_OPERATION_EXTENSION];
        operation.security = [{}, { [BEARER_AUTH]: [] }];
      }
    }
  }
}

const HTTP_METHOD_ORDER = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
];

/** Comparación por código de carácter: igual en cualquier máquina (sin locale). */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortKeys<T>(
  record: Record<string, T>,
  compare: (a: string, b: string) => number = byCodePoint,
): Record<string, T> {
  return Object.fromEntries(
    Object.keys(record)
      .sort(compare)
      .map((key) => [key, record[key]]),
  );
}

/**
 * Orden estable: rutas y componentes por nombre, métodos en el orden de
 * OpenAPI y etiquetas por nombre. El interior de cada operación y esquema
 * conserva el orden del código (determinista).
 */
export function sortOpenApiDocument(document: OpenAPIObject): OpenAPIObject {
  const paths = sortKeys(document.paths);
  for (const [path, item] of Object.entries(paths)) {
    paths[path] = sortKeys(
      item as Record<string, unknown>,
      (a, b) => methodRank(a) - methodRank(b) || byCodePoint(a, b),
    ) as typeof item;
  }
  const components = document.components
    ? (Object.fromEntries(
        Object.entries(
          sortKeys(document.components as Record<string, unknown>),
        ).map(([key, value]) => [
          key,
          value && typeof value === 'object'
            ? sortKeys(value as Record<string, unknown>)
            : value,
        ]),
      ) as OpenAPIObject['components'])
    : undefined;
  const tags = document.tags
    ? [...document.tags].sort((a, b) => byCodePoint(a.name, b.name))
    : undefined;
  return {
    openapi: document.openapi,
    info: document.info,
    ...(document.servers ? { servers: document.servers } : {}),
    ...(tags ? { tags } : {}),
    paths,
    ...(components ? { components } : {}),
    ...(document.security ? { security: document.security } : {}),
  } as OpenAPIObject;
}

function methodRank(key: string): number {
  const index = HTTP_METHOD_ORDER.indexOf(key);
  return index === -1 ? HTTP_METHOD_ORDER.length : index;
}

/** Texto de `openapi.json`: JSON con dos espacios y salto de línea final. */
export function serializeOpenApiDocument(document: OpenAPIObject): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
