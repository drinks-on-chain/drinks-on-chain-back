import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';
import {
  ValidationException,
  flattenValidationErrors,
} from '../exceptions/validation.exception';
import { dropOptionalNulls } from './optional-nulls';

/**
 * `ValidationPipe` que, en los cuerpos, trata `null` en un campo
 * `@IsOptional()` como omitido (salvo `@NullableFields`): ver
 * `optional-nulls.ts`.
 */
export class AppValidationPipe extends ValidationPipe {
  override async transform(
    value: unknown,
    metadata: ArgumentMetadata,
  ): Promise<unknown> {
    const input =
      metadata.type === 'body' && typeof metadata.metatype === 'function'
        ? dropOptionalNulls(value, metadata.metatype)
        : value;
    return super.transform(input, metadata);
  }
}

/**
 * `ValidationPipe` global del API (contrato O0 §1, A-33): cuerpo, query y
 * parámetros inválidos → 422 `VALIDATION_ERROR` con
 * `details: [{ field, message }]` (notación de puntos en los anidados).
 * `null` en un opcional del cuerpo = omitido.
 */
export function createAppValidationPipe(): ValidationPipe {
  return new AppValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors) =>
      new ValidationException(flattenValidationErrors(errors)),
  });
}
