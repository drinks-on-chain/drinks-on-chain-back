import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { WalletPurposeEnum, WineryCategoryEnum } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { OutboxService } from '../src/shared/outbox/outbox.service';
import { runWithCorrelationId } from '../src/shared/logging/correlation';
import { WineriesService } from '../src/modules/wineries/wineries.service';
import { MockDynamicWalletProvider } from '../src/modules/wallets/providers/mock-dynamic-wallet.provider';
import { deleteIdentityData } from './helpers/identity';

/** Proveedor simulado que puede fallar a propósito a mitad de la operación. */
class FlakyWalletProvider extends MockDynamicWalletProvider {
  fail = false;

  async createCustodialVault(owner: string, purpose: WalletPurposeEnum) {
    if (this.fail) throw new Error('fallo simulado del proveedor');
    return super.createCustodialVault(owner, purpose);
  }
}

/**
 * OP-01 y outbox con Postgres real: las operaciones de varios pasos son todo
 * o nada, y el evento del outbox existe solo si la transacción se confirma.
 */
describe('Outbox y transacciones (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let outbox: OutboxService;
  let wineries: WineriesService;
  const walletProvider = new FlakyWalletProvider();

  const run = `o0be3-${Date.now()}`;
  const ownerEmail = `owner_${run}@test.bo`;
  let ownerId: string;
  const createdWineryIds: string[] = [];

  const wineryDto = (nit: string) => ({
    legalName: `Bodega ${run} S.A.`,
    commercialName: `Bodega ${run}`,
    beverageCategory: WineryCategoryEnum.WINERY,
    taxIdNit: nit,
    geographicRegion: 'Tarija',
    contactEmail: `contacto_${run}@test.bo`,
  });
  const nit = (suffix: string) =>
    `E2E${Date.now().toString().slice(-8)}${suffix}`.slice(0, 20);

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MockDynamicWalletProvider)
      .useValue(walletProvider)
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    outbox = app.get(OutboxService);
    wineries = app.get(WineriesService);

    const owner = await prisma.user.create({
      data: {
        email: ownerEmail,
        passwordHash: 'x',
        fullName: 'Owner E2E',
        userRole: 'CONSUMER',
      },
    });
    ownerId = owner.id;
  });

  afterEach(() => {
    walletProvider.fail = false;
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.outboxEvent.deleteMany({
        where: { correlationId: { startsWith: run } },
      });
      await deleteIdentityData(prisma, {
        emailContains: run,
        wineryIds: createdWineryIds,
      });
      await prisma.userWallet.deleteMany({
        where: {
          OR: [
            { user: { email: { contains: run } } },
            { wineryId: { in: createdWineryIds } },
          ],
        },
      });
      await prisma.wineryMember.deleteMany({
        where: { user: { email: { contains: run } } },
      });
      await prisma.winery.deleteMany({
        where: { id: { in: createdWineryIds } },
      });
      await prisma.user.deleteMany({ where: { email: { contains: run } } });
    }
    await app?.close();
  });

  it('createWinery confirma bodega, membresía, billetera y el evento winery.created', async () => {
    const correlationId = `${run}-ok`;
    const winery = await runWithCorrelationId(correlationId, () =>
      wineries.createWinery(ownerId, wineryDto(nit('A'))),
    );
    createdWineryIds.push(winery.id);

    expect(winery.stellarPublicKey).toMatch(/^G[A-Z0-9]{55}$/);
    const membership = await prisma.wineryMember.findUnique({
      where: { userId_wineryId: { userId: ownerId, wineryId: winery.id } },
    });
    expect(membership?.memberRole).toBe('OWNER');
    // Organización de la bodega (mismo id) y membresía OWNER (mismo id que winery_members)
    const organization = await prisma.organization.findUnique({
      where: { id: winery.id },
    });
    expect(organization).toMatchObject({
      type: 'WINERY',
      status: 'INVITED',
      wineryId: winery.id,
    });
    const orgMembership = await prisma.membership.findUnique({
      where: {
        userId_organizationId: { userId: ownerId, organizationId: winery.id },
      },
    });
    expect(orgMembership).toMatchObject({
      id: membership?.id,
      role: 'OWNER',
      status: 'ACTIVE',
    });
    const wallet = await prisma.userWallet.findFirst({
      where: { wineryId: winery.id },
    });
    expect(wallet?.stellarPublicAddress).toBe(winery.stellarPublicKey);

    const events = await prisma.outboxEvent.findMany({
      where: { correlationId },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'winery.created',
      aggregateType: 'winery',
      aggregateId: winery.id,
      queue: 'chain',
      payload: expect.objectContaining({
        wineryId: winery.id,
        ownerUserId: ownerId,
        walletId: wallet?.id,
      }),
    });
  });

  it('createWinery que falla a mitad (billetera) no deja bodega, membresía ni evento', async () => {
    const correlationId = `${run}-winery-fail`;
    const taxIdNit = nit('B');
    walletProvider.fail = true;

    await expect(
      runWithCorrelationId(correlationId, () =>
        wineries.createWinery(ownerId, wineryDto(taxIdNit)),
      ),
    ).rejects.toThrow('fallo simulado del proveedor');

    expect(await prisma.winery.count({ where: { taxIdNit } })).toBe(0);
    expect(
      await prisma.wineryMember.count({
        where: { userId: ownerId, winery: { taxIdNit } },
      }),
    ).toBe(0);
    expect(await prisma.outboxEvent.count({ where: { correlationId } })).toBe(
      0,
    );
  });

  it('createAndAddMember que falla a mitad (billetera) no deja el usuario', async () => {
    const [winery] = createdWineryIds;
    const correlationId = `${run}-member-wallet-fail`;
    const email = `member_wallet_${run}@test.bo`;
    walletProvider.fail = true;

    await expect(
      runWithCorrelationId(correlationId, () =>
        wineries.createAndAddMember(winery, {
          email,
          password: 'Secreta123',
          fullName: 'Miembro E2E',
          memberRole: 'ENOLOGIST',
        }),
      ),
    ).rejects.toThrow('fallo simulado del proveedor');

    expect(await prisma.user.count({ where: { email } })).toBe(0);
    expect(await prisma.outboxEvent.count({ where: { correlationId } })).toBe(
      0,
    );
  });

  it('createAndAddMember que falla en la membresía no deja usuario ni billetera', async () => {
    const correlationId = `${run}-member-fk-fail`;
    const email = `member_fk_${run}@test.bo`;

    // Bodega inexistente: la membresía viola la clave foránea tras crear
    // usuario y billetera en la misma transacción
    await expect(
      runWithCorrelationId(correlationId, () =>
        wineries.createAndAddMember(randomUUID(), {
          email,
          password: 'Secreta123',
          fullName: 'Miembro E2E',
          memberRole: 'ENOLOGIST',
        }),
      ),
    ).rejects.toThrow();

    expect(await prisma.user.count({ where: { email } })).toBe(0);
    expect(await prisma.userWallet.count({ where: { user: { email } } })).toBe(
      0,
    );
    expect(await prisma.outboxEvent.count({ where: { correlationId } })).toBe(
      0,
    );
  });

  it('createAndAddMember confirma usuario, billetera, membresía y member.added', async () => {
    const [wineryId] = createdWineryIds;
    const correlationId = `${run}-member-ok`;
    const email = `member_ok_${run}@test.bo`;

    const member = await runWithCorrelationId(correlationId, () =>
      wineries.createAndAddMember(wineryId, {
        email,
        password: 'Secreta123',
        fullName: 'Miembro E2E',
        memberRole: 'ENOLOGIST',
      }),
    );

    expect(member.email).toBe(email);
    const wallet = await prisma.userWallet.findFirst({
      where: { userId: member.userId },
    });
    expect(wallet).not.toBeNull();
    const [event] = await prisma.outboxEvent.findMany({
      where: { correlationId },
    });
    expect(event).toMatchObject({
      eventType: 'member.added',
      aggregateId: wineryId,
      payload: expect.objectContaining({
        userId: member.userId,
        memberId: member.id,
        walletId: wallet?.id,
      }),
    });
  });

  it('si la transacción se revierte, el evento no existe', async () => {
    const correlationId = `${run}-rollback`;

    await expect(
      prisma.$transaction(async (tx) => {
        await outbox.add(tx, {
          type: 'e2e.rollback',
          aggregateType: 'e2e',
          aggregateId: run,
          payload: { n: 1 },
          correlationId,
        });
        // Visible dentro de la transacción…
        expect(await tx.outboxEvent.count({ where: { correlationId } })).toBe(
          1,
        );
        throw new Error('rollback a propósito');
      }),
    ).rejects.toThrow('rollback a propósito');

    // …e inexistente fuera tras el rollback
    expect(await prisma.outboxEvent.count({ where: { correlationId } })).toBe(
      0,
    );
  });

  it('OutboxService.add rechaza escribir fuera de una transacción', async () => {
    await expect(
      outbox.add(prisma, {
        type: 'e2e.no_tx',
        aggregateType: 'e2e',
        aggregateId: run,
        payload: {},
        correlationId: `${run}-no-tx`,
      }),
    ).rejects.toThrow(/transacción/);
    expect(
      await prisma.outboxEvent.count({
        where: { correlationId: `${run}-no-tx` },
      }),
    ).toBe(0);
  });
});
