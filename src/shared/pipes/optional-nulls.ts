import { getMetadataStorage, ValidationTypes } from 'class-validator';

/**
 * `null` en los campos opcionales del cuerpo (contrato O0 §1).
 *
 * `@IsOptional()` de class-validator deja pasar `null` sin validar, y los
 * servicios lo trataban como un valor (`new Prisma.Decimal(null)`,
 * `null.trim()`…) → 500. Regla global del API: en un cuerpo, `null` en una
 * propiedad `@IsOptional()` equivale a **omitirla**. Si `null` significa
 * "borrar el valor" (un PATCH sobre una columna anulable), el DTO lo declara
 * con `@NullableFields(...)` y entonces se conserva.
 *
 * Solo se mira el primer nivel del cuerpo: los objetos libres (GeoJSON,
 * `additionalParams`) y los DTO anidados se dejan como vienen. Las propiedades
 * obligatorias con `null` siguen fallando en su validación (422).
 */

type Ctor = abstract new (...args: never[]) => unknown;

const NULLABLE_FIELDS = new WeakMap<object, ReadonlySet<string>>();
const OPTIONAL_CACHE = new WeakMap<object, ReadonlySet<string>>();

/**
 * Campos del DTO en los que `null` es un valor válido (borra el dato) y no
 * se descarta. Se hereda por `extends`.
 */
export function NullableFields(...fields: string[]): ClassDecorator {
  return (target) => {
    NULLABLE_FIELDS.set(target, new Set(fields));
  };
}

function nullableFields(target: Ctor): Set<string> {
  const out = new Set<string>();
  let current: unknown = target;
  while (typeof current === 'function' && current !== Function.prototype) {
    for (const field of NULLABLE_FIELDS.get(current) ?? []) out.add(field);
    current = Object.getPrototypeOf(current);
  }
  return out;
}

function optionalFields(target: Ctor): ReadonlySet<string> {
  const cached = OPTIONAL_CACHE.get(target);
  if (cached) return cached;
  const nullable = nullableFields(target);
  const fields = new Set(
    getMetadataStorage()
      .getTargetValidationMetadatas(target as never, '', true, false)
      .filter(
        (m) =>
          m.type === ValidationTypes.CONDITIONAL_VALIDATION &&
          m.name === 'isOptional',
      )
      .map((m) => m.propertyName)
      .filter((name) => !nullable.has(name)),
  );
  OPTIONAL_CACHE.set(target, fields);
  return fields;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Copia de `body` sin las propiedades opcionales que llegan a `null` (salvo
 * las de `@NullableFields`). Devuelve el mismo objeto si no hay nada que
 * quitar.
 */
export function dropOptionalNulls(body: unknown, metatype: Ctor): unknown {
  if (!isPlainObject(body)) return body;
  const optional = optionalFields(metatype);
  if (optional.size === 0) return body;
  let out: Record<string, unknown> | null = null;
  for (const key of Object.keys(body)) {
    if (body[key] === null && optional.has(key)) {
      out ??= { ...body };
      delete out[key];
    }
  }
  return out ?? body;
}
