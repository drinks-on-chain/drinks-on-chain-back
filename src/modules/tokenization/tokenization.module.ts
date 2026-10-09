import { Module } from '@nestjs/common';
import { ChainModule } from '@modules/chain/chain.module';
import { ErpTokenizationController } from './erp-tokenization.controller';
import {
  PlatformCollectionsController,
  PlatformLotClosuresController,
} from './platform-collections.controller';
import { PlatformTokenizationController } from './platform-tokenization.controller';
import { PublicTokenizationController } from './public-tokenization.controller';

/**
 * Tokenización (contrato O3 §5, §6 y §8.4; `docs-back/03` §5): solicitudes de
 * la bodega, bandeja del back office, colecciones, NFT por botella y cierre
 * del lote con faltante. Apertura de la ola: las rutas están publicadas con su
 * forma y responden 501 hasta su paso (3.3–3.6).
 */
@Module({
  imports: [ChainModule],
  controllers: [
    ErpTokenizationController,
    PlatformTokenizationController,
    PlatformCollectionsController,
    PlatformLotClosuresController,
    PublicTokenizationController,
  ],
})
export class TokenizationModule {}
