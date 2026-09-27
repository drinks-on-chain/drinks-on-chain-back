import { Module } from '@nestjs/common';
import { PrismaModule } from '@shared/prisma/prisma.module';
import { AuditQueryService } from './audit-query.service';
import { PlatformAuditController } from './platform-audit.controller';
import { OrganizationAuditController } from './organization-audit.controller';

/**
 * Consulta de la bitácora (docs/arquitectura/bitacora.md): back office y
 * dueño de bodega. La escritura es de `AuditModule` (src/shared/audit, global).
 */
@Module({
  imports: [PrismaModule],
  controllers: [PlatformAuditController, OrganizationAuditController],
  providers: [AuditQueryService],
  exports: [AuditQueryService],
})
export class AuditQueryModule {}
