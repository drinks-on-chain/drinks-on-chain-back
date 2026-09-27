import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { RequestContextInterceptor } from './request-context.interceptor';

/**
 * Registra `RequestContextInterceptor` para toda la API (también en las e2e
 * que montan `AppModule` sin `configureApp`). El contexto lo crea
 * `CorrelationIdMiddleware` (registrado en `AppModule`).
 */
@Global()
@Module({
  providers: [
    { provide: APP_INTERCEPTOR, useClass: RequestContextInterceptor },
  ],
})
export class RequestContextModule {}
