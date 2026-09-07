import { Module } from '@nestjs/common';
import { WalletsService } from './wallets.service';
import { WalletRepository } from './repositories/wallet.repository';
import { MockDynamicWalletProvider } from './providers/mock-dynamic-wallet.provider';
import { PrismaModule } from '@shared/prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [
    WalletsService,
    WalletRepository,
    {
      provide: 'IWalletProvider',
      useClass: MockDynamicWalletProvider,
    },
    // Alias para inyección directa de IWalletProvider
    {
      provide: MockDynamicWalletProvider,
      useClass: MockDynamicWalletProvider,
    },
    {
      provide: WalletsService,
      useFactory: (repo: WalletRepository, provider: MockDynamicWalletProvider) => {
        return new WalletsService(repo, provider);
      },
      inject: [WalletRepository, MockDynamicWalletProvider],
    },
  ],
  exports: [WalletsService, WalletRepository, 'IWalletProvider'],
})
export class WalletsModule {}
