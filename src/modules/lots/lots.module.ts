import { Module } from '@nestjs/common';
import { PrismaModule } from '@shared/prisma/prisma.module';
import { LotsController } from './lots.controller';
import { LotsService } from './lots.service';
import { LotBackfillRunner } from './lot-backfill.runner';

/**
 * Lote del servidor y trazabilidad confiable (Ola 2, contrato O2). Las rutas
 * del contrato cuya lógica llega en pasos posteriores están en
 * `contract/` (501 `NOT_IMPLEMENTED`).
 */
@Module({
  imports: [PrismaModule],
  controllers: [LotsController],
  providers: [LotsService, LotBackfillRunner],
  exports: [LotsService, LotBackfillRunner],
})
export class LotsModule {}
