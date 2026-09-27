import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  SetMetadata,
  UseInterceptors,
  applyDecorators,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ApiExtension,
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Length } from 'class-validator';
import type { Observable } from 'rxjs';
import { ValidationException } from '@shared/exceptions/validation.exception';

/**
 * Motivo obligatorio en las acciones del back office sobre terceros (AUD-05,
 * contrato O1 §0): texto de 3 a 500 caracteres que queda en la bitácora.
 *
 * Uso en un controlador:
 *
 * ```ts
 * @Post(':id/suspend')
 * @RequiresReason()                       // siempre
 * suspend(@Body() dto: SuspendWineryDto) { … }  // dto.reason: @ReasonProperty()
 *
 * @Post(':id/resend')
 * @RequiresReason({ when: 'platform' })   // solo si actúa la plataforma
 * resend(@Body() dto: ResendDto) { … }          // dto.reason: @OptionalReasonProperty()
 * ```
 *
 * Sin motivo válido → 422 `VALIDATION_ERROR` con `details[{ field: 'reason' }]`,
 * antes de validar el resto del cuerpo. El motivo llega recortado al DTO.
 */

export const REASON_MIN_LENGTH = 3;
export const REASON_MAX_LENGTH = 500;

export const REQUIRES_REASON_KEY = 'audit:requiresReason';

export interface RequiresReasonOptions {
  /**
   * `always` (por defecto): lo exige a cualquiera. `platform`: solo cuando la
   * organización activa es la de plataforma (rutas que comparten el dueño de
   * una bodega y el back office, donde el dueño puede omitirlo).
   */
  when?: 'always' | 'platform';
}

const REASON_MESSAGE = `El motivo es obligatorio (entre ${REASON_MIN_LENGTH} y ${REASON_MAX_LENGTH} caracteres)`;

/** El motivo recortado si es válido; `null` si falta o no cumple. */
export function normalizeReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length >= REASON_MIN_LENGTH &&
    trimmed.length <= REASON_MAX_LENGTH
    ? trimmed
    : null;
}

/** El motivo recortado o 422 con `details[{ field }]`. */
export function assertReason(raw: unknown, field = 'reason'): string {
  const reason = normalizeReason(raw);
  if (reason === null) {
    throw ValidationException.forField(field, REASON_MESSAGE);
  }
  return reason;
}

/** Aplica `@RequiresReason()`: se registra solo en las rutas que lo llevan. */
@Injectable()
export class RequireReasonInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const options = this.reflector.getAllAndOverride<
      Required<RequiresReasonOptions> | undefined
    >(REQUIRES_REASON_KEY, [context.getHandler(), context.getClass()]);
    if (options && context.getType() === 'http') {
      const request = context.switchToHttp().getRequest<{
        body?: unknown;
        user?: { organizationType?: string | null };
      }>();
      const applies =
        options.when === 'always' ||
        request.user?.organizationType === 'PLATFORM';
      if (applies) {
        const body = request.body;
        const reason = assertReason(
          body && typeof body === 'object'
            ? (body as Record<string, unknown>).reason
            : undefined,
        );
        (body as Record<string, unknown>).reason = reason;
      }
    }
    return next.handle();
  }
}

/**
 * Exige `reason` en el cuerpo (AUD-05). Declara `x-requires-reason` en el
 * OpenAPI (`always` o `platform`) para que los clientes lo sepan.
 */
export function RequiresReason(options: RequiresReasonOptions = {}) {
  const when = options.when ?? 'always';
  return applyDecorators(
    SetMetadata(REQUIRES_REASON_KEY, { when }),
    UseInterceptors(RequireReasonInterceptor),
    ApiExtension('x-requires-reason', when),
  );
}

const trimString = Transform(({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value,
);

/** Campo `reason` obligatorio de un DTO (3–500 caracteres, recortado). */
export function ReasonProperty(description = 'Motivo (queda en la bitácora)') {
  return applyDecorators(
    ApiProperty({
      description,
      minLength: REASON_MIN_LENGTH,
      maxLength: REASON_MAX_LENGTH,
      example: 'Corrección solicitada por la bodega',
    }),
    trimString,
    IsString({ message: 'reason debe ser un texto' }),
    Length(REASON_MIN_LENGTH, REASON_MAX_LENGTH, { message: REASON_MESSAGE }),
  );
}

/** Campo `reason` opcional (mismas reglas si llega); con `@RequiresReason({ when: 'platform' })`. */
export function OptionalReasonProperty(
  description = 'Motivo (obligatorio si actúa el back office sobre un tercero)',
) {
  return applyDecorators(
    ApiPropertyOptional({
      description,
      minLength: REASON_MIN_LENGTH,
      maxLength: REASON_MAX_LENGTH,
      nullable: true,
    }),
    trimString,
    IsOptional(),
    IsString({ message: 'reason debe ser un texto' }),
    Length(REASON_MIN_LENGTH, REASON_MAX_LENGTH, { message: REASON_MESSAGE }),
  );
}
