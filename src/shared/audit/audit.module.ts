import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from '@shared/prisma/prisma.module';
import { AuditService } from './audit.service';
import { AuthAuditInterceptor } from './auth-audit.interceptor';

/**
 * Bitácora (docs/arquitectura/bitacora.md). Global: cualquier servicio puede
 * inyectar `AuditService` sin importar el módulo.
 */
@Global()
@Module({
  imports: [PrismaModule],
  providers: [
    AuditService,
    { provide: APP_INTERCEPTOR, useClass: AuthAuditInterceptor },
  ],
  exports: [AuditService],
})
export class AuditModule {}
