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
import { O3_STEP_3_3_ROUTES } from '@modules/tokenization/o3-implemented-routes';
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
      'GET /v1/collections',
      'GET /v1/collections/{id}/tokens',
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
      'GET /v1/platform/chain/alerts',
      'GET /v1/platform/chain/events',
      'GET /v1/platform/chain/reconciliation/runs',
      'GET /v1/platform/chain/transactions',
      'GET /v1/platform/collections',
      'GET /v1/platform/collections/{id}/tokens',
      'GET /v1/platform/collections/{id}/transactions',
      'GET /v1/platform/lot-closures',
      'GET /v1/platform/organizations/{organizationId}/invitations',
      'GET /v1/platform/organizations/{organizationId}/members',
      'GET /v1/platform/settings/{key}/history',
      'GET /v1/platform/settings/{key}/overrides',
      'GET /v1/platform/tokenization-requests',
      'GET /v1/platform/users',
      'GET /v1/platform/waitlist',
      'GET /v1/platform/wineries',
      'GET /v1/platform/winery-applications',
      'GET /v1/production-batches',
      'GET /v1/public/wineries',
      'GET /v1/terroirs',
      'GET /v1/tokenization-requests',
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
      'GET /.well-known/stellar.toml',
      'GET /v1/health',
      'GET /v1/health/live',
      'GET /v1/health/ready',
      'GET /v1/invitations/{token}',
      'GET /v1/public/bottles/{code}',
      'GET /v1/public/chain/registry',
      'GET /v1/public/collections/images/{imageId}',
      'GET /v1/public/lots/{lotCode}',
      'GET /v1/public/lots/{lotCode}/attachments/{attachmentId}',
      'GET /v1/public/lots/{lotCode}/dossier',
      'GET /v1/public/lots/{lotCode}/verification',
      'GET /v1/public/nft/{winerySlug}/{tokenId}',
      'GET /v1/public/passports/{code}',
      'GET /v1/public/waitlist/stats',
      'GET /v1/public/wineries',
      'GET /v1/public/wineries/{slug}',
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

  it('las escrituras idempotentes declaran Idempotency-Key (UUID; opcional en las altas del ERP)', () => {
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
      'POST /v1/fermentation-tanks',
      'POST /v1/fermentation-tanks/{id}/clean',
      'POST /v1/fermentation-tanks/{id}/complete',
      'POST /v1/fermentation-tanks/{id}/logs',
      'POST /v1/fermentation-tanks/{id}/start',
      'POST /v1/fermentation-tanks/{id}/treatments',
      'POST /v1/harvest-batches',
      'POST /v1/harvest-batches/{id}/maturity-analyses',
      'POST /v1/harvest-batches/{id}/phyto-decisions',
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
      'POST /v1/lots/{id}/tokenization-requests',
      'POST /v1/platform/chain/transactions/{id}/retry',
      'POST /v1/platform/collections/{id}/closure/decide',
      'POST /v1/platform/collections/{id}/pause',
      'POST /v1/platform/collections/{id}/publish',
      'POST /v1/platform/collections/{id}/resume',
      'POST /v1/platform/tokenization-requests/{id}/approve',
      'POST /v1/platform/wineries/{id}/chain/pause',
      'POST /v1/platform/wineries/{id}/chain/unpause',
      'POST /v1/production-batches/distillation',
      'POST /v1/production-batches/{id}/close',
      'POST /v1/production-batches/{id}/discard',
      'POST /v1/terroirs',
      'POST /v1/terroirs/{id}/corrections',
      'POST /v1/tokenization-requests/{id}/resubmit',
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
      expect(ops.filter((op) => op.deprecated).map(key)).toEqual([]);
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

  describe('retirada en H2 (contrato O2 §16.2)', () => {
    const schema = (name: string) =>
      document.components?.schemas?.[name] as SchemaObject;
    const props = (name: string) => Object.keys(schema(name).properties ?? {});

    it('no quedan las rutas legadas de la trazabilidad', () => {
      const retired = [
        'PATCH /v1/harvest-batches/{id}/phyto-status',
        'POST /v1/bottling',
        'POST /v1/lab-analyses',
        'GET /v1/traceability/dag/{bottlingBatchId}',
        'GET /v1/traceability/public/{lotCode}',
      ];
      expect(ops.map(key).filter((k) => retired.includes(k))).toEqual([]);
      // Sus sustitutas (y las lecturas que se conservan) siguen publicadas
      expect(ops.map(key)).toEqual(
        expect.arrayContaining([
          'POST /v1/harvest-batches/{id}/phyto-decisions',
          'POST /v1/lots/{id}/bottling',
          'POST /v1/lots/{id}/lab-analyses',
          'GET /v1/lots/{id}/graph',
          'GET /v1/public/passports/{code}',
          'GET /v1/bottling',
          'GET /v1/bottling/{id}',
          'GET /v1/lab-analyses/batch/{bottlingBatchId}',
        ]),
      );
      for (const name of [
        'CreateBottlingBatchDto',
        'CreateBatchLabAnalysisDto',
        'UpdatePhytoStatusDto',
        'DagGraphResponseDto',
      ]) {
        expect({ name, schema: schema(name) }).toEqual({
          name,
          schema: undefined,
        });
      }
    });

    it('las entradas no conservan campos obsoletos (salvo `status` del tanque)', () => {
      const deprecated = Object.entries(document.components?.schemas ?? {})
        .flatMap(([name, value]) =>
          Object.entries((value as SchemaObject).properties ?? {})
            .filter(([, prop]) => (prop as SchemaObject).deprecated)
            .map(([prop]) => `${name}.${prop}`),
        )
        .sort();
      // `status` del alta del tanque es el único legado que el contrato no
      // retira en H2 (§4.1): solo admite FILLING o FERMENTING y lo sustituye
      // `startFermentation`
      expect(deprecated).toEqual(['CreateFermentationTankDto.status']);
    });

    it('el pesaje no admite dictamen ni análisis plano en el alta', () => {
      expect(props('CreateHarvestBatchDto')).toEqual(
        expect.not.arrayContaining([
          'phytosanitaryStatus',
          'brixDegrees',
          'initialPh',
          'initialAcidityGl',
        ]),
      );
      expect(props('CreateHarvestBatchDto')).toContain('maturity');
    });

    it('la D.O. no es un dato de la entrada (parcelas y destilación)', () => {
      for (const name of [
        'CreateTerroirDto',
        'UpdateTerroirDto',
        'CreateDistillationBatchDto',
      ]) {
        expect({ name, props: props(name) }).toEqual({
          name,
          props: expect.not.arrayContaining(['isDoEligible']),
        });
      }
      // La respuesta sí la lleva, calculada
      expect(props('TerroirResponseDto')).toContain('isDoEligible');
    });

    it('el tanque se llena con `inputs` y con su volumen de mosto', () => {
      const tank = schema('CreateFermentationTankDto');
      expect(Object.keys(tank.properties ?? {})).not.toContain(
        'harvestBatchId',
      );
      expect(tank.required).toEqual(
        expect.arrayContaining(['inputs', 'volumeFilledLiters', 'tankCode']),
      );
    });

    it('la destilación se abre con su entrada y se cierra con cortes tipados', () => {
      const open = schema('CreateDistillationBatchDto');
      expect(open.required).toContain('inputVolumeLiters');
      expect(Object.keys(open.properties ?? {})).toEqual(
        expect.not.arrayContaining([
          'processEndDate',
          'outputVolumeLiters',
          'wasteVolumeLiters',
          'additionalParams',
        ]),
      );
      expect(schema('CloseDistillationDto').required).toEqual(
        expect.arrayContaining(['processEndDate', 'cuts', 'heartAbvPercent']),
      );
    });

    it('los archivos de la trazabilidad viajan por su `key`, no por una URL', () => {
      expect(props('CreateLotBottlingDto')).toContain('labelDesignKey');
      expect(props('CreateLotBottlingDto')).not.toContain('labelDesignUrl');
      const lab = schema('CreateLotLabAnalysisDto');
      expect(lab.required).toContain('laboratoryReportKey');
      expect(Object.keys(lab.properties ?? {})).toEqual(
        expect.not.arrayContaining([
          'laboratoryReportPdfUrl',
          'conformsToSenasagStandards',
          'bottlingBatchId',
        ]),
      );
      expect(props('CreatePhytoDecisionDto')).toContain('inspectionReportKey');
    });
  });
  describe('apertura de la Ola 3 (contrato O3 §12.1)', () => {
    const schema = (name: string) =>
      document.components?.schemas?.[name] as SchemaObject;
    const props = (name: string) => Object.keys(schema(name).properties ?? {});
    const find = (k: string) => ops.find((o) => key(o) === k)!;
    const refOf = (value: unknown): string | undefined => {
      const prop = value as SchemaObject & {
        allOf?: ReferenceObject[];
        $ref?: string;
      };
      return prop.$ref ?? prop.allOf?.[0]?.$ref;
    };

    /** Todas las rutas de la cadena y la tokenización, publicadas con 501. */
    const O3_ROUTES = [
      'GET /.well-known/stellar.toml',
      'GET /v1/collections',
      'GET /v1/collections/{id}',
      'GET /v1/collections/{id}/closure',
      'GET /v1/collections/{id}/tokens',
      'GET /v1/lots/{id}/tokenization',
      'GET /v1/organizations/current/chain-account',
      'GET /v1/platform/chain/accounts',
      'GET /v1/platform/chain/alerts',
      'GET /v1/platform/chain/events',
      'GET /v1/platform/chain/reconciliation/runs',
      'GET /v1/platform/chain/reconciliation/runs/{id}',
      'GET /v1/platform/chain/transactions',
      'GET /v1/platform/chain/transactions/{id}',
      'GET /v1/platform/collections',
      'GET /v1/platform/collections/{id}',
      'GET /v1/platform/collections/{id}/closure',
      'GET /v1/platform/collections/{id}/metrics',
      'GET /v1/platform/collections/{id}/tokens',
      'GET /v1/platform/collections/{id}/transactions',
      'GET /v1/platform/lot-closures',
      'GET /v1/platform/tokenization-requests',
      'GET /v1/platform/tokenization-requests/{id}',
      'GET /v1/platform/wineries/{id}/chain-account',
      'GET /v1/public/chain/registry',
      'GET /v1/public/collections/images/{imageId}',
      'GET /v1/public/lots/{lotCode}/verification',
      'GET /v1/public/nft/{winerySlug}/{tokenId}',
      'GET /v1/tokenization-requests',
      'GET /v1/tokenization-requests/{id}',
      'PATCH /v1/platform/collections/{id}',
      'PATCH /v1/platform/tokenization-requests/{id}',
      'PATCH /v1/tokenization-requests/{id}',
      'POST /v1/lots/{id}/tokenization-requests',
      'POST /v1/platform/chain/alerts/{id}/resolve',
      'POST /v1/platform/chain/reconciliation/runs',
      'POST /v1/platform/chain/transactions/{id}/abandon',
      'POST /v1/platform/chain/transactions/{id}/retry',
      'POST /v1/platform/collections/{id}/close',
      'POST /v1/platform/collections/{id}/closure/decide',
      'POST /v1/platform/collections/{id}/closure/items/{tokenId}/resolve',
      'POST /v1/platform/collections/{id}/pause',
      'POST /v1/platform/collections/{id}/publish',
      'POST /v1/platform/collections/{id}/resume',
      'POST /v1/platform/tokenization-requests/{id}/approve',
      'POST /v1/platform/tokenization-requests/{id}/notes',
      'POST /v1/platform/tokenization-requests/{id}/reject',
      'POST /v1/platform/tokenization-requests/{id}/request-changes',
      'POST /v1/platform/tokenization-requests/{id}/take',
      'POST /v1/platform/wineries/{id}/chain/pause',
      'POST /v1/platform/wineries/{id}/chain/provision',
      'POST /v1/platform/wineries/{id}/chain/unpause',
      'POST /v1/tokenization-requests/{id}/resubmit',
      'POST /v1/tokenization-requests/{id}/withdraw',
    ];

    /** `Idempotency-Key` obligatoria (contrato O3 §0). */
    const REQUIRED_IDEMPOTENCY = [
      'POST /v1/lots/{id}/tokenization-requests',
      'POST /v1/platform/chain/transactions/{id}/retry',
      'POST /v1/platform/collections/{id}/closure/decide',
      'POST /v1/platform/collections/{id}/pause',
      'POST /v1/platform/collections/{id}/publish',
      'POST /v1/platform/collections/{id}/resume',
      'POST /v1/platform/tokenization-requests/{id}/approve',
      'POST /v1/platform/wineries/{id}/chain/pause',
      'POST /v1/platform/wineries/{id}/chain/unpause',
      'POST /v1/tokenization-requests/{id}/resubmit',
    ];

    // Con lógica desde los pasos 3.1 (firmante y transacciones) y 3.2
    // (identidad de la bodega): ya no declaran 501
    const O3_CHAIN_IMPLEMENTED = [
      'GET /.well-known/stellar.toml',
      'GET /v1/organizations/current/chain-account',
      'GET /v1/platform/chain/accounts',
      'GET /v1/platform/chain/transactions',
      'GET /v1/platform/chain/transactions/{id}',
      'GET /v1/platform/wineries/{id}/chain-account',
      'GET /v1/public/chain/registry',
      'POST /v1/platform/chain/transactions/{id}/abandon',
      'POST /v1/platform/chain/transactions/{id}/retry',
      'POST /v1/platform/wineries/{id}/chain/pause',
      'POST /v1/platform/wineries/{id}/chain/provision',
      'POST /v1/platform/wineries/{id}/chain/unpause',
    ];
    /** Rutas con lógica: las de la cadena (3.1, 3.2) y las del paso 3.3. */
    const O3_IMPLEMENTED = new Set<string>([
      ...O3_CHAIN_IMPLEMENTED,
      ...O3_STEP_3_3_ROUTES,
    ]);
    const O3_PENDING = O3_ROUTES.filter((route) => !O3_IMPLEMENTED.has(route));

    it('publica las 54 rutas del contrato; las pendientes de su paso, con su 501 NOT_IMPLEMENTED', () => {
      expect(O3_ROUTES).toHaveLength(54);
      expect(O3_ROUTES.filter((route) => !find(route))).toEqual([]);
      expect(O3_IMPLEMENTED.size).toBe(
        O3_CHAIN_IMPLEMENTED.length + O3_STEP_3_3_ROUTES.length,
      );
      expect(O3_PENDING).toHaveLength(54 - O3_IMPLEMENTED.size);
      const declared = ops
        .filter((op) => op.responses['501'])
        .map(key)
        .sort();
      expect(declared).toEqual(O3_PENDING);
      for (const route of O3_PENDING) {
        const response = find(route).responses['501'] as {
          description: string;
          content?: Record<string, { schema?: unknown }>;
        };
        expect({ route, description: response.description }).toEqual({
          route,
          description: expect.stringMatching(
            /^NOT_IMPLEMENTED: llega con el paso 3\.[3-6] de la Etapa 3/,
          ),
        });
        expect(response.content?.['application/json']?.schema).toEqual({
          $ref: '#/components/schemas/ApiErrorResponseDto',
        });
      }
    });

    it('usa las etiquetas Chain, Tokenization y Public', () => {
      const tags = new Set(
        O3_ROUTES.flatMap((route) => find(route).tags ?? []),
      );
      expect([...tags].sort()).toEqual(['Chain', 'Public', 'Tokenization']);
      for (const route of O3_ROUTES) {
        const isPublic =
          route.includes('/v1/public/') || route.includes('/.well-known/');
        expect({ route, tags: find(route).tags }).toEqual({
          route,
          tags: isPublic
            ? ['Public']
            : [expect.stringMatching(/^(Chain|Tokenization)$/)],
        });
      }
    });

    it('exige Idempotency-Key donde el contrato la hace obligatoria (§0)', () => {
      const required = ops
        .filter((op) =>
          (op.parameters ?? []).some(
            (p) =>
              !('$ref' in p) &&
              p.in === 'header' &&
              p.name === 'Idempotency-Key' &&
              p.required,
          ),
        )
        .map(key)
        .sort();
      expect(required).toEqual(REQUIRED_IDEMPOTENCY);
      // Autorizar, reenviar, aprobar, publicar, pausar, reanudar, decidir el
      // cierre, reintentar una transacción y pausar o reanudar un contrato
      expect(required).toHaveLength(10);
    });

    it('las acciones del back office sobre una bodega declaran el motivo obligatorio', () => {
      const withReason = ops
        .filter(
          (op) =>
            O3_ROUTES.includes(key(op)) &&
            (op as unknown as Record<string, unknown>)['x-requires-reason'] ===
              'always',
        )
        .map(key)
        .sort();
      expect(withReason).toEqual([
        'PATCH /v1/platform/collections/{id}',
        'POST /v1/platform/chain/transactions/{id}/abandon',
        'POST /v1/platform/chain/transactions/{id}/retry',
        'POST /v1/platform/collections/{id}/close',
        'POST /v1/platform/collections/{id}/closure/decide',
        'POST /v1/platform/collections/{id}/pause',
        'POST /v1/platform/tokenization-requests/{id}/reject',
        'POST /v1/platform/wineries/{id}/chain/pause',
        'POST /v1/platform/wineries/{id}/chain/provision',
        'POST /v1/platform/wineries/{id}/chain/unpause',
      ]);
    });

    it('stellar.toml queda fuera de /v1 y responde text/plain', () => {
      const toml = document.paths['/.well-known/stellar.toml'].get!;
      const ok = toml.responses['200'] as {
        content: Record<string, unknown>;
      };
      expect(Object.keys(ok.content)).toEqual(['text/plain']);
      expect(document.paths['/v1/.well-known/stellar.toml']).toBeUndefined();
    });

    it('LotSummary lleva la marca de tokenización (aditivo, O2 §2.1)', () => {
      expect(schema('LotSummaryDto').required).toContain('tokenization');
      expect(refOf(schema('LotSummaryDto').properties!.tokenization)).toBe(
        '#/components/schemas/LotTokenizationMarkDto',
      );
      expect(schema('LotTokenizationState').enum).toEqual([
        'NONE',
        'REQUESTED',
        'CHANGES_REQUESTED',
        'MINTING',
        'MINT_FAILED',
        'READY',
        'PUBLISHED',
        'PAUSED',
        'CLOSED',
      ]);
      // `Lot` la hereda
      expect(props('LotDto')).toContain('tokenization');
    });

    it('la línea de tiempo admite los eventos de la tokenización y el anclaje', () => {
      const types = (schema('LotEventDto').properties!.type as SchemaObject)
        .enum as string[];
      expect(types).toEqual(
        expect.arrayContaining([
          'TOKENIZATION_AUTHORIZED',
          'NFT_MINTED',
          'COLLECTION_PUBLISHED',
          'DOSSIER_ANCHORED',
          'TOKENS_REDEEMABLE',
          'SHORTFALL_DETECTED',
          // Los de la Ola 2 siguen ahí
          'LOT_CREATED',
          'DOSSIER_CLOSED',
        ]),
      );
    });

    it('el anclaje del expediente tiene forma (y sigue siendo anulable)', () => {
      const anchor = schema('LotDossierDto').properties!.anchor as SchemaObject;
      expect(anchor.nullable).toBe(true);
      expect(refOf(anchor)).toBe('#/components/schemas/DossierAnchorDto');
      const publicAnchor = schema('PublicDossierDto').properties!
        .anchor as SchemaObject;
      expect(publicAnchor.nullable).toBe(true);
      expect(refOf(publicAnchor)).toBe(
        '#/components/schemas/PublicDossierAnchorDto',
      );
      expect(schema('DossierAnchorStatus').enum).toEqual([
        'PENDING',
        'SUBMITTED',
        'ANCHORED',
        'FAILED',
      ]);
      // En público, FAILED se muestra como PENDING (S-17)
      expect(schema('PublicDossierAnchorStatus').enum).toEqual([
        'PENDING',
        'ANCHORED',
      ]);
      expect(
        (schema('PublicLotPassportDto').properties!.stage as SchemaObject).enum,
      ).toContain('ANCHORED');
    });

    it('el tablero y el panel del ERP llevan sus bloques nuevos', () => {
      expect(schema('DashboardDto').required).toEqual(
        expect.arrayContaining(['tokenization', 'chain']),
      );
      expect(props('DashboardTokenizationDto')).toEqual([
        'submitted',
        'inReview',
        'changesRequested',
        'oldestOpenHours',
        'collectionsMinting',
        'mintFailures',
        'collectionsPublished',
        'shortfallsOpen',
      ]);
      expect(props('DashboardChainDto')).toEqual([
        'network',
        'operationsBalanceXlm',
        'anchorBalanceXlm',
        'failedTransactions',
        'stuckTransactions',
        'openAlerts',
        'lastReconciliation',
        'indexerLagSeconds',
      ]);
      expect(props('TraceDashboardTokenizationDto')).toEqual([
        'openRequests',
        'changesRequested',
        'collectionsPublished',
      ]);
      expect(schema('TraceDashboardDto').required).toContain('tokenization');
    });

    it('las enumeraciones de la cadena y la tokenización son las del contrato', () => {
      expect(schema('ChainNetwork').enum).toEqual([
        'TESTNET',
        'PUBLIC',
        'LOCAL',
      ]);
      expect(schema('ChainTxStatus').enum).toEqual([
        'PENDING',
        'BUILDING',
        'SUBMITTED',
        'CONFIRMED',
        'RETRYING',
        'FAILED',
      ]);
      expect(schema('ChainTxKind').enum).toEqual([
        'CREATE_WINERY_ACCOUNT',
        'DEPLOY_WINERY_CONTRACT',
        'SET_TOKEN_URI_BASE',
        'MINT_BATCH',
        'ANCHOR_DOSSIER',
        'PAUSE_CONTRACT',
        'UNPAUSE_CONTRACT',
        'BURN_UNSOLD',
        'EXTEND_TTL',
        'RESTORE_ENTRIES',
        'FUND_ACCOUNT',
        'OPERATOR_TRANSFER',
        'REDEEM_BURN',
      ]);
      expect(schema('ChainIdentityStatus').enum).toEqual([
        'NOT_PROVISIONED',
        'PROVISIONING',
        'ACTIVE',
        'FAILED',
        'PAUSED',
      ]);
      expect(schema('TokenizationRequestStatus').enum).toEqual([
        'SUBMITTED',
        'IN_REVIEW',
        'CHANGES_REQUESTED',
        'APPROVED',
        'REJECTED',
        'WITHDRAWN',
      ]);
      expect(schema('CollectionStatus').enum).toEqual([
        'MINTING',
        'READY',
        'PUBLISHED',
        'PAUSED',
        'CLOSED',
      ]);
      expect(schema('TokenStatus').enum).toEqual([
        'MINTED',
        'RESERVED',
        'SOLD',
        'REDEEMABLE',
        'PASS_ACTIVE',
        'REDEEMED',
        'BURNED',
        'EXPIRED',
      ]);
      expect(schema('LotClosureStatus').enum).toEqual([
        'NO_SHORTFALL',
        'SHORTFALL_OPEN',
        'DECIDED',
        'RESOLVED',
      ]);
      expect(schema('PriceCurrency').enum).toEqual(['BOB']);
    });

    it('ChainTxRef es lo que ven las apps; la transacción completa, solo la plataforma', () => {
      expect(props('ChainTxRefDto')).toEqual([
        'id',
        'kind',
        'status',
        'network',
        'txHash',
        'explorerUrl',
        'ledger',
        'confirmedAt',
        'attempts',
        'lastError',
        'createdAt',
        'updatedAt',
      ]);
      // Ningún esquema expone XDR, claves ni semillas. El único "secreto" del
      // contrato es el del alta del TOTP, que se muestra una vez a su dueño
      const leaked = Object.entries(document.components?.schemas ?? {})
        .flatMap(([name, value]) =>
          Object.keys((value as SchemaObject).properties ?? {}).map(
            (prop) => `${name}.${prop}`,
          ),
        )
        .filter((field) => /xdr|secret|seed|privateKey|mnemonic/i.test(field));
      expect(leaked).toEqual(['MfaEnrollResponseDto.secret']);
    });

    it('las imágenes públicas de las colecciones las sirve la API (U-5)', () => {
      const image = find('GET /v1/public/collections/images/{imageId}');
      expect(image.security).toEqual([]);
      const ok = image.responses['200'] as { content: Record<string, unknown> };
      expect(Object.keys(ok.content).sort()).toEqual([
        'image/gif',
        'image/jpeg',
        'image/png',
        'image/webp',
      ]);
      expect(props('CollectionImageDto')).toEqual([
        'id',
        'key',
        'sha256',
        'url',
        'alt',
        'isCover',
      ]);
      expect(props('CollectionSummaryDto')).toContain('coverImageUrl');
    });

    it('la billetera legada declara su 404 CHN_WALLET_NOT_AVAILABLE (SE-02)', () => {
      const wallet = find('GET /v1/users/me/wallet');
      expect(
        (wallet.responses['404'] as { description: string }).description,
      ).toContain('CHN_WALLET_NOT_AVAILABLE');
    });
  });
});
