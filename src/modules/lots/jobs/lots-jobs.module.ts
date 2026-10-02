import { Module } from '@nestjs/common';
import { PrismaModule } from '@shared/prisma/prisma.module';
import { BottleCodeExportBuilder } from '../bottle-code-export.builder';
import { BottleCodesExportHandler } from './bottle-codes-export.handler';
import { BottleCodeExportsCleanupTask } from './bottle-code-exports-cleanup.task';

/**
 * Procesadores de los lotes en el worker (src/worker/worker.module.ts ·
 * JOB_MODULES): ZIP de códigos de botella para la imprenta y limpieza de los
 * caducados.
 */
@Module({
  imports: [PrismaModule],
  providers: [
    BottleCodeExportBuilder,
    BottleCodesExportHandler,
    BottleCodeExportsCleanupTask,
  ],
})
export class LotsJobsModule {}
