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
      'GET /v1/harvest-batches/{id}/maturity-analyses',
      'GET /v1/harvest-batches/{id}/phyto-decisions',
      'GET /v1/lots',
      'GET /v1/lots/{id}/attachments',
      'GET /v1/lots/{id}/bottle-codes',
      'GET /v1/lots/{id}/corrections',
      'GET /v1/lots/{id}/lab-analyses',
      'GET /v1/organizations/current/audit',
      'GET /v1/organizations/current/invitations',
      'GET /v1/organizations/current/members',
      'GET /v1/platform/audit',
      'GET /v1/platform/organizations/{organizationId}/invitations',
      'GET /v1/platform/organizations/{organizationId}/members',
      'GET /v1/platform/settings/{key}/history',
      'GET /v1/platform/settings/{key}/overrides',
      'GET /v1/platform/users',
      'GET /v1/platform/waitlist',
      'GET /v1/platform/wineries',
      'GET /v1/platform/winery-applications',
      'GET /v1/production-batches',
      'GET /v1/public/wineries',
      'GET /v1/terroirs',
      'GET /v1/wine-aging',
      'GET /v1/wineries',
    ];

    // Listas cortas y cerradas que el contrato fija como array sin paginar
    // (contrato O1 §6: la configuración son menos de 50 parámetros; contrato
    // O1b §2: los orígenes de la lista de espera, para el filtro)
    const UNPAGINATED_ARRAYS = [
      'GET /v1/organizations/current/settings',
      'GET /v1/platform/settings',
      'GET /v1/platform/waitlist/sources',
    ];

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
      'GET /v1/invitations/{token}',
      'GET /v1/public/bottles/{code}',
      'GET /v1/public/lots/{lotCode}',
      'GET /v1/public/lots/{lotCode}/attachments/{attachmentId}',
      'GET /v1/public/lots/{lotCode}/dossier',
      'GET /v1/public/passports/{code}',
      'GET /v1/public/waitlist/stats',
      'GET /v1/public/wineries',
      'GET /v1/public/wineries/{slug}',
      'GET /v1/traceability/public/{lotCode}',
      'POST /v1/auth/forgot-password',
      'POST /v1/auth/login',
      'POST /v1/auth/logout',
      'POST /v1/auth/mfa/enroll',
      'POST /v1/auth/mfa/enroll/confirm',
      'POST /v1/auth/mfa/verify',
      'POST /v1/auth/refresh',
      'POST /v1/auth/resend-verification',
      'POST /v1/auth/reset-password',
      'POST /v1/auth/signup',
      'POST /v1/auth/verify-email',
      'POST /v1/public/waitlist',
      'POST /v1/public/winery-applications',
      'POST /v1/public/winery-applications/verify',
    ];
    // Públicas que además aceptan una sesión (@OptionalAuth)
    const OPTIONAL_AUTH = ['POST /v1/invitations/{token}/accept'];

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
      for (const op of ops.filter(
        (o) => !PUBLIC.includes(key(o)) && !OPTIONAL_AUTH.includes(key(o)),
      )) {
        expect(op.security).toEqual([{ [BEARER_AUTH]: [] }]);
      }
      for (const op of ops.filter((o) => OPTIONAL_AUTH.includes(key(o)))) {
        expect(op.security).toEqual([{}, { [BEARER_AUTH]: [] }]);
        expect(op).not.toHaveProperty('x-optional-auth');
      }
    });
  });

  it('toda operación con cuerpo declara su 422 VALIDATION_ERROR', () => {
    const withBody = ops.filter((op) => op.requestBody);
    expect(withBody.length).toBeGreaterThan(0);
    for (const op of withBody) {
      const response = op.responses['422'] as
        { content?: Record<string, { schema?: unknown }> } | undefined;
      expect({
        op: key(op),
        schema: response?.content?.['application/json']?.schema,
      }).toEqual({
        op: key(op),
        schema: { $ref: '#/components/schemas/ApiErrorResponseDto' },
      });
    }
  });

  it('toda respuesta 2xx en JSON declara su esquema', () => {
    const missing = ops.flatMap((op) =>
      Object.entries(op.responses)
        .filter(([code]) => code.startsWith('2') && code !== '204')
        .filter(([, response]) => {
          const content = (
            response as { content?: Record<string, { schema?: unknown }> }
          ).content;
          if (content && !content['application/json']) return false; // CSV…
          return !content?.['application/json']?.schema;
        })
        .map(([code]) => `${key(op)} ${code}`),
    );
    expect(missing).toEqual([]);
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
      'POST /v1/bottle-codes/{code}/void',
      'POST /v1/bottling',
      'POST /v1/fermentation-tanks',
      'POST /v1/fermentation-tanks/{id}/clean',
      'POST /v1/fermentation-tanks/{id}/complete',
      'POST /v1/fermentation-tanks/{id}/logs',
      'POST /v1/fermentation-tanks/{id}/start',
      'POST /v1/fermentation-tanks/{id}/treatments',
      'POST /v1/harvest-batches',
      'POST /v1/harvest-batches/{id}/maturity-analyses',
      'POST /v1/harvest-batches/{id}/phyto-decisions',
      'POST /v1/lab-analyses',
      'POST /v1/lots',
      'POST /v1/lots/{id}/attachments',
      'POST /v1/lots/{id}/attachments/{attachmentId}/visibility',
      'POST /v1/lots/{id}/bottle-codes/exports',
      'POST /v1/lots/{id}/bottling',
      'POST /v1/lots/{id}/bottling/preview',
      'POST /v1/lots/{id}/corrections',
      'POST /v1/lots/{id}/discard',
      'POST /v1/lots/{id}/dossier/close',
      'POST /v1/lots/{id}/lab-analyses',
      'POST /v1/production-batches/distillation',
      'POST /v1/production-batches/{id}/close',
      'POST /v1/production-batches/{id}/discard',
      'POST /v1/terroirs',
      'POST /v1/terroirs/{id}/corrections',
      'POST /v1/wine-aging',
      'POST /v1/wine-aging/{id}/discard',
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

  describe('retirada en H1 (contrato O1 §11, O0 §5)', () => {
    const schema = (name: string) =>
      document.components?.schemas?.[name] as SchemaObject;

    it('no quedan rutas obsoletas ni operaciones deprecated', () => {
      const retired = [
        'POST /v1/wineries',
        'GET /v1/wineries/pending',
        'POST /v1/wineries/{id}/approve',
        'POST /v1/wineries/{id}/reject',
        'GET /v1/wineries/my/members',
        'POST /v1/wineries/my/members',
        'POST /v1/wineries/my/members/create',
      ];
      expect(ops.map(key).filter((k) => retired.includes(k))).toEqual([]);
      // Solo quedan marcadas las rutas legadas de la Ola 2, que se retiran en
      // H2 (contrato O2 §16.2)
      expect(
        ops
          .filter((op) => op.deprecated)
          .map(key)
          .sort(),
      ).toEqual([
        'GET /v1/traceability/dag/{bottlingBatchId}',
        'GET /v1/traceability/public/{lotCode}',
        'PATCH /v1/harvest-batches/{id}/phyto-status',
      ]);
    });

    it('la sesión no lleva el refresco en el cuerpo ni los campos de compatibilidad', () => {
      expect(Object.keys(schema('AuthTokensDto').properties ?? {})).toEqual([
        'accessToken',
        'tokenType',
        'expiresIn',
      ]);
      for (const name of ['AuthUserDto', 'MeUserDto']) {
        const props = Object.keys(schema(name).properties ?? {});
        expect({ name, props }).toEqual({
          name,
          props: expect.not.arrayContaining([
            'userRole',
            'wineryId',
            'memberRole',
          ]),
        });
      }
    });

    it('refresh, logout y switch-organization no aceptan el refresco en el cuerpo', () => {
      for (const path of ['/v1/auth/refresh', '/v1/auth/logout']) {
        expect({ path, body: document.paths[path].post?.requestBody }).toEqual({
          path,
          body: undefined,
        });
      }
      expect(
        Object.keys(schema('SwitchOrganizationDto').properties ?? {}),
      ).toEqual(['organizationId']);
    });

    it('signup es solo para consumidores (sin userRole)', () => {
      expect(Object.keys(schema('SignupDto').properties ?? {})).not.toContain(
        'userRole',
      );
    });
  });
});
