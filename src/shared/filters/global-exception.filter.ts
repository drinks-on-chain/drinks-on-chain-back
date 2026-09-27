import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AppException } from '../exceptions/app.exception';
import { ApiErrorResponse } from '../interfaces/api-response.interface';
import { CorrelationIdMiddleware } from '../middleware/correlation-id.middleware';
import { sanitizeLogData } from '../utils/log-sanitizer.util';

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

    response.status(errorResponse.statusCode).json(errorResponse);
  }

  private buildErrorResponse(
    exception: unknown,
    path: string,
  ): ApiErrorResponse {
    const timestamp = new Date().toISOString();

    // 1. Excepción de dominio de la aplicación
    if (exception instanceof AppException) {
      return {
        success: false,
        statusCode: exception.statusCode,
        timestamp,
        path,
        error: {
          code: exception.errorCode,
          message: exception.message,
          details: exception.details ?? null,
        },
      };
    }

    // 2. Excepción nativa de NestJS (ValidationPipe, NotFoundException, etc.)
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
        const respObj = exceptionResponse as Record<string, unknown>;

        // Errores de validación de ValidationPipe
        if (
          status === HttpStatus.BAD_REQUEST &&
          Array.isArray(respObj.message)
        ) {
          return {
            success: false,
            statusCode: status,
            timestamp,
            path,
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Validation failed',
              details: respObj.message,
            },
          };
        }

        return {
          success: false,
          statusCode: status,
          timestamp,
          path,
          error: {
            code: (respObj.code as string) || this.mapHttpStatusToCode(status),
            message:
              (respObj.message as string) ||
              exception.message ||
              'HTTP Exception',
            details: respObj.details ?? null,
          },
        };
      }

      return {
        success: false,
        statusCode: status,
        timestamp,
        path,
        error: {
          code: this.mapHttpStatusToCode(status),
          message: exception.message,
          details: null,
        },
      };
    }

    // 3. Error no controlado (500 Internal Server Error)
    return {
      success: false,
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      timestamp,
      path,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected internal server error occurred',
        details: null,
      },
    };
  }

  private mapHttpStatusToCode(status: number): string {
    const map: Record<number, string> = {
      400: 'BAD_REQUEST',
      401: 'UNAUTHORIZED',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      409: 'CONFLICT',
      422: 'UNPROCESSABLE_ENTITY',
      500: 'INTERNAL_ERROR',
      502: 'BAD_GATEWAY',
      503: 'SERVICE_UNAVAILABLE',
    };
    return map[status] ?? 'UNKNOWN_ERROR';
  }
}
