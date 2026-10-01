import { Module } from '@nestjs/common';
import { PrismaModule } from '@shared/prisma/prisma.module';
import { WaitlistService } from './waitlist.service';
import { WaitlistRateLimiter } from './waitlist-rate-limiter';
import {
  PlatformWaitlistController,
  PublicWaitlistController,
} from './waitlist.controller';

/**
 * Lista de espera de consumidores y bodegas (contrato O1b). La bitácora, el
 * captcha y Redis vienen de sus módulos globales.
 */
@Module({
  imports: [PrismaModule],
  controllers: [PublicWaitlistController, PlatformWaitlistController],
  providers: [WaitlistService, WaitlistRateLimiter],
  exports: [WaitlistService],
})
export class WaitlistModule {}
