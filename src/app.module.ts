import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AppConfigModule } from './config/config.module';
import { PrismaModule } from './shared/prisma/prisma.module';
import { HealthModule } from './modules/health/health.module';
import { CorrelationIdMiddleware } from './shared/middleware/correlation-id.middleware';

import { ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './modules/auth/auth.module';
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
    ThrottlerModule.forRoot([
      {
        ttl: 60000,
        limit: 100,
      },
    ]),
    WalletsModule,
    AuthModule,
    UsersModule,
    WineriesModule,
    TerroirsModule,
    HarvestBatchesModule,
    TraceabilityModule,
    UploadsModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
