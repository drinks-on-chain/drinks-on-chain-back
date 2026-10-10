import { Module } from '@nestjs/common';
import { PrismaModule } from '@shared/prisma/prisma.module';
import { WalletsService } from './wallets.service';

/**
 * Lo que queda de las billeteras de 0.1 tras SE-02 (contrato O3 §3.3): la
 * lectura legada de la dirección custodial del consumidor. Sin proveedor
 * simulado y sin escrituras; se retira con la ruta en la Ola 4.
 */
@Module({
  imports: [PrismaModule],
  providers: [WalletsService],
  exports: [WalletsService],
})
export class WalletsModule {}
