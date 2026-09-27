import { SetMetadata, UseInterceptors, applyDecorators } from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_METADATA,
  IdempotencyInterceptor,
  type IdempotentOptions,
} from './idempotency.interceptor';

/**
 * Hace idempotente una operación con la cabecera `Idempotency-Key`
 * (contrato O0 §3). Ver `IdempotencyInterceptor`.
 */
export function Idempotent(options: IdempotentOptions = {}) {
  return applyDecorators(
    SetMetadata(IDEMPOTENT_METADATA, options),
    UseInterceptors(IdempotencyInterceptor),
    ApiHeader({
      name: IDEMPOTENCY_KEY_HEADER,
      required: options.required ?? false,
      schema: { type: 'string', format: 'uuid' },
      description:
        'UUID que identifica la operación. Misma clave y mismo cuerpo en 24 h → la misma respuesta ' +
        '(cabecera `Idempotent-Replayed: true`); otro cuerpo → 409 `IDEMPOTENCY_KEY_REUSED`; ' +
        'mientras la primera sigue en curso → 409 `IDEMPOTENCY_IN_PROGRESS`; no UUID → 422 `IDEMPOTENCY_KEY_INVALID`.',
    }),
  );
}
