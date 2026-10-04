/**
 * JSON canónico RFC 8785 (JCS) para el expediente del lote (contrato O2 §10).
 *
 * - Objetos: propiedades ordenadas por las unidades de código UTF-16 de su
 *   nombre (§3.2.3), sin espacios.
 * - Cadenas: el escapado de `JSON.stringify` de ECMAScript (§3.2.2.2).
 * - Números: la serialización de ECMAScript (§3.2.2.3); `-0` es `0`. Los no
 *   finitos se rechazan (no existen en JSON).
 * - Es estricto: `undefined`, fechas, `Decimal`, `bigint` y cualquier objeto
 *   que no sea un objeto literal o una lista se rechazan. Quien arma el
 *   expediente convierte antes cada valor (decimales a cadenas de escala
 *   fija, fechas a ISO 8601), así que dos expedientes con los mismos datos
 *   producen exactamente los mismos bytes UTF-8.
 */
export function canonicalize(value: unknown): string {
  return serialize(value, '$');
}

/** Bytes UTF-8 del JSON canónico (lo que se hashea). */
export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalize(value), 'utf8');
}

const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function serializeString(value: string, path: string): string {
  if (LONE_SURROGATE.test(value)) {
    throw new Error(`JCS: texto con Unicode inválido en ${path}`);
  }
  return JSON.stringify(value);
}

function serialize(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error(`JCS: número no finito en ${path}`);
      }
      return JSON.stringify(value);
    case 'string':
      return serializeString(value, path);
    case 'object':
      break;
    default:
      throw new Error(`JCS: valor ${typeof value} no admitido en ${path}`);
  }
  if (Array.isArray(value)) {
    const items = value.map((item, i) => serialize(item, `${path}[${i}]`));
    return `[${items.join(',')}]`;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(
      `JCS: objeto no literal en ${path} (convierte fechas y decimales antes)`,
    );
  }
  const record = value as Record<string, unknown>;
  const members = Object.keys(record)
    .sort()
    .map(
      (key) =>
        `${serializeString(key, path)}:${serialize(record[key], `${path}.${key}`)}`,
    );
  return `{${members.join(',')}}`;
}
