import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PrismaModule } from '@shared/prisma/prisma.module';
import { WalletsModule } from '@modules/wallets/wallets.module';
import { OrganizationsModule } from '@modules/organizations/organizations.module';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { SessionsModule } from './sessions/sessions.module';
import { AccessTokenService } from './sessions/access-token.service';
import { LoginAttemptsService } from './rate-limit/login-attempts.service';
import { AccessTokenGuard } from './guards/access-token.guard';
import { AuthorizationGuard } from './guards/authorization.guard';
import { TenantGuard } from './guards/tenant.guard';

/**
 * Autenticación y sesión (contrato O0 §5–§6). Los guards se registran como
 * globales en `AppModule` (acceso → autorización → bodega).
 */
@Module({
  imports: [
    PrismaModule,
    WalletsModule,
    SessionsModule,
    OrganizationsModule,
    // Secreto y caducidad se pasan en cada firma/verificación (AccessTokenService)
    JwtModule.register({}),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    AccessTokenService,
    LoginAttemptsService,
    AccessTokenGuard,
    AuthorizationGuard,
    TenantGuard,
  ],
  exports: [
    AuthService,
    AccessTokenService,
    SessionsModule,
    AccessTokenGuard,
    AuthorizationGuard,
    TenantGuard,
  ],
})
export class AuthModule {}
