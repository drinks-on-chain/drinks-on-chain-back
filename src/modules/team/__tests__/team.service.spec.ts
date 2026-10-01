import type { PrismaService } from '@shared/prisma/prisma.service';
import type { AuditService } from '@shared/audit/audit.service';
import type { AuthenticatedUser } from '@shared/decorators/current-user.decorator';
import type { MembershipsService } from '@modules/organizations/memberships.service';
import type { InvitationsService } from '@modules/invitations/invitations.service';
import { TeamActor, TeamService } from '../team.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = 'owner-user';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'm-1',
    userId: 'u-1',
    organizationId: ORG,
    role: 'OPERATOR',
    status: 'ACTIVE',
    blockedBy: null,
    blockedReason: null,
    blockedAt: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    user: {
      id: 'u-1',
      fullName: 'Pedro Operario',
      email: 'pedro@test.bo',
      lastLoginAt: new Date('2026-09-20T00:00:00Z'),
      isActive: true,
      blockedReason: null,
    },
    ...overrides,
  };
}

function setup(target: ReturnType<typeof row> | null) {
  const tx = {
    membership: {
      update: jest.fn().mockResolvedValue(target),
      findUniqueOrThrow: jest.fn().mockResolvedValue(target),
    },
    wineryMember: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    organization: {
      findUniqueOrThrow: jest
        .fn()
        .mockResolvedValue({ id: ORG, name: 'Bodega' }),
    },
  };
  const prisma = {
    membership: { findUnique: jest.fn().mockResolvedValue(target) },
    $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const audit = { record: jest.fn().mockResolvedValue({}) };
  const memberships = {
    setBlocked: jest.fn().mockResolvedValue({}),
    setUnblocked: jest.fn().mockResolvedValue({}),
    revokeSessionsOf: jest.fn().mockResolvedValue(2),
  };
  const invitations = {
    notifyOwner: jest.fn().mockResolvedValue(undefined),
    assertCapacityForMember: jest.fn().mockResolvedValue(undefined),
  };
  const service = new TeamService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    memberships as unknown as MembershipsService,
    invitations as unknown as InvitationsService,
  );
  return { service, tx, audit, memberships, invitations };
}

const owner: TeamActor = {
  principal: { id: OWNER_ID } as AuthenticatedUser,
  viaPlatform: false,
};
const platform: TeamActor = {
  principal: { id: 'staff' } as AuthenticatedUser,
  viaPlatform: true,
};

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('No lanzó');
}

describe('Equipo de la bodega (EQP-04…08, EQP-10)', () => {
  it('membresía de otra organización → 404', async () => {
    const { service } = setup(row({ organizationId: 'otra' }));
    expect(
      await errorOf(service.setBlocked(ORG, 'm-1', true, owner, null)),
    ).toMatchObject({ statusCode: 404 });
  });

  it('nadie se cambia ni se bloquea a sí mismo → 403 ORG_CANNOT_MODIFY_SELF', async () => {
    const { service } = setup(row({ userId: OWNER_ID }));
    expect(
      await errorOf(service.setBlocked(ORG, 'm-1', true, owner, null)),
    ).toMatchObject({ statusCode: 403, errorCode: 'ORG_CANNOT_MODIFY_SELF' });
  });

  it('OWNER no se asigna ni se quita por rol → 403 ORG_OWNER_ROLE_RESERVED', async () => {
    const { service } = setup(row());
    expect(
      await errorOf(service.changeRole(ORG, 'm-1', 'OWNER', owner, null)),
    ).toMatchObject({ errorCode: 'ORG_OWNER_ROLE_RESERVED' });
    const other = setup(row({ role: 'OWNER' }));
    expect(
      await errorOf(
        other.service.changeRole(ORG, 'm-1', 'ENOLOGIST', platform, 'Motivo'),
      ),
    ).toMatchObject({ errorCode: 'ORG_OWNER_ROLE_RESERVED' });
  });

  it('cambiar el rol cierra las sesiones de la persona (ROLE_CHANGED); desde la plataforma avisa al dueño salvo al afectado', async () => {
    const { service, memberships, invitations, audit } = setup(row());
    await service.changeRole(ORG, 'm-1', 'ACCOUNTANT', platform, 'Pedido');
    expect(memberships.revokeSessionsOf).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'm-1' }),
      'ROLE_CHANGED',
    );
    expect(invitations.notifyOwner).toHaveBeenCalledWith(
      expect.anything(),
      { id: ORG, name: 'Bodega' },
      expect.objectContaining({ exceptUserId: 'u-1', motivo: 'Pedido' }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'MEMBER_ROLE_CHANGED',
        before: { role: 'OPERATOR' },
        after: { role: 'ACCOUNTANT' },
        reason: 'Pedido',
      }),
    );
  });

  it('el mismo rol no escribe nada', async () => {
    const { service, audit, memberships } = setup(row());
    const member = await service.changeRole(
      ORG,
      'm-1',
      'OPERATOR',
      owner,
      null,
    );
    expect(member.role).toBe('OPERATOR');
    expect(audit.record).not.toHaveBeenCalled();
    expect(memberships.revokeSessionsOf).not.toHaveBeenCalled();
  });

  it('bloquear: quién bloquea, sesiones revocadas y sin aviso si lo hace el dueño', async () => {
    const { service, memberships, invitations } = setup(row());
    await service.setBlocked(ORG, 'm-1', true, owner, 'Dejó la bodega');
    expect(memberships.setBlocked).toHaveBeenCalledWith(
      expect.anything(),
      'm-1',
      { by: 'OWNER', reason: 'Dejó la bodega' },
    );
    expect(memberships.revokeSessionsOf).toHaveBeenCalled();
    expect(invitations.notifyOwner).not.toHaveBeenCalled();
  });

  it('ya bloqueado → 409; no bloqueado → 409 al desbloquear', async () => {
    const blocked = setup(row({ status: 'BLOCKED', blockedBy: 'OWNER' }));
    expect(
      await errorOf(blocked.service.setBlocked(ORG, 'm-1', true, owner, null)),
    ).toMatchObject({ statusCode: 409 });
    const active = setup(row());
    expect(
      await errorOf(active.service.setBlocked(ORG, 'm-1', false, owner, null)),
    ).toMatchObject({ statusCode: 409 });
  });

  it('el dueño no desbloquea lo que bloqueó la plataforma; la plataforma sí (con el cupo)', async () => {
    const byPlatform = row({ status: 'BLOCKED', blockedBy: 'PLATFORM' });
    const first = setup(byPlatform);
    expect(
      await errorOf(first.service.setBlocked(ORG, 'm-1', false, owner, null)),
    ).toMatchObject({ statusCode: 403, errorCode: 'ORG_BLOCKED_BY_PLATFORM' });

    const second = setup(byPlatform);
    await second.service.setBlocked(ORG, 'm-1', false, platform, 'Aclarado');
    expect(second.invitations.assertCapacityForMember).toHaveBeenCalledWith(
      expect.anything(),
      ORG,
    );
    expect(second.memberships.setUnblocked).toHaveBeenCalled();
    expect(second.memberships.revokeSessionsOf).not.toHaveBeenCalled();
  });

  it('los roles que no son el dueño ven solo nombres y roles de los activos', async () => {
    const target = row();
    const prisma = {
      membership: {
        findMany: jest.fn().mockResolvedValue([target]),
        count: jest.fn().mockResolvedValue(1),
      },
    };
    const service = new TeamService(
      prisma as unknown as PrismaService,
      {} as AuditService,
      {} as MembershipsService,
      {} as InvitationsService,
    );
    const basic = await service.list(ORG, { limit: 20, offset: 0 }, 'BASIC');
    expect(prisma.membership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: ORG, status: 'ACTIVE' },
      }),
    );
    expect(basic.items[0].lastLoginAt).toBeNull();
    expect(basic.items[0]).not.toHaveProperty('accountStatus');
    const blocked = await service.list(
      ORG,
      { limit: 20, offset: 0, status: 'BLOCKED' },
      'BASIC',
    );
    expect(blocked.items).toEqual([]);
    const staff = await service.list(ORG, { limit: 20, offset: 0 }, 'PLATFORM');
    expect(staff.items[0]).toMatchObject({
      accountStatus: 'ACTIVE',
      lastLoginAt: '2026-09-20T00:00:00.000Z',
    });
  });
});
