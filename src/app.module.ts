import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AppConfigModule } from './config/config.module';
import { PrismaModule } from './shared/prisma/prisma.module';
import { HealthModule } from './modules/health/health.module';
import { CorrelationIdMiddleware } from './shared/middleware/correlation-id.middleware';

import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './modules/auth/auth.module';
import { AccessTokenGuard } from './modules/auth/guards/access-token.guard';
import { AuthorizationGuard } from './modules/auth/guards/authorization.guard';
import { TenantGuard } from './modules/auth/guards/tenant.guard';
import {
  AppThrottlerGuard,
  throttlerOptionsFromConfig,
} from './modules/auth/rate-limit/app-throttler.guard';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { WalletsModule } from './modules/wallets/wallets.module';
import { UsersModule } from './modules/users/users.module';
import { WineriesModule } from './modules/wineries/wineries.module';
import { TerroirsModule } from './modules/terroirs/terroirs.module';
import { HarvestBatchesModule } from './modules/harvest-batches/harvest-batches.module';
import { TraceabilityModule } from './modules/traceability/traceability.module';
import { StorageModule } from './shared/storage/storage.module';
import { UploadsModule } from './modules/uploads/uploads.module';
import { IdempotencyModule } from './shared/idempotency/idempotency.module';

@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    StorageModule,
    IdempotencyModule,
    HealthModule,
    // Límite global por IP real y específico de /auth/* (SE-06, IAM-07)
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: throttlerOptionsFromConfig,
    }),
    WalletsModule,
    OrganizationsModule,
    AuthModule,
    UsersModule,
    WineriesModule,
    TerroirsModule,
    HarvestBatchesModule,
    TraceabilityModule,
    UploadsModule,
  ],
  // Guards globales, en este orden (contrato O0 §6): límite de peticiones →
  // acceso válido y sesión viva → audiencia, tipo de organización y rol →
  // bodega de la petición. Las rutas @Public() solo pasan por el primero.
  providers: [
    { provide: APP_GUARD, useClass: AppThrottlerGuard },
    { provide: APP_GUARD, useExisting: AccessTokenGuard },
    { provide: APP_GUARD, useExisting: AuthorizationGuard },
    { provide: APP_GUARD, useExisting: TenantGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
