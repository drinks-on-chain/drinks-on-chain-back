import { Prisma } from '@prisma/client';

/**
 * Decimales en las respuestas JSON (contrato: `number`).
 *
 * `Prisma.Decimal` (decimal.js) se serializa con `toJSON()` como **texto**
 * (`"5"`), mientras que el OpenAPI y los mocks declaran `number`. Esta función
 * devuelve el mismo valor con cada decimal convertido a número JSON:
 *
 * - Recorre solo arrays y objetos planos (resultados de Prisma, DTOs
 *   literales). Deja intactos `Date`, `Buffer`/`TypedArray`, flujos,
 *   `StreamableFile` y cualquier otra instancia de clase.
 * - Copia solo lo que cambia: si no hay decimales, devuelve la misma
 *   referencia (sin coste de memoria).
 * - Tolera referencias compartidas y ciclos.
 * - Un decimal no finito (`NaN`, `±Infinity`) sale como `null`, igual que haría
 *   `JSON.stringify` con un número no finito.
 *
 * Las columnas `Decimal` del esquema tienen como mucho 12 dígitos
 * (`@db.Decimal(12, s)`), así que caben en un `double` (15) sin perder
 * precisión; una columna nueva no debe pasar de 15. El dinero
 * no pasa por aquí: va en enteros de centavos (reglas de la API).
 */
export function decimalsToNumbers<T>(value: T): T {
  return convert(value, new WeakMap()) as T;
}

/** `true` si es un `Prisma.Decimal` o un `Decimal` de decimal.js. */
export function isDecimal(value: unknown): value is Prisma.Decimal {
  return (
    typeof value === 'object' &&
    value !== null &&
    Prisma.Decimal.isDecimal(value)
  );
}

/** Número JSON de un decimal (`null` si no es finito). */
export function decimalToNumber(value: Prisma.Decimal): number | null {
  const n = value.toNumber();
  return Number.isFinite(n) ? n : null;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function convert(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (isDecimal(value)) return decimalToNumber(value);

  const cached = seen.get(value);
  if (cached !== undefined) return cached;

  if (Array.isArray(value)) {
    // Mientras se recorre, un ciclo apunta al original
    seen.set(value, value);
    let out: unknown[] | null = null;
    for (let i = 0; i < value.length; i++) {
      const item: unknown = value[i];
      const next = convert(item, seen);
      if (next !== item) {
        out ??= value.slice();
        out[i] = next;
      }
    }
    const result = out ?? value;
    seen.set(value, result);
    return result;
  }

  if (!isPlainObject(value)) return value;

  seen.set(value, value);
  let out: Record<string, unknown> | null = null;
  for (const key of Object.keys(value)) {
    const inner = value[key];
    const next = convert(inner, seen);
    if (next !== inner) {
      out ??= { ...value };
      out[key] = next;
    }
  }
  const result = out ?? value;
  seen.set(value, result);
  return result;
}
