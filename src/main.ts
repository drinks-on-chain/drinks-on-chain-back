import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { configureApp } from './app.setup';

import { NestExpressApplication } from '@nestjs/platform-express';
import * as path from 'path';
import * as fs from 'fs';
import { ConfigService } from '@nestjs/config';
import {
  buildCorsOptions,
  parseCorsAllowedOrigins,
} from './config/cors.config';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // 1. Seguridad HTTP con Helmet (permitiendo carga cross-origin de recursos como imágenes y PDFs)
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  // 1.1 Servir archivos estáticos locales (/uploads/...)
  const uploadDir = path.resolve(
    process.cwd(),
    process.env.STORAGE_LOCAL_PATH || './uploads',
  );
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
  app.useStaticAssets(uploadDir, {
    prefix: '/uploads/',
  });

  // 2. CORS: solo los orígenes exactos de CORS_ALLOWED_ORIGINS (nunca reflejo)
  const config = app.get(ConfigService);
  const allowedOrigins = parseCorsAllowedOrigins(
    config.get<string>('CORS_ALLOWED_ORIGINS'),
    config.get<string>('NODE_ENV'),
  );
  app.enableCors(buildCorsOptions(allowedOrigins));
  logger.log(`CORS habilitado para: ${allowedOrigins.join(', ')}`);

  // 3. Versionado /v1, validación (422 con details por campo), envoltorio de
  //    respuesta y filtro de errores: lo mismo que usan las e2e
  configureApp(app);

  // 4. Configuración de Swagger / OpenAPI en /docs
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Drinks on Chain API')
    .setDescription(
      'Backend API para Trazabilidad B2B y Tokenización NFT de Bebidas en Stellar Soroban',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .addTag('System', 'Endpoints de salud y configuración del sistema')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document, {
    customSiteTitle: 'Drinks on Chain API Docs',
    swaggerOptions: {
      persistAuthorization: true,
    },
  });

  app.enableShutdownHooks();

  const port = config.get<number>('PORT', 4000);
  await app.listen(port);

  logger.log(`🚀 Application is running on: http://localhost:${port}/v1`);
  logger.log(
    `📚 Swagger documentation available at: http://localhost:${port}/docs`,
  );
}

bootstrap();
