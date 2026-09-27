import { INestApplication, VersioningType } from '@nestjs/common';
import { GlobalExceptionFilter } from './shared/filters/global-exception.filter';
import { HttpLoggingInterceptor } from './shared/interceptors/logging.interceptor';
import { ResponseTransformInterceptor } from './shared/interceptors/response-transform.interceptor';
import { createAppValidationPipe } from './shared/pipes/app-validation.pipe';

/**
 * Configuración común de la aplicación HTTP: versionado `/v1`, validación
 * (422 con `details` por campo), envoltorio de respuesta y filtro de errores.
 * La usan `main.ts`, las pruebas e2e y la generación del OpenAPI, para que
 * los tres vean exactamente la misma API.
 */
export function configureApp(app: INestApplication): INestApplication {
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
