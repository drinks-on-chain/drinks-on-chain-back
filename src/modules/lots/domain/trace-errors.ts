import { AppException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';
import type { ErrorDetail } from '@shared/interfaces/api-response.interface';

/**
 * Error de una regla de la trazabilidad (contrato O2 §0 y §13): estado del
 * recurso → 409; regla de negocio incumplida → 422; plataforma escribiendo →
 * 403. `details` lleva un `ErrorDetail` ampliado por violación (`code`,
 * `rule`, `expected`, `actual`, `meta`) para que la UI explique qué regla se
 * incumple y cuándo se podrá hacer.
 */
export class TraceRuleException extends AppException {
  constructor(
    statusCode: 403 | 404 | 409 | 422 | 501,
    errorCode: string,
    message: string,
    public readonly violations: ErrorDetail[] = [],
  ) {
    super(
      statusCode,
      errorCode,
      message,
      violations.length > 0 ? violations : undefined,
    );
  }
}

type DetailExtras = Omit<Partial<ErrorDetail>, 'code' | 'message'>;

/** Una violación (`ErrorDetail` ampliado) con su código `TRC_…`. */
export function violation(
  code: string,
  message: string,
  extras: DetailExtras = {},
): ErrorDetail {
  const detail: ErrorDetail = {
    field: extras.field ?? null,
    message,
    code,
  };
  if (extras.rule !== undefined) detail.rule = extras.rule;
  if (extras.expected !== undefined) detail.expected = extras.expected;
  if (extras.actual !== undefined) detail.actual = extras.actual;
  if (extras.meta !== undefined) detail.meta = extras.meta;
  return detail;
}

/** 422: regla de negocio incumplida. */
export function ruleError(
  code: string,
  message: string,
  details: ErrorDetail[] = [],
): TraceRuleException {
  return new TraceRuleException(422, code, message, details);
}

/** 409: acción no permitida en el estado actual del recurso. */
export function stateError(
  code: string,
  message: string,
  details: ErrorDetail[] = [],
): TraceRuleException {
  return new TraceRuleException(409, code, message, details);
}

/**
 * Lanza el primer código de una lista de violaciones (en el orden de las
 * reglas del contrato) con todas ellas en `details`. No hace nada si la lista
 * está vacía.
 */
export function throwViolations(
  violations: ErrorDetail[],
  message?: string,
  status: 409 | 422 = 422,
): void {
  if (violations.length === 0) return;
  const first = violations[0];
  throw new TraceRuleException(
    status,
    first.code ?? ErrorCode.UNPROCESSABLE_ENTITY,
    message ?? first.message,
    violations,
  );
}

/** 404 del lote (inexistente o de otra bodega: nunca 403). */
export function lotNotFound(): TraceRuleException {
  return new TraceRuleException(
    404,
    ErrorCode.TRC_LOT_NOT_FOUND,
    'Lote no encontrado',
  );
}

/**
 * 501 de una ruta del contrato publicada en el OpenAPI cuya lógica llega en
 * un paso posterior de la Etapa 2 (contrato O2 §16.1, fase de apertura).
 */
export function notImplemented(step: string): TraceRuleException {
  return new TraceRuleException(
    501,
    ErrorCode.NOT_IMPLEMENTED,
    `Ruta del contrato de la Ola 2 aún sin lógica (llega con el paso ${step} de la Etapa 2)`,
    [
      {
        field: null,
        message: `Disponible con el paso ${step}; mientras tanto, usa los mocks v2`,
        meta: { step },
      },
    ],
  );
}
