import { Module } from '@nestjs/common';
import type Redis from 'ioredis';
import { PrismaModule } from '@shared/prisma/prisma.module';
import { OutboxModule } from '@shared/outbox/outbox.module';
import { REDIS_CLIENT } from '@shared/redis/redis.module';
import { AuthModule } from '@modules/auth/auth.module';
import { SETTINGS_CACHE, RedisSettingsCache } from './settings.cache';
import { SettingsService } from './settings.service';
import { SettingsCatalogSync } from './settings-catalog.sync';
import { SettingsController } from './settings.controller';

/**
 * Configuración en dos niveles (docs/arquitectura/configuracion.md). Usa el
 * cliente de `RedisModule` (global) para la caché.
 */
@Module({
  imports: [PrismaModule, OutboxModule, AuthModule],
  controllers: [SettingsController],
  providers: [
    {
      provide: SETTINGS_CACHE,
      inject: [REDIS_CLIENT],
      useFactory: (redis: Redis) => new RedisSettingsCache(redis),
    },
    SettingsService,
    SettingsCatalogSync,
  ],
  exports: [SettingsService],
})
export class SettingsModule {}
