import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Request, Response } from 'express';
import { ApiSuccessResponse } from '../interfaces/api-response.interface';
import { decimalsToNumbers } from '../utils/decimal-json.util';

/**
 * Envoltorio `{ success, statusCode, timestamp, path, data }` de toda respuesta
 * correcta. `data` sale con los `Decimal` de Prisma como números JSON (el
 * OpenAPI los declara `number`; `toJSON()` los daría como texto).
 */
@Injectable()
export class ResponseTransformInterceptor<T> implements NestInterceptor<
  T,
  ApiSuccessResponse<T>
> {
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<ApiSuccessResponse<T>> {
    const ctx = context.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();

    return next.handle().pipe(
      map((data: T) => ({
        success: true as const,
        statusCode: response?.statusCode ?? 200,
        timestamp: new Date().toISOString(),
        path: request?.url ?? '',
        data: decimalsToNumbers(data),
      })),
    );
  }
}
