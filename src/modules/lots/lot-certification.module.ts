import { Module } from '@nestjs/common';
import { PrismaModule } from '@shared/prisma/prisma.module';
import { OutboxModule } from '@shared/outbox/outbox.module';
import { BottleCodeExportBuilder } from './bottle-code-export.builder';
import { BottleCodesService } from './bottle-codes.service';

/**
 * Códigos de botella (contrato O2 §7): paso 2.6 de la Etapa 2. Sus rutas
 * están en `contract/bottle-codes.controller.ts`.
 */
@Module({
  imports: [PrismaModule, OutboxModule],
  providers: [BottleCodesService, BottleCodeExportBuilder],
  exports: [BottleCodesService, BottleCodeExportBuilder],
})
export class LotCertificationModule {}
