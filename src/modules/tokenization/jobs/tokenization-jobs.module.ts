import { Module } from '@nestjs/common';
import { AuditService } from '@shared/audit/audit.service';
import { PrismaModule } from '@shared/prisma/prisma.module';
import { ChainCoreModule } from '@modules/chain/chain-core.module';
import { MailModule } from '@modules/mail/mail.module';
import { ChainTokenizationAdapter } from '../ports/chain-tokenization.adapter';
import { TOKENIZATION_CHAIN_PORT } from '../ports/tokenization-chain.port';
import { CLOSURE_JOB_HANDLERS } from './closure.handlers';
import { TOKENIZATION_EVENT_HANDLERS } from './tokenization-events.handlers';

/**
 * Procesadores de la tokenización. Solo lo carga el worker
 * (src/worker/worker.module.ts · JOB_MODULES); la API no los instancia. El
 * puerto hacia la cadena es el mismo que usa la API (intenciones por el
 * outbox): aquí tampoco hay claves ni acceso a la red.
 */
@Module({
  imports: [PrismaModule, ChainCoreModule, MailModule],
  providers: [
    { provide: TOKENIZATION_CHAIN_PORT, useClass: ChainTokenizationAdapter },
    // La bitácora se escribe con `AuditService` directamente (actor sistema)
    AuditService,
    ...TOKENIZATION_EVENT_HANDLERS,
    // Cierre del lote con faltante (§8.4): `lot.bottled`, `lot.bottle_code_voided`, `lot.discarded`
    ...CLOSURE_JOB_HANDLERS,
  ],
})
export class TokenizationJobsModule {}
