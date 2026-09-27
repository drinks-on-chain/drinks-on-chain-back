import type { ValidationError } from 'class-validator';
import type { ErrorDetail } from '../interfaces/api-response.interface';
import { AppException } from './app.exception';
import { ErrorCode } from './error-codes';

/**
 * Error de validación (422 `VALIDATION_ERROR`, contrato O0 §1) con un detalle
 * por regla incumplida. Lo lanza el `ValidationPipe` global y también los
 * servicios cuando una comprobación de un campo depende de otro
 * (p. ej. bruto > tara).
 */
export class ValidationException extends AppException {
  constructor(
    details: ErrorDetail[],
    message = 'Validation failed',
    errorCode: string = ErrorCode.VALIDATION_ERROR,
  ) {
    super(422, errorCode, message, details);
  }

  /** Atajo para un solo campo. */
  static forField(field: string | null, message: string): ValidationException {
    return new ValidationException([{ field, message }]);
  }
}

/**
 * Aplana los errores de class-validator en `[{ field, message }]`, con la ruta
 * del campo en notación de puntos (`items.0.quantity`) y un detalle por
 * restricción incumplida. El orden sigue el de los errores recibidos.
 */
export function flattenValidationErrors(
  errors: readonly ValidationError[],
  parentPath = '',
): ErrorDetail[] {
  const details: ErrorDetail[] = [];
  for (const error of errors) {
    const field = parentPath
      ? `${parentPath}.${error.property}`
      : error.property;
    for (const message of Object.values(error.constraints ?? {})) {
      details.push({ field: field || null, message });
    }
    if (error.children && error.children.length > 0) {
      details.push(...flattenValidationErrors(error.children, field));
    }
  }
  return details;
}
