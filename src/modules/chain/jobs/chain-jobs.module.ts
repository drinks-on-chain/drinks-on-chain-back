import { Inject, Logger, Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaModule } from '@shared/prisma/prisma.module';
import { PrismaService } from '@shared/prisma/prisma.service';
import { ChainSettingsModule } from '../chain-settings.module';
import { CHAIN_SETTINGS, type ChainSettings } from '../chain.config';
import { createKeyCustody } from '../custody/custody.factory';
import { KEY_CUSTODY } from '../custody/key-custody';

/**
 * Cadena en el worker (contrato O3 §2): aquí vive el custodio de claves, y
 * aquí llegarán el firmante, las colas `chain` y `chain-poll` y las tareas
 * programadas (pasos 3.1–3.6). La API no lo carga: nunca tiene claves.
 *
 * En la apertura solo deja constancia del estado de la cadena al arrancar;
 * todavía no hay ninguna lógica que envíe nada a la red.
 */
@Module({
  imports: [PrismaModule, ChainSettingsModule],
  providers: [
    {
      provide: KEY_CUSTODY,
      useFactory: createKeyCustody,
      inject: [CHAIN_SETTINGS, ConfigService, PrismaService],
    },
  ],
  exports: [KEY_CUSTODY, ChainSettingsModule],
})
export class ChainJobsModule implements OnModuleInit {
  private readonly logger = new Logger(ChainJobsModule.name);

  constructor(
    @Inject(CHAIN_SETTINGS) private readonly settings: ChainSettings,
  ) {}

  onModuleInit(): void {
    const { enabled, network, custodyDriver, mintEnabled } = this.settings;
    this.logger.log(
      enabled
        ? `Cadena habilitada: red ${network}, custodio ${custodyDriver}, emisión ${mintEnabled ? 'activa' : 'apagada (CHAIN_MINT_ENABLED=false)'}`
        : 'Cadena deshabilitada: faltan CHAIN_CUSTODY_DRIVER o STELLAR_RPC_URL',
    );
  }
}
