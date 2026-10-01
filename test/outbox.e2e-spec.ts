import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { WalletPurposeEnum, WineryCategoryEnum } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { OutboxService } from '../src/shared/outbox/outbox.service';
import { runWithCorrelationId } from '../src/shared/logging/correlation';
import {
  ActorRef,
  WineryManagementService,
} from '../src/modules/winery-management/winery-management.service';
import { InvitationsService } from '../src/modules/invitations/invitations.service';
import { MockDynamicWalletProvider } from '../src/modules/wallets/providers/mock-dynamic-wallet.provider';
import { createPlatformUser, deleteIdentityData } from './helpers/identity';

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
 * Desde H1 la operación de referencia es aceptar la invitación del dueño
 * (cuenta, billetera, membresía, activación y `winery.activated`); la
 * autoinscripción y `members/create` se retiraron.
 */
describe('Outbox y transacciones (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let outbox: OutboxService;
  let management: WineryManagementService;
  let invitations: InvitationsService;
  let actor: ActorRef;
  const walletProvider = new FlakyWalletProvider();

  const run = `o0be3-${Date.now()}`;
  const createdWineryIds: string[] = [];
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
    management = app.get(WineryManagementService);
    invitations = app.get(InvitationsService);
    const staff = await createPlatformUser(prisma, {
      email: `staff_${run}@test.bo`,
      password: 'Password123!',
      fullName: 'Operaciones E2E',
      role: 'OPERATIONS',
    });
    actor = { userId: staff.id, fullName: staff.fullName };
  });

  afterEach(() => {
    walletProvider.fail = false;
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.outboxEvent.deleteMany({
        where: { correlationId: { startsWith: run } },
      });
      const mails = await prisma.emailMessage.findMany({
        where: { toAddress: { contains: run } },
        select: { id: true },
      });
      await prisma.outboxEvent.deleteMany({
        where: { aggregateId: { in: mails.map((m) => m.id) } },
      });
      await prisma.emailMessage.deleteMany({
        where: { id: { in: mails.map((m) => m.id) } },
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

  /** Bodega INVITED con la invitación de su dueña (alta directa) y el token del correo. */
  async function invitedWinery(suffix: string) {
    const ownerEmail = `owner_${suffix}_${run}@test.bo`.toLowerCase();
    const winery = await prisma.$transaction((tx) =>
      management.createInvitedWinery(
        tx,
        {
          legalName: `Bodega ${suffix} ${run} S.A.`,
          tradeName: `Bodega ${suffix} ${run}`,
          taxId: nit(suffix),
          category: WineryCategoryEnum.WINERY,
          region: 'Tarija',
          contactEmail: ownerEmail,
        },
        actor,
        null,
      ),
    );
    createdWineryIds.push(winery.id);
    await prisma.$transaction((tx) =>
      management.inviteOwner(tx, {
        wineryId: winery.id,
        email: ownerEmail,
        fullName: 'Dueña E2E',
        actor,
        reason: null,
      }),
    );
    const mail = await prisma.emailMessage.findFirstOrThrow({
      where: { toAddress: ownerEmail, template: 'invitacion' },
      orderBy: { createdAt: 'desc' },
    });
    const link = (mail.variables as { enlace: string }).enlace;
    const token = decodeURIComponent(
      /invitacion\/([A-Za-z0-9_-]+)/.exec(link)![1],
    );
    return { wineryId: winery.id, ownerEmail, token };
  }

  const accept = (token: string) =>
    invitations.accept(
      token,
      { fullName: 'Dueña E2E', password: 'Vendimia-Tarija-2026' },
      null,
      null,
      { ip: '127.0.0.1', userAgent: 'e2e' },
    );

  it('aceptar la invitación del dueño confirma cuenta, billetera, membresía, activación y winery.activated', async () => {
    const { wineryId, ownerEmail, token } = await invitedWinery('A');
    const correlationId = `${run}-ok`;

    await runWithCorrelationId(correlationId, () => accept(token));

    const owner = await prisma.user.findUniqueOrThrow({
      where: { email: ownerEmail },
    });
    const wallet = await prisma.userWallet.findFirst({
      where: { userId: owner.id },
    });
    expect(wallet?.stellarPublicAddress).toMatch(/^G[A-Z0-9]{55}$/);
    // Membresía OWNER y su espejo en winery_members (mismo id)
    const membership = await prisma.membership.findUniqueOrThrow({
      where: {
        userId_organizationId: { userId: owner.id, organizationId: wineryId },
      },
    });
    expect(membership).toMatchObject({ role: 'OWNER', status: 'ACTIVE' });
    const member = await prisma.wineryMember.findUnique({
      where: { userId_wineryId: { userId: owner.id, wineryId } },
    });
    expect(member).toMatchObject({ id: membership.id, memberRole: 'OWNER' });
    const winery = await prisma.winery.findUniqueOrThrow({
      where: { id: wineryId },
    });
    expect(winery.certificationStatus).toBe('ACTIVE');
    expect(winery.lotPrefix).toMatch(/^[A-Z]{3,5}$/);

    const events = await prisma.outboxEvent.findMany({
      where: { correlationId, eventType: 'winery.activated' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      aggregateType: 'winery',
      aggregateId: wineryId,
      queue: 'chain',
    });
  });

  it('una aceptación que falla a mitad (billetera) no deja cuenta, membresía, activación ni evento', async () => {
    const { wineryId, ownerEmail, token } = await invitedWinery('B');
    const correlationId = `${run}-fail`;
    walletProvider.fail = true;

    await expect(
      runWithCorrelationId(correlationId, () => accept(token)),
    ).rejects.toThrow('fallo simulado del proveedor');

    expect(await prisma.user.count({ where: { email: ownerEmail } })).toBe(0);
    expect(
      await prisma.membership.count({ where: { organizationId: wineryId } }),
    ).toBe(0);
    expect(await prisma.wineryMember.count({ where: { wineryId } })).toBe(0);
    expect(
      (await prisma.winery.findUniqueOrThrow({ where: { id: wineryId } }))
        .certificationStatus,
    ).toBe('INVITED');
    expect(
      await prisma.invitation.count({
        where: { organizationId: wineryId, status: 'PENDING' },
      }),
    ).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { correlationId } })).toBe(
      0,
    );

    // Tras el fallo, la misma invitación se puede aceptar
    walletProvider.fail = false;
    await accept(token);
    expect(
      (await prisma.winery.findUniqueOrThrow({ where: { id: wineryId } }))
        .certificationStatus,
    ).toBe('ACTIVE');
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
