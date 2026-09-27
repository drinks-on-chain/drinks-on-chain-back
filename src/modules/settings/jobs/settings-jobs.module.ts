import { Module } from '@nestjs/common';
import type Redis from 'ioredis';
import { RedisModule, REDIS_CLIENT } from '@shared/redis/redis.module';
import { SETTINGS_CACHE, RedisSettingsCache } from '../settings.cache';
import { SettingChangedHandler } from './setting-changed.handler';

/** Procesadores del módulo de configuración en el worker. */
@Module({
  imports: [RedisModule],
  providers: [
    {
      provide: SETTINGS_CACHE,
      inject: [REDIS_CLIENT],
      useFactory: (redis: Redis) => new RedisSettingsCache(redis),
    },
    SettingChangedHandler,
  ],
})
export class SettingsJobsModule {}
