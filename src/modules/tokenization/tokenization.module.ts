import { Module } from '@nestjs/common';
import { OutboxModule } from '@shared/outbox/outbox.module';
import { ChainModule } from '@modules/chain/chain.module';
import { PassportLookupLimiter } from '@modules/lots/passport/passport-lookup-limiter';
import { MailModule } from '@modules/mail/mail.module';
import { CollectionImagesService } from './collection-images.service';
import { CollectionsService } from './collections.service';
import { ErpTokenizationController } from './erp-tokenization.controller';
import {
  PlatformCollectionsController,
  PlatformLotClosuresController,
} from './platform-collections.controller';
import { PlatformTokenizationController } from './platform-tokenization.controller';
import { DatabaseTokenizationChainAdapter } from './ports/database-tokenization-chain.adapter';
import { TOKENIZATION_CHAIN_PORT } from './ports/tokenization-chain.port';
import { PublicTokenizationController } from './public-tokenization.controller';
import { PublicTokenizationService } from './public-tokenization.service';
import { TokenizationReader } from './tokenization-reader.service';
import { TokenizationRequestsService } from './tokenization-requests.service';

/**
 * Tokenización (contrato O3 §5, §6 y §8.4; `docs-back/03` §5): solicitudes de
 * la bodega, bandeja del back office, colecciones, NFT por botella y cierre
 * del lote con faltante. Paso 3.3: solicitudes, aprobación (colección +
 * emisión `PENDING` + `tokenization.request_approved`), colecciones y lo
 * público, todo sin red. La red entra por `TOKENIZATION_CHAIN_PORT`: hoy lo
 * cumple un adaptador que solo lee la base; los pasos 3.2 y 3.4 enlazan aquí
 * el suyo. El cierre con faltante sigue con 501 hasta el paso 3.6.
 */
@Module({
  imports: [ChainModule, MailModule, OutboxModule],
  controllers: [
    ErpTokenizationController,
    PlatformTokenizationController,
    PlatformCollectionsController,
    PlatformLotClosuresController,
    PublicTokenizationController,
  ],
  providers: [
    {
      provide: TOKENIZATION_CHAIN_PORT,
      useClass: DatabaseTokenizationChainAdapter,
    },
    TokenizationReader,
    CollectionImagesService,
    TokenizationRequestsService,
    CollectionsService,
    PublicTokenizationService,
    // Mismo freno por IP que el pasaporte (§6.5): los contadores viven en Redis
    PassportLookupLimiter,
  ],
  exports: [TOKENIZATION_CHAIN_PORT],
})
export class TokenizationModule {}
