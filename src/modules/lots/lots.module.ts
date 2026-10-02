import { Module } from '@nestjs/common';
import { PrismaModule } from '@shared/prisma/prisma.module';
import { LotsController } from './lots.controller';
import { LotsService } from './lots.service';

/**
 * Lote del servidor y trazabilidad confiable (Ola 2, contrato O2). Los
 * controladores de las demás rutas del contrato están en `contract/`
 * (`LotsContractModule` y `LotViewsModule`); ninguna responde ya 501.
 */
@Module({
  imports: [PrismaModule],
  controllers: [LotsController],
  providers: [LotsService],
  exports: [LotsService],
})
export class LotsModule {}
