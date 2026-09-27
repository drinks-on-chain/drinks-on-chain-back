import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, VersioningType, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { ResponseTransformInterceptor } from './shared/interceptors/response-transform.interceptor';
import { HttpLoggingInterceptor } from './shared/interceptors/logging.interceptor';
import { GlobalExceptionFilter } from './shared/filters/global-exception.filter';

import { NestExpressApplication } from '@nestjs/platform-express';
import * as path from 'path';
import * as fs from 'fs';

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

  // 2. CORS restrictivo por entorno
  const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS?.split(',') || [
    'http://localhost:3000',
  ];
  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Correlation-ID',
      'Accept-Language',
    ],
  });

  // 3. Versionado global de API (/v1/...)
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });

  // 4. Pipes globales de validación DTO
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // 5. Interceptores globales (Respuesta estándar + Logging de auditoría)
  app.useGlobalInterceptors(
    new ResponseTransformInterceptor(),
    new HttpLoggingInterceptor(),
  );

  // 6. Filtros globales de excepción
  app.useGlobalFilters(new GlobalExceptionFilter());

  // 7. Configuración de Swagger / OpenAPI en /docs
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

  const port = process.env.PORT || 3000;
  await app.listen(port);

  logger.log(`🚀 Application is running on: http://localhost:${port}/v1`);
  logger.log(
    `📚 Swagger documentation available at: http://localhost:${port}/docs`,
  );
}

bootstrap();
