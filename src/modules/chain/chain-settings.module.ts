import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisModule } from '@shared/redis/redis.module';
import { ChainBalanceCache } from './accounts/chain-balance-cache';
import { CHAIN_SETTINGS, chainSettingsFromConfig } from './chain.config';

/**
 * Configuración de la cadena (`ChainSettings`) y la caché de saldos de las
 * cuentas de la plataforma, para la API y el worker. No lleva secretos: las
 * claves solo las ve el custodio, en el worker (`jobs/chain-jobs.module.ts`).
 */
@Module({
  imports: [RedisModule],
  providers: [
    {
      provide: CHAIN_SETTINGS,
      useFactory: chainSettingsFromConfig,
      inject: [ConfigService],
    },
    ChainBalanceCache,
  ],
  exports: [CHAIN_SETTINGS, ChainBalanceCache],
})
export class ChainSettingsModule {}
