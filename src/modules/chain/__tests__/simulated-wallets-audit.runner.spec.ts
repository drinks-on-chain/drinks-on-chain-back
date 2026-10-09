import type { AuditService } from '@shared/audit/audit.service';
import type { PrismaService } from '@shared/prisma/prisma.service';
import {
  SIMULATED_WALLETS_MIGRATION,
  SimulatedWalletsAuditRunner,
} from '../simulated-wallets-audit.runner';

/** SE-02 (contrato O3 §3.3, paso 6): la entrada de la bitácora, una sola vez. */
describe('SimulatedWalletsAuditRunner', () => {
  function setup(data: {
    existing?: boolean;
    userWallets?: number;
    wineries?: number;
  }) {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      auditEvent: {
        findFirst: jest
          .fn()
          .mockResolvedValue(data.existing ? { id: 'evt-1' } : null),
      },
      userWallet: { count: jest.fn().mockResolvedValue(data.userWallets ?? 0) },
      winery: { count: jest.fn().mockResolvedValue(data.wineries ?? 0) },
    };
    const prisma = {
      $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
    };
    const audit = { record: jest.fn().mockResolvedValue({}) };
    const runner = new SimulatedWalletsAuditRunner(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
    );
    return { tx, prisma, audit, runner };
  }

  it('anota las filas invalidadas con actor sistema, en la misma transacción', async () => {
    const { runner, audit, tx } = setup({ userWallets: 18, wineries: 3 });

    expect(await runner.run()).toEqual({ userWallets: 18, wineries: 3 });

    expect(tx.userWallet.count).toHaveBeenCalledWith({
      where: { status: 'INVALID_SIMULATED' },
    });
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'CHAIN_SIMULATED_WALLETS_INVALIDATED',
        resource: { type: 'chain', id: null },
        actor: null,
        after: {
          userWallets: 18,
          wineries: 3,
          migration: SIMULATED_WALLETS_MIGRATION,
        },
      }),
    );
    // El candado se toma antes de mirar si ya existe
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.auditEvent.findFirst.mock.invocationCallOrder[0],
    );
  });

  it('no la repite si ya está en la bitácora', async () => {
    const { runner, audit, tx } = setup({ existing: true, userWallets: 18 });
    expect(await runner.run()).toBeNull();
    expect(audit.record).not.toHaveBeenCalled();
    expect(tx.userWallet.count).not.toHaveBeenCalled();
  });

  it('en una base sin billeteras simuladas no escribe nada', async () => {
    const { runner, audit } = setup({});
    expect(await runner.run()).toBeNull();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('un fallo no impide arrancar la API', async () => {
    const { runner, prisma } = setup({ userWallets: 1 });
    (prisma.$transaction as jest.Mock).mockRejectedValueOnce(
      new Error('base no disponible'),
    );
    await expect(runner.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
