import { ValidationPipe } from '@nestjs/common';
import {
  ValidationException,
  flattenValidationErrors,
} from '../exceptions/validation.exception';

/**
 * `ValidationPipe` global del API (contrato O0 §1, A-33): cuerpo, query y
 * parámetros inválidos → 422 `VALIDATION_ERROR` con
 * `details: [{ field, message }]` (notación de puntos en los anidados).
 */
export function createAppValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors) =>
      new ValidationException(flattenValidationErrors(errors)),
  });
}
