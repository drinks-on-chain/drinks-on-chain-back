import { Module } from '@nestjs/common';
import { TOKENIZATION_EVENT_HANDLERS } from './tokenization-events.handlers';

/**
 * Procesadores de la tokenización. Solo lo carga el worker
 * (src/worker/worker.module.ts · JOB_MODULES); la API no los instancia.
 */
@Module({
  providers: [...TOKENIZATION_EVENT_HANDLERS],
})
export class TokenizationJobsModule {}
