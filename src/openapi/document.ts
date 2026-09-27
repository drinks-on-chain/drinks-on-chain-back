import { NestFactory } from '@nestjs/core';
import type { OpenAPIObject } from '@nestjs/swagger';
import { configureApp } from '../app.setup';
import { createOpenApiDocument } from './openapi';

/**
 * Variables mínimas para que la configuración valide al importar los módulos.
 * El documento no depende de ellas: la app se crea en modo `preview` (Nest
 * resuelve el grafo de módulos sin instanciar proveedores), así que nunca se
 * abre la base de datos ni Redis. No son secretos.
 */
const DOCUMENT_ENV_DEFAULTS: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://openapi:openapi@localhost:5432/openapi',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'openapi-document-only-placeholder-value',
  JWT_REFRESH_SECRET: 'openapi-document-only-placeholder-value-2',
};

/** Genera el documento OpenAPI sin base de datos ni Redis. */
export async function generateOpenApiDocument(): Promise<OpenAPIObject> {
  for (const [key, value] of Object.entries(DOCUMENT_ENV_DEFAULTS)) {
    process.env[key] ??= value;
  }
  // Import tardío: ConfigModule valida el entorno al cargar AppModule
  const { AppModule } = await import('../app.module');
  const app = await NestFactory.create(AppModule, {
    preview: true,
    logger: false,
    abortOnError: false,
  });
  configureApp(app);
  return createOpenApiDocument(app);
}
