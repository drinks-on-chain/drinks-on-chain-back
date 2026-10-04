export interface ApiSuccessResponse<T> {
  success: true;
  statusCode: number;
  timestamp: string;
  path: string;
  data: T;
}

/**
 * Detalle de un error (contrato O0 §1): `field` con notación de puntos para
 * los anidados (`items.0.quantity`) o `null` si el error no es de un campo.
 *
 * Los errores de reglas de la trazabilidad (contrato O2 §0) lo amplían de
 * forma aditiva con el código de la violación, la regla de la instantánea,
 * el valor exigido y el registrado, y datos para que la UI arme su
 * explicación (`meta`).
 */
export interface ErrorDetail {
  field: string | null;
  message: string;
  /** `TRC_…` de esta violación (una respuesta puede traer varias). */
  code?: string;
  /** Clave del parámetro de la instantánea (`trazabilidad.singani.reposoMinimoDias`). */
  rule?: string;
  /** Valor exigido. */
  expected?: unknown;
  /** Valor registrado. */
  actual?: unknown;
  /** Datos para la UI (`daysRemaining`, `sourceId`, `unit`…). */
  meta?: Record<string, unknown>;
}

export interface ApiErrorResponse {
  success: false;
  statusCode: number;
  timestamp: string;
  path: string;
  error: {
    code: string;
    message: string;
    /** Siempre una lista de `{ field, message, …ampliación O2 }` o `null`. */
    details: ErrorDetail[] | null;
  };
}

/**
 * Página de una colección (contrato O0 §2, A-33): todo `GET` de colección
 * devuelve `data: { items, total, limit, offset }`.
 */
export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}
