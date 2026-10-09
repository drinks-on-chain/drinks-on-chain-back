import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CHAIN_SETTINGS, chainSettingsFromConfig } from './chain.config';

/**
 * Configuración de la cadena (`ChainSettings`) para la API y el worker. No
 * lleva secretos: las claves solo las ve el custodio, en el worker
 * (`jobs/chain-jobs.module.ts`).
 */
@Module({
  providers: [
    {
      provide: CHAIN_SETTINGS,
      useFactory: chainSettingsFromConfig,
      inject: [ConfigService],
    },
  ],
  exports: [CHAIN_SETTINGS],
})
export class ChainSettingsModule {}
