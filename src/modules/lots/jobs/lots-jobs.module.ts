import { Module } from '@nestjs/common';
import { AuditService } from '@shared/audit/audit.service';
import { PrismaModule } from '@shared/prisma/prisma.module';
import { BottleCodeExportBuilder } from '../bottle-code-export.builder';
import { BottleCodesExportHandler } from './bottle-codes-export.handler';
import { BottleCodeExportsCleanupTask } from './bottle-code-exports-cleanup.task';
import { TraceLocksReleaseTask } from './locks-release.task';
import { LotCertifiedHandler } from './lot-certified.handler';

/**
 * Tareas y procesadores de la trazabilidad en el worker (contrato O2 §15).
 * Solo lo carga el worker (src/worker/worker.module.ts · JOB_MODULES); la API
 * no los instancia:
 *
 * - `trace.locks.release`: candados de crianza y reposo (tarea diaria).
 * - `trace.bottle-codes.export`: ZIP de códigos de botella para la imprenta,
 *   y la limpieza de los caducados.
 * - `lot.certified`: cierre del expediente (la Ola 3 lo ancla).
 *
 * La bitácora se escribe con `AuditService` directamente (actor sistema): el
 * módulo global de la API trae un interceptor HTTP que el worker no necesita.
 */
@Module({
  imports: [PrismaModule],
  providers: [
    AuditService,
    TraceLocksReleaseTask,
    BottleCodeExportBuilder,
    BottleCodesExportHandler,
    BottleCodeExportsCleanupTask,
    LotCertifiedHandler,
  ],
  exports: [TraceLocksReleaseTask],
})
export class LotsJobsModule {}
