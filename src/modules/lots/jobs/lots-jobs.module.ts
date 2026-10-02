import { Module } from '@nestjs/common';
import { AuditService } from '@shared/audit/audit.service';
import { PrismaModule } from '@shared/prisma/prisma.module';
import { TraceLocksReleaseTask } from './locks-release.task';

/**
 * Tareas de la trazabilidad en el worker (contrato O2 §15). Solo lo carga el
 * worker (src/worker/worker.module.ts · JOB_MODULES); la API no las instancia.
 * La bitácora se escribe con `AuditService` directamente (actor sistema): el
 * módulo global de la API trae un interceptor HTTP que el worker no necesita.
 */
@Module({
  imports: [PrismaModule],
  providers: [AuditService, TraceLocksReleaseTask],
  exports: [TraceLocksReleaseTask],
})
export class LotsJobsModule {}
