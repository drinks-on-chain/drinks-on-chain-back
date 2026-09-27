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
 */
export interface ErrorDetail {
  field: string | null;
  message: string;
}

export interface ApiErrorResponse {
  success: false;
  statusCode: number;
  timestamp: string;
  path: string;
  error: {
    code: string;
    message: string;
    /** Siempre una lista de `{ field, message }` o `null`. */
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
