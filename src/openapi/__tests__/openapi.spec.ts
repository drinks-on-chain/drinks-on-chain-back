import { readFileSync } from 'fs';
import { resolve } from 'path';
import type {
  OpenAPIObject,
  OperationObject,
  ParameterObject,
  ReferenceObject,
  SchemaObject,
} from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { generateOpenApiDocument } from '../document';
import { BEARER_AUTH, serializeOpenApiDocument } from '../openapi';

type Operation = OperationObject & { method: string; path: string };

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const;

function operations(document: OpenAPIObject): Operation[] {
  return Object.entries(document.paths).flatMap(([path, item]) =>
    HTTP_METHODS.filter((method) => item[method]).map((method) => ({
      ...(item[method] as OperationObject),
      method: method.toUpperCase(),
      path,
    })),
  );
}

function okSchema(operation: Operation): SchemaObject | undefined {
  const response = operation.responses?.['200'] as
    { content?: Record<string, { schema?: SchemaObject }> } | undefined;
  return response?.content?.['application/json']?.schema;
}

function queryParam(
  operation: Operation,
  name: string,
): ParameterObject | undefined {
  return (operation.parameters ?? []).find(
    (p): p is ParameterObject =>
      !('$ref' in p) && p.in === 'query' && p.name === name,
  );
}

function isPaginated(schema: SchemaObject | undefined): boolean {
  if (!schema || schema.type !== 'object' || !schema.properties) {
    return false;
  }
  const items = schema.properties.items as SchemaObject | undefined;
  return (
    ['items', 'total', 'limit', 'offset'].every((key) =>
      schema.required?.includes(key),
    ) &&
    items?.type === 'array' &&
    typeof (items.items as ReferenceObject | undefined)?.$ref === 'string' &&
    (schema.properties.total as SchemaObject).type === 'integer' &&
    (schema.properties.limit as SchemaObject).maximum === 100 &&
    (schema.properties.offset as SchemaObject).type === 'integer'
  );
}

const key = (op: Operation) => `${op.method} ${op.path}`;

describe('Contrato OpenAPI (OPS-12)', () => {
  let document: OpenAPIObject;
  let ops: Operation[];

  beforeAll(async () => {
    document = await generateOpenApiDocument();
    ops = operations(document);
  }, 60000);

  it('openapi.json versionado está al día (pnpm openapi:generate)', () => {
    const committed = readFileSync(
      resolve(__dirname, '..', '..', '..', 'openapi.json'),
      'utf8',
    ).replace(/\r\n/g, '\n');
    expect(serializeOpenApiDocument(document)).toBe(committed);
  });

  describe('listas (contrato O0 §2)', () => {
    const COLLECTIONS = [
      'GET /v1/bottling',
      'GET /v1/fermentation-tanks',
      'GET /v1/harvest-batches',
      'GET /v1/production-batches',
      'GET /v1/terroirs',
      'GET /v1/wine-aging',
      'GET /v1/wineries',
      'GET /v1/wineries/my/members',
      'GET /v1/wineries/pending',
    ];

    // Listas cortas y cerradas que el contrato fija como array sin paginar
    // (contrato O1 §6: la configuración son menos de 50 parámetros)
    const UNPAGINATED_ARRAYS = ['GET /v1/organizations/current/settings'];

    it('ninguna respuesta declara un array plano', () => {
      const bare = ops
        .filter((op) => !UNPAGINATED_ARRAYS.includes(key(op)))
        .filter((op) =>
          Object.values(op.responses ?? {}).some((response) => {
            const schema = (
              response as {
                content?: Record<string, { schema?: SchemaObject }>;
              }
            ).content?.['application/json']?.schema;
            return schema?.type === 'array';
          }),
        );
      expect(bare.map(key)).toEqual([]);
    });

    it('toda colección declarada responde { items, total, limit, offset }', () => {
      // Colección = GET que acepta limit/offset o que declara una página
      const collections = ops.filter(
        (op) =>
          op.method === 'GET' &&
          (queryParam(op, 'limit') ||
            queryParam(op, 'offset') ||
            isPaginated(okSchema(op))),
      );
      expect(collections.map(key).sort()).toEqual(COLLECTIONS);
      for (const op of collections) {
        expect({ op: key(op), paginated: isPaginated(okSchema(op)) }).toEqual({
          op: key(op),
          paginated: true,
        });
      }
    });

    it.each(COLLECTIONS)(
      '%s acepta limit (1–100, por defecto 20) y offset (≥ 0)',
      (collection) => {
        const op = ops.find((o) => key(o) === collection)!;
        const limit = queryParam(op, 'limit')?.schema as SchemaObject;
        const offset = queryParam(op, 'offset')?.schema as SchemaObject;
        expect(limit).toMatchObject({ minimum: 1, maximum: 100, default: 20 });
        expect(offset).toMatchObject({ minimum: 0, default: 0 });
        expect(Object.keys(op.responses)).toContain('422');
      },
    );
  });

  describe('seguridad (SE-08)', () => {
    const PUBLIC = [
      'GET /v1/health',
      'GET /v1/health/live',
      'GET /v1/health/ready',
      'GET /v1/traceability/public/{lotCode}',
      'POST /v1/auth/login',
      'POST /v1/auth/logout',
      'POST /v1/auth/refresh',
      'POST /v1/auth/signup',
    ];

    it('define el esquema bearer y ninguna operación usa otro', () => {
      expect(document.components?.securitySchemes).toEqual({
        [BEARER_AUTH]: expect.objectContaining({
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        }),
      });
      const schemes = new Set(
        ops.flatMap((op) =>
          (op.security ?? []).flatMap((requirement) =>
            Object.keys(requirement),
          ),
        ),
      );
      expect([...schemes]).toEqual([BEARER_AUTH]);
    });

    it('las rutas @Public van sin candado y el resto con bearer', () => {
      const unlocked = ops.filter((op) => (op.security ?? []).length === 0);
      expect(unlocked.map(key).sort()).toEqual(PUBLIC);
      for (const op of unlocked) {
        expect(op.security).toEqual([]);
        expect(op).not.toHaveProperty('x-public');
      }
      for (const op of ops.filter((o) => !PUBLIC.includes(key(o)))) {
        expect(op.security).toEqual([{ [BEARER_AUTH]: [] }]);
      }
    });
  });

  it('las altas del ERP declaran Idempotency-Key (UUID, opcional)', () => {
    const idempotent = ops
      .filter((op) =>
        (op.parameters ?? []).some(
          (p) =>
            !('$ref' in p) && p.in === 'header' && p.name === 'Idempotency-Key',
        ),
      )
      .map(key)
      .sort();
    expect(idempotent).toEqual([
      'POST /v1/bottling',
      'POST /v1/fermentation-tanks',
      'POST /v1/fermentation-tanks/{id}/logs',
      'POST /v1/fermentation-tanks/{id}/treatments',
      'POST /v1/harvest-batches',
      'POST /v1/lab-analyses',
      'POST /v1/production-batches/distillation',
      'POST /v1/terroirs',
      'POST /v1/wine-aging',
    ]);
    const header = (
      ops.find((op) => key(op) === 'POST /v1/terroirs')!.parameters ?? []
    ).find(
      (p) => !('$ref' in p) && p.name === 'Idempotency-Key',
    ) as ParameterObject;
    expect(header).toMatchObject({
      required: false,
      schema: { type: 'string', format: 'uuid' },
    });
  });
});
