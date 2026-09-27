import { Test, TestingModule } from '@nestjs/testing';
import { WalletsService } from '../wallets.service';
import { WalletRepository } from '../repositories/wallet.repository';
import { MockDynamicWalletProvider } from '../providers/mock-dynamic-wallet.provider';
import { WalletPurposeEnum, WalletTypeEnum } from '@prisma/client';

describe('WalletsService', () => {
  let service: WalletsService;

  const mockWalletRepository = {
    findByUserId: jest.fn(),
    findByWineryId: jest.fn(),
    create: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletsService,
        { provide: WalletRepository, useValue: mockWalletRepository },
        { provide: 'IWalletProvider', useClass: MockDynamicWalletProvider },
        {
          provide: MockDynamicWalletProvider,
          useClass: MockDynamicWalletProvider,
        },
        {
          provide: WalletsService,
          useFactory: (
            repo: WalletRepository,
            prov: MockDynamicWalletProvider,
          ) => {
            return new WalletsService(repo, prov);
          },
          inject: [WalletRepository, MockDynamicWalletProvider],
        },
      ],
    }).compile();

    service = module.get<WalletsService>(WalletsService);

    jest.clearAllMocks();
  });

  describe('provisionUserWallet', () => {
    it('debe generar una nueva billetera custodial si el usuario no tiene una', async () => {
      mockWalletRepository.findByUserId.mockResolvedValue(null);
      mockWalletRepository.create.mockImplementation((data) =>
        Promise.resolve({
          id: 'wallet-uuid-1',
          createdAt: new Date(),
          ...data,
        }),
      );

      const wallet = await service.provisionUserWallet('user-uuid-1');

      expect(wallet.userId).toBe('user-uuid-1');
      expect(wallet.stellarPublicAddress).toMatch(/^G[A-Z0-9]{55}$/);
      expect(wallet.walletType).toBe(WalletTypeEnum.CUSTODIAL);
      expect(wallet.walletPurpose).toBe(WalletPurposeEnum.CONSUMER_NFT);
      expect(mockWalletRepository.create).toHaveBeenCalledTimes(1);
    });

    it('debe retornar la billetera existente si el usuario ya cuenta con una', async () => {
      const existing = {
        id: 'wallet-uuid-1',
        userId: 'user-uuid-1',
        stellarPublicAddress:
          'GBZXN7PIRZGNMHGA728JHIITLTINIQUVFD2AZN5HQG5Y3SQ4Q',
        walletType: WalletTypeEnum.CUSTODIAL,
        walletPurpose: WalletPurposeEnum.CONSUMER_NFT,
        isPrimary: true,
        createdAt: new Date(),
      };
      mockWalletRepository.findByUserId.mockResolvedValue(existing);

      const wallet = await service.provisionUserWallet('user-uuid-1');

      expect(wallet.stellarPublicAddress).toBe(existing.stellarPublicAddress);
      expect(mockWalletRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('provisionWineryWallet', () => {
    it('debe generar una billetera custodial institucional para la bodega', async () => {
      mockWalletRepository.findByWineryId.mockResolvedValue(null);
      mockWalletRepository.create.mockImplementation((data) =>
        Promise.resolve({
          id: 'wallet-uuid-winery-1',
          createdAt: new Date(),
          ...data,
        }),
      );

      const wallet = await service.provisionWineryWallet(
        'user-admin-1',
        'winery-uuid-1',
      );

      expect(wallet.wineryId).toBe('winery-uuid-1');
      expect(wallet.walletPurpose).toBe(WalletPurposeEnum.PRODUCER_SIGNING);
      expect(wallet.stellarPublicAddress).toMatch(/^G[A-Z0-9]{55}$/);
    });
  });
});
