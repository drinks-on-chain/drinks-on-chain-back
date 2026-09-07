import { Module } from '@nestjs/common';
import { WineriesController } from './wineries.controller';
import { WineriesService } from './wineries.service';
import { WineryRepository } from './repositories/winery.repository';
import { WineryMemberRepository } from './repositories/winery-member.repository';
import { OnchainProducerHook } from './hooks/onchain-producer.hook';
import { WalletsModule } from '@modules/wallets/wallets.module';
import { PrismaModule } from '@shared/prisma/prisma.module';
import { AuthModule } from '@modules/auth/auth.module';

@Module({
  imports: [PrismaModule, WalletsModule, AuthModule],
  controllers: [WineriesController],
  providers: [
    WineriesService,
    WineryRepository,
    WineryMemberRepository,
    OnchainProducerHook,
  ],
  exports: [
    WineriesService,
    WineryRepository,
    WineryMemberRepository,
    OnchainProducerHook,
  ],
})
export class WineriesModule {}
