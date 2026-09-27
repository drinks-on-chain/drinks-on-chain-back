import { INestApplication, VersioningType } from '@nestjs/common';
import { GlobalExceptionFilter } from './shared/filters/global-exception.filter';
import { HttpLoggingInterceptor } from './shared/interceptors/logging.interceptor';
import { ResponseTransformInterceptor } from './shared/interceptors/response-transform.interceptor';
import { createAppValidationPipe } from './shared/pipes/app-validation.pipe';
import { parseTrustProxy } from './config/trust-proxy.config';
import {
  createProxyClientIpMiddleware,
  parseProxySecrets,
} from './shared/middleware/proxy-client-ip';

/**
 * Configuración común de la aplicación HTTP: `trust proxy`, IP firmada por el
 * proxy de las apps, versionado `/v1`, validación
 * (422 con `details` por campo), envoltorio de respuesta y filtro de errores.
 * La usan `main.ts`, las pruebas e2e y la generación del OpenAPI, para que
 * los tres vean exactamente la misma API.
 */
export function configureApp(app: INestApplication): INestApplication {
  // IP real detrás de nginx (una capa): TRUST_PROXY=1 (SE-06)
  const httpAdapter = app.getHttpAdapter?.();
  const instance: unknown = httpAdapter?.getInstance?.();
  if (instance && typeof (instance as { set?: unknown }).set === 'function') {
    (instance as { set: (key: string, value: unknown) => void }).set(
      'trust proxy',
      parseTrustProxy(process.env.TRUST_PROXY),
    );
  }
  // IP del cliente firmada por el proxy de las apps (O1-OPS-1). Se registra
  // aquí, antes que los middleware de los módulos, para que la correlación,
  // la bitácora, las sesiones y los límites vean ya la IP resuelta.
  const proxySecrets = parseProxySecrets(process.env.PROXY_SHARED_SECRET);
  if (proxySecrets.length > 0) {
    app.use(createProxyClientIpMiddleware(proxySecrets));
  }
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });
  app.useGlobalPipes(createAppValidationPipe());
  app.useGlobalInterceptors(
    new ResponseTransformInterceptor(),
    new HttpLoggingInterceptor(),
  );
  app.useGlobalFilters(new GlobalExceptionFilter());
  return app;
}
