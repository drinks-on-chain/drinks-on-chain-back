import { Module } from '@nestjs/common';
import { PrismaModule } from '@shared/prisma/prisma.module';
import { BottleCodeExportBuilder } from '../bottle-code-export.builder';
import { BottleCodesExportHandler } from './bottle-codes-export.handler';
import { BottleCodeExportsCleanupTask } from './bottle-code-exports-cleanup.task';
import { LotCertifiedHandler } from './lot-certified.handler';

/**
 * Procesadores de los lotes en el worker (src/worker/worker.module.ts ·
 * JOB_MODULES): ZIP de códigos de botella para la imprenta, limpieza de los
 * caducados y `lot.certified`.
 */
@Module({
  imports: [PrismaModule],
  providers: [
    BottleCodeExportBuilder,
    BottleCodesExportHandler,
    BottleCodeExportsCleanupTask,
    LotCertifiedHandler,
  ],
})
export class LotsJobsModule {}
