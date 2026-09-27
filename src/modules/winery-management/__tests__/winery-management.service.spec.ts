import type { Invitation, Organization } from '@prisma/client';
import type { PrismaService } from '@shared/prisma/prisma.service';
import type { AuditService } from '@shared/audit/audit.service';
import type { OutboxService } from '@shared/outbox/outbox.service';
import type { AuthenticatedUser } from '@shared/decorators/current-user.decorator';
import type { MailService } from '@modules/mail/mail.service';
import type { OrganizationsService } from '@modules/organizations/organizations.service';
import type { MembershipsService } from '@modules/organizations/memberships.service';
import type { SessionsService } from '@modules/auth/sessions/sessions.service';
import type {
  InvitationAcceptedContext,
  InvitationsService,
} from '@modules/invitations/invitations.service';
import { WineryManagementService } from '../winery-management.service';

const WINERY = '22222222-2222-4222-8222-222222222222';

function setup(winery: Record<string, unknown> | null) {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(0),
    winery: {
      findUnique: jest.fn().mockResolvedValue(winery),
      findUniqueOrThrow: jest.fn().mockResolvedValue(winery),
      findMany: jest.fn().mockResolvedValue([{ lotPrefix: 'ALT' }]),
      update: jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...winery, ...args.data }),
      ),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    user: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ fullName: 'Lucía' }),
    },
    membership: {
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    wineryMember: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    wineryStatusChange: { create: jest.fn().mockResolvedValue({}) },
    invitation: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
  };
  const prisma = {
    $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const audit = { record: jest.fn().mockResolvedValue({}) };
  const outbox = { add: jest.fn().mockResolvedValue({}) };
  const organizations = { syncWinery: jest.fn().mockResolvedValue({}) };
  const memberships = {
    setBlocked: jest.fn().mockResolvedValue({}),
    revokeSessionsOf: jest.fn().mockResolvedValue(1),
  };
  const sessions = { revokeForOrganization: jest.fn().mockResolvedValue(3) };
  const invitations = {
    onAccepted: jest.fn(),
    inviterName: jest.fn().mockResolvedValue('Valeria Méndez'),
  };
  const service = new WineryManagementService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    { enqueue: jest.fn() } as unknown as MailService,
    outbox as unknown as OutboxService,
    organizations as unknown as OrganizationsService,
    memberships as unknown as MembershipsService,
    sessions as unknown as SessionsService,
    invitations as unknown as InvitationsService,
  );
  return { service, tx, audit, outbox, memberships, sessions, invitations };
}

function context(
  tx: unknown,
  invitation: Partial<Invitation>,
): InvitationAcceptedContext {
  return {
    tx: tx as InvitationAcceptedContext['tx'],
    invitation: invitation as Invitation,
    organization: { id: WINERY, type: 'WINERY' } as Organization,
    userId: 'new-owner',
    membershipId: 'new-membership',
  };
}

describe('Bodegas: activación, transferencia y estados (ORG-05, 08, 10, 11)', () => {
  it('registra el gancho de aceptación de invitaciones al arrancar', () => {
    const { service, invitations } = setup(null);
    service.onModuleInit();
    expect(invitations.onAccepted).toHaveBeenCalledTimes(1);
  });

  it('el dueño acepta: ACTIVE, prefijo de lote único, historial y winery.activated', async () => {
    const { service, tx, outbox, audit } = setup({
      id: WINERY,
      commercialName: 'Altos del Sur',
      certificationStatus: 'INVITED',
      lotPrefix: null,
      activatedAt: null,
      approvedAt: null,
    });
    await service.onInvitationAccepted(
      context(tx, { purpose: 'OWNER_ONBOARDING' }),
    );
    // Prefijo derivado y libre (ALT estaba tomado)
    expect(tx.winery.update).toHaveBeenCalledWith({
      where: { id: WINERY },
      data: { lotPrefix: 'ASU' },
    });
    expect(tx.winery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          certificationStatus: 'ACTIVE',
          activatedAt: expect.any(Date),
        }),
      }),
    );
    expect(tx.wineryStatusChange.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: 'ACTIVE', byName: 'Lucía' }),
    });
    expect(outbox.add).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        type: 'winery.activated',
        queue: 'chain',
        payload: expect.objectContaining({ lotPrefix: 'ASU' }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'WINERY_ACTIVATED',
        actor: expect.objectContaining({ userId: 'new-owner', role: 'OWNER' }),
      }),
    );
  });

  it('una bodega que no está INVITED no se reactiva al aceptar', async () => {
    const { service, tx, outbox } = setup({
      id: WINERY,
      certificationStatus: 'SUSPENDED',
      lotPrefix: 'ALT',
    });
    await service.onInvitationAccepted(
      context(tx, { purpose: 'OWNER_ONBOARDING' }),
    );
    expect(tx.winery.update).not.toHaveBeenCalled();
    expect(outbox.add).not.toHaveBeenCalled();
  });

  it('transferencia aceptada con BLOCKED: el anterior pasa a enólogo bloqueado y sus sesiones se cierran tras confirmar', async () => {
    const { service, tx, memberships } = setup(null);
    tx.membership.findUnique.mockResolvedValue({
      id: 'old-membership',
      userId: 'old-owner',
      organizationId: WINERY,
      role: 'OWNER',
    });
    const after = await service.onInvitationAccepted(
      context(tx, {
        purpose: 'OWNERSHIP_TRANSFER',
        metadata: {
          previousOwnerMembershipId: 'old-membership',
          keepPreviousOwnerAs: 'BLOCKED',
        },
      }),
    );
    expect(tx.membership.update).toHaveBeenCalledWith({
      where: { id: 'old-membership' },
      data: { role: 'ENOLOGIST' },
    });
    expect(memberships.setBlocked).toHaveBeenCalledWith(tx, 'old-membership', {
      by: 'PLATFORM',
      reason: 'Titularidad transferida',
    });
    // La revocación de sesiones espera a la confirmación
    expect(memberships.revokeSessionsOf).not.toHaveBeenCalled();
    expect(typeof after).toBe('function');
    await (after as () => Promise<void>)();
    expect(memberships.revokeSessionsOf).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'old-owner' }),
      'OWNERSHIP_TRANSFERRED',
    );
  });

  it('transferencia con ENOLOGIST: el anterior sigue activo', async () => {
    const { service, tx, memberships } = setup(null);
    tx.membership.findUnique.mockResolvedValue({
      id: 'old-membership',
      userId: 'old-owner',
      organizationId: WINERY,
      role: 'OWNER',
    });
    await service.onInvitationAccepted(
      context(tx, {
        purpose: 'OWNERSHIP_TRANSFER',
        metadata: {
          previousOwnerMembershipId: 'old-membership',
          keepPreviousOwnerAs: 'ENOLOGIST',
        },
      }),
    );
    expect(memberships.setBlocked).not.toHaveBeenCalled();
  });

  it('suspender desde un estado no permitido → 409 ORG_INVALID_TRANSITION', async () => {
    const { service, sessions } = setup({
      id: WINERY,
      certificationStatus: 'INVITED',
    });
    let error: unknown;
    try {
      await service.changeStatus(WINERY, 'SUSPEND', 'Motivo', {
        id: 'staff',
      } as AuthenticatedUser);
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({
      statusCode: 409,
      errorCode: 'ORG_INVALID_TRANSITION',
    });
    expect(sessions.revokeForOrganization).not.toHaveBeenCalled();
  });
});
