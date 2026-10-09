import { WalletPurposeEnum, WalletTypeEnum } from '@prisma/client';
import { AppException } from '@shared/exceptions/app.exception';
import type { PrismaService } from '@shared/prisma/prisma.service';
import { WalletsService } from '../wallets.service';

/** SE-02 (contrato O3 §3.3.5): la ruta legada ya no sirve direcciones simuladas. */
describe('WalletsService', () => {
  const prisma = {
    consumerAddress: { findUnique: jest.fn() },
    userWallet: { findFirst: jest.fn(), create: jest.fn() },
  };
  const service = new WalletsService(prisma as unknown as PrismaService);
  const ADDRESS = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';

  beforeEach(() => jest.clearAllMocks());

  const expectNotAvailable = async (work: Promise<unknown>) => {
    const error = await work.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AppException);
    expect(error).toMatchObject({
      statusCode: 404,
      errorCode: 'CHN_WALLET_NOT_AVAILABLE',
    });
  };

  it('al personal le responde 404 CHN_WALLET_NOT_AVAILABLE sin mirar la base', async () => {
    await expectNotAvailable(
      service.getWallet({ id: 'staff-1', audience: 'STAFF' }),
    );
    expect(prisma.consumerAddress.findUnique).not.toHaveBeenCalled();
  });

  it('a un consumidor sin dirección asignada, el mismo 404', async () => {
    prisma.consumerAddress.findUnique.mockResolvedValue(null);
    await expectNotAvailable(
      service.getWallet({ id: 'consumer-1', audience: 'CONSUMER' }),
    );
  });

  it('a un consumidor le da su dirección custodial derivada con la forma de siempre', async () => {
    const createdAt = new Date('2026-10-08T12:00:00Z');
    prisma.consumerAddress.findUnique.mockResolvedValue({
      userId: 'consumer-1',
      index: 7,
      address: ADDRESS,
      derivationPath: "m/44'/148'/7'",
      network: 'TESTNET',
      status: 'ACTIVE',
      createdAt,
    });

    const wallet = await service.getWallet({
      id: 'consumer-1',
      audience: 'CONSUMER',
    });

    expect(wallet).toEqual({
      id: 'consumer-1',
      userId: 'consumer-1',
      wineryId: null,
      stellarPublicAddress: ADDRESS,
      walletType: WalletTypeEnum.CUSTODIAL,
      walletPurpose: WalletPurposeEnum.CONSUMER_NFT,
      isPrimary: true,
      createdAt,
    });
    // Ni índice ni ruta de derivación: solo la dirección
    expect(wallet).not.toHaveProperty('index');
    expect(wallet).not.toHaveProperty('derivationPath');
  });

  it('nunca lee ni crea una billetera simulada (user_wallets)', async () => {
    prisma.consumerAddress.findUnique.mockResolvedValue(null);
    await service
      .getWallet({ id: 'consumer-1', audience: 'CONSUMER' })
      .catch(() => undefined);
    expect(prisma.userWallet.findFirst).not.toHaveBeenCalled();
    expect(prisma.userWallet.create).not.toHaveBeenCalled();
  });
});
