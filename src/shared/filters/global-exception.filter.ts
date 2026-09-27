import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AppException, RetryAfterException } from '../exceptions/app.exception';
import { ErrorCode, errorCodeForStatus } from '../exceptions/error-codes';
import {
  ApiErrorResponse,
  ErrorDetail,
} from '../interfaces/api-response.interface';
import { CorrelationIdMiddleware } from '../middleware/correlation-id.middleware';
import { sanitizeLogData } from '../utils/log-sanitizer.util';

/** Segundos que se anuncian en `Retry-After` si el 429 no trae la cabecera. */
export const DEFAULT_RETRY_AFTER_SECONDS = 60;

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const correlationId = CorrelationIdMiddleware.getCorrelationId() || 'N/A';

    const errorResponse = this.buildErrorResponse(
      exception,
      request?.url ?? '',
    );

    // Logging del error sanitizado
    if (errorResponse.statusCode >= 500) {
      this.logger.error(
        `[${correlationId}] [${errorResponse.statusCode}] ${request?.method} ${request?.url} — ${errorResponse.error.code}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(
        `[${correlationId}] [${errorResponse.statusCode}] ${request?.method} ${request?.url} — ${errorResponse.error.code}: ${errorResponse.error.message}`,
        sanitizeLogData(errorResponse.error.details),
      );
    }

    // 429 siempre con Retry-After (contrato O0 §1). El ThrottlerGuard y el
    // bloqueo por intentos la ponen con el tiempo real; esto cubre el resto.
    if (
      exception instanceof RetryAfterException &&
      typeof response.setHeader === 'function'
    ) {
      response.setHeader(
        'Retry-After',
        String(Math.max(1, Math.ceil(exception.retryAfterSeconds))),
      );
    }
    if (
      errorResponse.statusCode === HttpStatus.TOO_MANY_REQUESTS &&
      typeof response.getHeader === 'function' &&
      !response.getHeader('Retry-After')
    ) {
      response.setHeader('Retry-After', String(DEFAULT_RETRY_AFTER_SECONDS));
    }

    response.status(errorResponse.statusCode).json(errorResponse);
  }

  private buildErrorResponse(
    exception: unknown,
    path: string,
  ): ApiErrorResponse {
    const timestamp = new Date().toISOString();
    const build = (
      statusCode: number,
      code: string,
      message: string,
      details: ErrorDetail[] | null,
    ): ApiErrorResponse => ({
      success: false,
      statusCode,
      timestamp,
      path,
      error: { code, message, details },
    });

    // 1. Excepción de la aplicación (dominio, validación)
    if (exception instanceof AppException) {
      return build(
        exception.statusCode,
        exception.errorCode,
        exception.message,
        normalizeErrorDetails(exception.details),
      );
    }

    // 2. Excepción nativa de NestJS (NotFoundException, ThrottlerException…)
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
        const respObj = exceptionResponse as Record<string, unknown>;

        // Lista de mensajes sueltos (p. ej. un ValidationPipe local sin la
        // fábrica común): es un error de validación sin campo identificable.
        if (Array.isArray(respObj.message)) {
          return build(
            HttpStatus.UNPROCESSABLE_ENTITY,
            ErrorCode.VALIDATION_ERROR,
            'Validation failed',
            normalizeErrorDetails(respObj.message),
          );
        }

        return build(
          status,
          typeof respObj.code === 'string'
            ? respObj.code
            : errorCodeForStatus(status),
          typeof respObj.message === 'string'
            ? respObj.message
            : exception.message || 'HTTP Exception',
          normalizeErrorDetails(respObj.details),
        );
      }

      return build(status, errorCodeForStatus(status), exception.message, null);
    }

    // 3. Error no controlado (500 Internal Server Error)
    return build(
      HttpStatus.INTERNAL_SERVER_ERROR,
      ErrorCode.INTERNAL_ERROR,
      'An unexpected internal server error occurred',
      null,
    );
  }
}

/**
 * Normaliza `details` a `[{ field, message }]` o `null` (contrato O0 §1):
 * - una lista de `{ field, message }` se conserva;
 * - una cadena suelta pasa a `{ field: null, message }`;
 * - cualquier otra forma (objetos con datos internos, p. ej. de la red) se
 *   descarta: queda en los logs, nunca en la respuesta.
 */
export function normalizeErrorDetails(details: unknown): ErrorDetail[] | null {
  if (!Array.isArray(details)) {
    return null;
  }
  const normalized: ErrorDetail[] = [];
  for (const item of details) {
    if (typeof item === 'string') {
      normalized.push({ field: null, message: item });
    } else if (
      typeof item === 'object' &&
      item !== null &&
      typeof (item as { message?: unknown }).message === 'string'
    ) {
      const { field, message } = item as { field?: unknown; message: string };
      normalized.push({
        field: typeof field === 'string' && field.length > 0 ? field : null,
        message,
      });
    }
  }
  return normalized.length > 0 ? normalized : null;
}
