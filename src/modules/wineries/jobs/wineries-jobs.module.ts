import { Module } from '@nestjs/common';
import { ChainJobsModule } from '@modules/chain/jobs/chain-jobs.module';
import { WineryActivatedHandler } from './winery-activated.handler';

/**
 * Procesadores del módulo de bodegas. Solo lo carga el worker
 * (src/worker/worker.module.ts · JOB_MODULES); la API no los instancia.
 */
@Module({
  imports: [ChainJobsModule],
  providers: [WineryActivatedHandler],
})
export class WineriesJobsModule {}
