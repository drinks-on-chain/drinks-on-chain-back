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
import { LotsModule } from './modules/lots/lots.module';
import { LotsContractModule } from './modules/lots/contract/lots-contract.module';
import { StorageModule } from './shared/storage/storage.module';
import { UploadsModule } from './modules/uploads/uploads.module';
import { IdempotencyModule } from './shared/idempotency/idempotency.module';
import { RequestContextModule } from './shared/context/request-context.module';
import { AuditModule } from './shared/audit/audit.module';
import { RedisModule } from './shared/redis/redis.module';
import { SettingsModule } from './modules/settings/settings.module';
import { MailModule } from './modules/mail/mail.module';
import { AuditQueryModule } from './modules/audit/audit-query.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { CaptchaModule } from './shared/captcha/captcha.module';
import { InvitationsModule } from './modules/invitations/invitations.module';
import { PlatformUsersModule } from './modules/platform-users/platform-users.module';
import { WineryManagementModule } from './modules/winery-management/winery-management.module';
import { WineryApplicationsModule } from './modules/winery-applications/winery-applications.module';
import { TeamModule } from './modules/team/team.module';
import { WaitlistModule } from './modules/waitlist/waitlist.module';
import { ChainModule } from './modules/chain/chain.module';
import { TokenizationModule } from './modules/tokenization/tokenization.module';

@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    RequestContextModule,
    RedisModule,
    AuditModule,
    CaptchaModule,
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
    LotsModule,
    LotsContractModule,
    UploadsModule,
    SettingsModule,
    MailModule,
    AuditQueryModule,
    DashboardModule,
    InvitationsModule,
    PlatformUsersModule,
    WineryManagementModule,
    WineryApplicationsModule,
    TeamModule,
    WaitlistModule,
    ChainModule,
    TokenizationModule,
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
