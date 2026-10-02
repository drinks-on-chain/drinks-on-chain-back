import { Module } from '@nestjs/common';
import { PrismaModule } from '@shared/prisma/prisma.module';
import { OutboxModule } from '@shared/outbox/outbox.module';
import { BottleCodeExportBuilder } from './bottle-code-export.builder';
import { BottleCodesService } from './bottle-codes.service';
import { DossierService } from './dossier.service';

/**
 * Códigos de botella (contrato O2 §7) y expediente del lote con hash
 * canónico (§10): pasos 2.6 y 2.8 de la Etapa 2. Sus rutas están en
 * `contract/bottle-codes.controller.ts` y `contract/dossier.controller.ts`.
 */
@Module({
  imports: [PrismaModule, OutboxModule],
  providers: [BottleCodesService, DossierService, BottleCodeExportBuilder],
  exports: [BottleCodesService, DossierService, BottleCodeExportBuilder],
})
export class LotCertificationModule {}
