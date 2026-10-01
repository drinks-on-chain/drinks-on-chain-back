import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
  SetMetadata,
  UseInterceptors,
  applyDecorators,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiExtension } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';
import { getRequestContext } from '@shared/context/request-context';

export const DEPRECATED_ROUTE_KEY = 'api:deprecatedRoute';

/**
 * Ruta que se retira al cerrar la Ola 1 (H1, contrato O1 §11). Sigue
 * funcionando mientras los frontends migran, pero cada uso deja un aviso en
 * los logs (quién, desde qué app) y la respuesta lleva `Deprecation: true` y
 * `Link: <sustituta>; rel="successor-version"`. En el OpenAPI, además de
 * `deprecated: true` en `@ApiOperation`, `x-replaced-by`.
 */
@Injectable()
export class DeprecatedRouteInterceptor implements NestInterceptor {
  private readonly logger = new Logger('DeprecatedRoute');

  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const replacement = this.reflector.getAllAndOverride<string | undefined>(
      DEPRECATED_ROUTE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (replacement && context.getType() === 'http') {
      const http = context.switchToHttp();
      const request = http.getRequest<Request & { user?: { id?: string } }>();
      const response = http.getResponse<Response>();
      const ctx = getRequestContext();
      this.logger.warn(
        `Ruta obsoleta (se retira en H1): ${request.method} ${request.originalUrl ?? request.url} · persona ${request.user?.id ?? 'sin sesión'} · app ${ctx?.clientApp ?? 'sin X-Client-App'} · usar ${replacement}`,
      );
      response.setHeader('Deprecation', 'true');
      response.setHeader('Link', `<${replacement}>; rel="successor-version"`);
    }
    return next.handle();
  }
}

/** Marca una ruta como obsoleta (H1) e indica la que la sustituye. */
export function DeprecatedRoute(replacement: string) {
  return applyDecorators(
    SetMetadata(DEPRECATED_ROUTE_KEY, replacement),
    UseInterceptors(DeprecatedRouteInterceptor),
    ApiExtension('x-replaced-by', replacement),
  );
}
