import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Request, Response } from 'express';

/**
 * Una entrada por petición con método, ruta, estado, duración e IP
 * (docs/rules/05 §6). El `correlationId`, la sesión y la organización los
 * añade el logger JSON desde el contexto de la petición.
 */
@Injectable()
export class HttpLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const method = request.method;
    const path = request.originalUrl || request.url;
    const ip = request.ip || request.socket?.remoteAddress || 'unknown';
    const startTime = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          const statusCode = context
            .switchToHttp()
            .getResponse<Response>().statusCode;
          this.logger.log({
            message: `${method} ${path} ${statusCode}`,
            method,
            path,
            statusCode,
            durationMs: Date.now() - startTime,
            ip,
          });
        },
        error: (err: {
          status?: number;
          statusCode?: number;
          message?: string;
        }) => {
          const statusCode = err?.status || err?.statusCode || 500;
          this.logger.warn({
            message: `${method} ${path} ${statusCode}`,
            method,
            path,
            statusCode,
            durationMs: Date.now() - startTime,
            ip,
            error: err?.message || 'Unknown',
          });
        },
      }),
    );
  }
}
