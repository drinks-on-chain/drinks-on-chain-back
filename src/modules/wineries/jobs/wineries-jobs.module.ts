import { Module } from '@nestjs/common';
import { WineryActivatedHandler } from './winery-activated.handler';

/**
 * Procesadores del módulo de bodegas. Solo lo carga el worker
 * (src/worker/worker.module.ts · JOB_MODULES); la API no los instancia.
 */
@Module({
  providers: [WineryActivatedHandler],
})
export class WineriesJobsModule {}
