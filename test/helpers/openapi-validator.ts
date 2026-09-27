import Ajv, { ErrorObject, ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Validador de respuestas contra `openapi.json` (el contrato versionado que
 * consumen el ERP, los mocks y el cliente de API).
 *
 * Uso en cualquier suite e2e:
 *
 *   const openapi = loadOpenApiValidator();
 *   const res = await http().get('/v1/terroirs').expect(200);
 *   openapi.expectResponse('get', '/v1/terroirs', res);
 *
 * - La ruta puede ser la concreta (`/v1/terroirs/5f1c…?limit=5`) o la plantilla
 *   (`/v1/terroirs/{id}`); los segmentos literales ganan a los parámetros.
 * - Respuestas 2xx: el documento describe `data` (el envoltorio
 *   `{ success, statusCode, timestamp, path, data }` es común y también se
 *   comprueba). Errores: el cuerpo entero (`ApiErrorResponseDto`).
 * - Tipos estrictos: un número que llegue como texto (`"5"`) falla. Los
 *   `nullable: true` de OpenAPI 3.0 se traducen a JSON Schema (`null` válido).
 * - Una respuesta cuyo código no esté documentado, o documentado sin esquema,
 *   también falla: el contrato debe describirla.
 */
export interface OpenApiValidator {
  /** Errores de validación (lista vacía si la respuesta cumple el contrato). */
  validate(
    method: string,
    path: string,
    status: number,
    body: unknown,
  ): string[];
  /** Falla la prueba (con el detalle) si la respuesta no cumple el contrato. */
  expectResponse(
    method: string,
    path: string,
    res: { status: number; body: unknown },
  ): void;
  /** Plantilla OpenAPI de una ruta concreta (`/v1/terroirs/{id}`). */
  resolvePath(method: string, path: string): string | null;
  /** Operaciones validadas hasta ahora (`GET /v1/terroirs 200`). */
  readonly covered: ReadonlySet<string>;
}

type JsonObject = Record<string, unknown>;

const OPENAPI_ID = 'openapi.json';

/** JSON Pointer (RFC 6901) de un segmento. */
function pointer(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * Convierte los esquemas de OpenAPI 3.0 a JSON Schema: `nullable: true` →
 * admite `null` (en `type`, en `enum` y en esquemas sin `type` como
 * `allOf: [{ $ref }]`).
 */
function toJsonSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toJsonSchema);
  if (typeof node !== 'object' || node === null) return node;
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(node as JsonObject)) {
    out[key] = toJsonSchema(value);
  }
  if (out.nullable !== true) return out;
  delete out.nullable;
  // `{ type: 'object', nullable: true, allOf: [{ $ref }] }` (lo que emite
  // @nestjs/swagger): el `null` tiene que escapar también del `allOf`
  const composed = ['allOf', 'anyOf', 'oneOf', '$ref'].some((k) => k in out);
  if (typeof out.type === 'string' && !composed) {
    out.type = [out.type, 'null'];
    if (Array.isArray(out.enum) && !out.enum.includes(null)) {
      out.enum = [...(out.enum as unknown[]), null];
    }
    return out;
  }
  return { anyOf: [out, { type: 'null' }] };
}

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((e) => {
    const where = e.instancePath || '(raíz)';
    const extra =
      e.keyword === 'additionalProperties'
        ? ` (${String((e.params as { additionalProperty?: string }).additionalProperty)})`
        : '';
    return `${where}: ${e.message ?? e.keyword}${extra}`;
  });
}

export function loadOpenApiValidator(
  file = join(__dirname, '..', '..', 'openapi.json'),
): OpenApiValidator {
  const document = JSON.parse(readFileSync(file, 'utf8')) as {
    paths: Record<string, Record<string, JsonObject>>;
    components?: JsonObject;
  };

  const ajv = new Ajv({
    strict: false, // `example`, `deprecated`… son de OpenAPI, no de JSON Schema
    allErrors: true,
    allowUnionTypes: true,
  });
  addFormats(ajv);
  // Solo hacen falta los componentes: las respuestas se compilan por referencia
  ajv.addSchema(
    {
      $id: OPENAPI_ID,
      components: toJsonSchema(document.components ?? {}),
      paths: toJsonSchema(document.paths),
    },
    OPENAPI_ID,
  );

  const templates = Object.keys(document.paths).map((template) => ({
    template,
    segments: template.split('/'),
  }));
  const compiled = new Map<string, ValidateFunction | null>();
  const covered = new Set<string>();

  function resolvePath(method: string, path: string): string | null {
    const clean = path.split('?')[0].replace(/\/+$/, '') || '/';
    const segments = clean.split('/');
    let best: { template: string; literals: number } | null = null;
    for (const { template, segments: parts } of templates) {
      if (parts.length !== segments.length) continue;
      if (!document.paths[template][method.toLowerCase()]) continue;
      let literals = 0;
      const matches = parts.every((part, i) => {
        if (part.startsWith('{') && part.endsWith('}')) {
          return segments[i].length > 0;
        }
        if (part === segments[i]) {
          literals++;
          return true;
        }
        return false;
      });
      if (matches && (!best || literals > best.literals)) {
        best = { template, literals };
      }
    }
    return best?.template ?? null;
  }

  function validatorFor(
    method: string,
    template: string,
    status: number,
  ): ValidateFunction | null | 'undocumented' {
    const operation = document.paths[template][method.toLowerCase()] as {
      responses?: Record<
        string,
        { content?: Record<string, { schema?: unknown }> }
      >;
    };
    const responses = operation.responses ?? {};
    const code = String(status);
    const key =
      code in responses
        ? code
        : `${code[0]}XX` in responses
          ? `${code[0]}XX`
          : 'default' in responses
            ? 'default'
            : null;
    if (!key) return 'undocumented';
    const cacheKey = `${method} ${template} ${key}`;
    if (compiled.has(cacheKey)) return compiled.get(cacheKey) ?? null;
    const json = responses[key].content?.['application/json'];
    const validate = json?.schema
      ? ajv.compile({
          $ref: `${OPENAPI_ID}#/paths/${pointer(template)}/${method.toLowerCase()}/responses/${key}/content/${pointer('application/json')}/schema`,
        })
      : null;
    compiled.set(cacheKey, validate);
    return validate;
  }

  function validate(
    method: string,
    path: string,
    status: number,
    body: unknown,
  ): string[] {
    const template = resolvePath(method, path);
    const label = `${method.toUpperCase()} ${path} ${status}`;
    if (!template) return [`${label}: la ruta no está en openapi.json`];
    const validator = validatorFor(method, template, status);
    if (validator === 'undocumented') {
      return [`${label}: el código ${status} no está documentado`];
    }
    covered.add(`${method.toUpperCase()} ${template} ${status}`);
    if (status === 204) return [];
    if (validator === null) {
      return [`${label}: la respuesta no tiene esquema en openapi.json`];
    }

    const errors: string[] = [];
    let payload = body;
    if (status >= 200 && status < 300) {
      const envelope = body as JsonObject | null;
      if (
        typeof envelope !== 'object' ||
        envelope === null ||
        envelope.success !== true ||
        typeof envelope.statusCode !== 'number' ||
        typeof envelope.timestamp !== 'string' ||
        typeof envelope.path !== 'string' ||
        !('data' in envelope)
      ) {
        return [`${label}: sin el envoltorio { success, statusCode, data }`];
      }
      payload = envelope.data;
    }
    if (!validator(payload)) {
      errors.push(
        ...formatErrors(validator.errors).map((e) => `${label} → ${e}`),
      );
    }
    return errors;
  }

  return {
    validate,
    resolvePath,
    covered,
    expectResponse(method, path, res) {
      const errors = validate(method, path, res.status, res.body);
      if (errors.length > 0) {
        throw new Error(
          `La respuesta no cumple openapi.json:\n  ${errors.slice(0, 25).join('\n  ')}`,
        );
      }
    },
  };
}
