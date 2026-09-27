import { Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { PrismaModule } from '@shared/prisma/prisma.module';
import { SESSION_REDIS, sessionRedisProvider } from './session-redis';
import { SESSION_SETTINGS, sessionSettingsFromConfig } from './session.config';
import { SessionRevocationStore } from './session-revocation.store';
import { SessionsService } from './sessions.service';

/**
 * Sesiones y lista de revocación. Sin dependencias de otros módulos de
 * dominio: lo importan la autenticación y las membresías (que revocan al
 * bloquear).
 */
@Module({
  imports: [PrismaModule],
  providers: [
    sessionRedisProvider,
    {
      provide: SESSION_SETTINGS,
      inject: [ConfigService],
      useFactory: sessionSettingsFromConfig,
    },
    SessionRevocationStore,
    SessionsService,
  ],
  exports: [
    SESSION_REDIS,
    SESSION_SETTINGS,
    SessionRevocationStore,
    SessionsService,
  ],
})
export class SessionsModule implements OnApplicationShutdown {
  constructor(@Inject(SESSION_REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status === 'ready') {
      await this.redis.quit();
    } else {
      this.redis.disconnect();
    }
  }
}
