import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Request } from 'express';
import { CorrelationIdMiddleware } from '../middleware/correlation-id.middleware';

@Injectable()
export class HttpLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const method = request.method;
    const url = request.originalUrl || request.url;
    const ip = request.ip || request.socket.remoteAddress || 'unknown';
    const correlationId = CorrelationIdMiddleware.getCorrelationId() || 'N/A';
    const startTime = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          const responseTime = Date.now() - startTime;
          const statusCode = context.switchToHttp().getResponse().statusCode;
          this.logger.log(
            `[${correlationId}] ${method} ${url} ${statusCode} - ${responseTime}ms [IP: ${ip}]`,
          );
        },
        error: (err) => {
          const responseTime = Date.now() - startTime;
          const status = err?.status || err?.statusCode || 500;
          this.logger.warn(
            `[${correlationId}] ${method} ${url} ${status} - ${responseTime}ms [IP: ${ip}] [Error: ${err?.message || 'Unknown'}]`,
          );
        },
      }),
    );
  }
}
