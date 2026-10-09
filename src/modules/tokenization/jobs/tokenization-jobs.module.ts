import { Module } from '@nestjs/common';
import { PrismaModule } from '@shared/prisma/prisma.module';
import { ChainCoreModule } from '@modules/chain/chain-core.module';
import { ChainTokenizationAdapter } from '../ports/chain-tokenization.adapter';
import { TOKENIZATION_CHAIN_PORT } from '../ports/tokenization-chain.port';
import { TOKENIZATION_EVENT_HANDLERS } from './tokenization-events.handlers';

/**
 * Procesadores de la tokenización. Solo lo carga el worker
 * (src/worker/worker.module.ts · JOB_MODULES); la API no los instancia. El
 * puerto hacia la cadena es el mismo que usa la API (intenciones por el
 * outbox): aquí tampoco hay claves ni acceso a la red.
 */
@Module({
  imports: [PrismaModule, ChainCoreModule],
  providers: [
    { provide: TOKENIZATION_CHAIN_PORT, useClass: ChainTokenizationAdapter },
    ...TOKENIZATION_EVENT_HANDLERS,
  ],
})
export class TokenizationJobsModule {}
