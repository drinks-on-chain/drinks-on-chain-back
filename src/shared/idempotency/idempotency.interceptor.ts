import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { randomUUID } from 'crypto';
import { isUUID } from 'class-validator';
import type { Request, Response } from 'express';
import { Observable, catchError, from, mergeMap, of } from 'rxjs';
import { AppException } from '../exceptions/app.exception';
import { ErrorCode } from '../exceptions/error-codes';
import { ValidationException } from '../exceptions/validation.exception';
import { decimalsToNumbers } from '../utils/decimal-json.util';
import {
  IDEMPOTENCY_LOCK_TTL_SECONDS,
  IDEMPOTENCY_STORE,
  IDEMPOTENCY_TTL_SECONDS,
  type IdempotencyStore,
  buildIdempotencyStorageKey,
  fingerprintBody,
} from './idempotency.store';

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
/** Cabecera de las respuestas repetidas desde el almacén. */
export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';
export const IDEMPOTENT_METADATA = 'doc:idempotent';

export interface IdempotentOptions {
  /** La operación exige la cabecera (catálogo, desde la Ola 3). */
  required?: boolean;
}

/**
 * `Idempotency-Key` (contrato O0 §3):
 * - sin cabecera → la petición pasa tal cual (salvo `required`);
 * - misma clave y mismo cuerpo en 24 h → la respuesta guardada, sin volver a
 *   ejecutar el handler (cabecera `Idempotent-Replayed: true`);
 * - misma clave con otro cuerpo → 409 `IDEMPOTENCY_KEY_REUSED`;
 * - misma clave mientras la primera sigue en curso → 409
 *   `IDEMPOTENCY_IN_PROGRESS`.
 * Si el handler falla, la clave se libera para poder reintentar con ella.
 * Se aplica con `@Idempotent()`.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    @Inject(IDEMPOTENCY_STORE) private readonly store: IdempotencyStore,
    private readonly reflector: Reflector,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const options =
      this.reflector.get<IdempotentOptions | undefined>(
        IDEMPOTENT_METADATA,
        context.getHandler(),
      ) ?? {};
    const http = context.switchToHttp();
    const request = http.getRequest<Request & { user?: { id?: string } }>();
    const response = http.getResponse<Response>();

    const rawKey = request.header(IDEMPOTENCY_KEY_HEADER)?.trim();
    if (!rawKey) {
      if (options.required) {
        throw new ValidationException(
          [
            {
              field: IDEMPOTENCY_KEY_HEADER,
              message: `${IDEMPOTENCY_KEY_HEADER} header is required for this operation`,
            },
          ],
          `${IDEMPOTENCY_KEY_HEADER} header is required`,
          ErrorCode.IDEMPOTENCY_KEY_REQUIRED,
        );
      }
      return next.handle();
    }
    if (!isUUID(rawKey)) {
      throw new ValidationException(
        [
          {
            field: IDEMPOTENCY_KEY_HEADER,
            message: `${IDEMPOTENCY_KEY_HEADER} must be a UUID`,
          },
        ],
        `Invalid ${IDEMPOTENCY_KEY_HEADER}`,
        ErrorCode.IDEMPOTENCY_KEY_INVALID,
      );
    }

    const storageKey = buildIdempotencyStorageKey({
      userId: request.user?.id,
      method: request.method,
      path: (request.originalUrl ?? request.url).split('?')[0],
      key: rawKey,
    });
    const fingerprint = fingerprintBody(request.body);
    const lockToken = randomUUID();

    let acquired: Awaited<ReturnType<IdempotencyStore['acquire']>>;
    try {
      acquired = await this.store.acquire(
        storageKey,
        fingerprint,
        lockToken,
        IDEMPOTENCY_LOCK_TTL_SECONDS,
      );
    } catch (error) {
      this.logger.error(
        `Almacén de idempotencia no disponible: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new AppException(
        503,
        ErrorCode.IDEMPOTENCY_STORE_UNAVAILABLE,
        'Idempotency store is temporarily unavailable. Please try again.',
      );
    }

    if (!acquired.acquired) {
      const { record } = acquired;
      if (record.fingerprint !== fingerprint) {
        throw new AppException(
          409,
          ErrorCode.IDEMPOTENCY_KEY_REUSED,
          `${IDEMPOTENCY_KEY_HEADER} was already used with a different request body`,
        );
      }
      if (record.state === 'in_progress') {
        throw new AppException(
          409,
          ErrorCode.IDEMPOTENCY_IN_PROGRESS,
          `A request with this ${IDEMPOTENCY_KEY_HEADER} is still being processed`,
        );
      }
      response.status(record.statusCode);
      response.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
      return of(record.body);
    }

    return next.handle().pipe(
      mergeMap((data: unknown) =>
        from(this.saveResponse(storageKey, fingerprint, response, data)),
      ),
      catchError((error: unknown) =>
        from(
          this.store.release(storageKey, lockToken).catch((releaseError) => {
            this.logger.warn(
              `No se pudo liberar la clave de idempotencia: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
            );
          }),
        ).pipe(
          mergeMap(() => {
            throw error;
          }),
        ),
      ),
    );
  }

  private async saveResponse(
    storageKey: string,
    fingerprint: string,
    response: Response,
    data: unknown,
  ): Promise<unknown> {
    // Se guarda lo mismo que se serializa (fechas como texto ISO, decimales
    // como número, igual que ResponseTransformInterceptor)
    const body: unknown =
      data === undefined
        ? null
        : JSON.parse(JSON.stringify(decimalsToNumbers(data)));
    try {
      await this.store.complete(
        storageKey,
        {
          state: 'completed',
          fingerprint,
          statusCode: response.statusCode,
          body,
          completedAt: new Date().toISOString(),
        },
        IDEMPOTENCY_TTL_SECONDS,
      );
    } catch (error) {
      // La operación ya se hizo: se responde igual y la reserva caduca sola.
      this.logger.error(
        `No se pudo guardar la respuesta idempotente: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return data;
  }
}
