import { PrismaService } from '@shared/prisma/prisma.service';
import { SessionsService } from '@modules/auth/sessions/sessions.service';
import {
  MembershipsService,
  MembershipView,
  isUsableMembership,
  pickActiveOrganizationId,
} from '../memberships.service';

const view = (overrides: Partial<MembershipView>): MembershipView => ({
  id: 'm',
  organizationId: 'org',
  organizationType: 'WINERY',
  organizationName: 'Bodega',
  organizationStatus: 'ACTIVE',
  role: 'OWNER',
  status: 'ACTIVE',
  ...overrides,
});

describe('Organización activa por defecto (contrato O0 §5)', () => {
  const platform = view({
    id: 'p',
    organizationId: 'platform',
    organizationType: 'PLATFORM',
    role: 'SUPERADMIN',
  });
  const wineryA = view({ id: 'a', organizationId: 'winery-a' });
  const wineryB = view({ id: 'b', organizationId: 'winery-b' });

  it('la última usada si sigue siendo utilizable', () => {
    expect(
      pickActiveOrganizationId([platform, wineryA, wineryB], 'winery-b'),
    ).toBe('winery-b');
  });

  it('si no, la primera utilizable (la lista ya viene con la plataforma delante)', () => {
    expect(pickActiveOrganizationId([platform, wineryA], null)).toBe(
      'platform',
    );
    expect(pickActiveOrganizationId([wineryA, wineryB])).toBe('winery-a');
  });

  it('salta membresías bloqueadas y organizaciones revocadas', () => {
    const blocked = { ...wineryA, status: 'BLOCKED' as const };
    const revoked = { ...wineryB, organizationStatus: 'REVOKED' as const };
    expect(isUsableMembership(blocked)).toBe(false);
    expect(isUsableMembership(revoked)).toBe(false);
    expect(
      isUsableMembership({ ...wineryA, organizationStatus: 'INVITED' }),
    ).toBe(true);
    expect(pickActiveOrganizationId([blocked, revoked], 'winery-a')).toBeNull();
    expect(
      pickActiveOrganizationId([blocked, revoked, platform], 'winery-a'),
    ).toBe('platform');
  });

  it('null sin membresías (consumidor)', () => {
    expect(pickActiveOrganizationId([], 'winery-a')).toBeNull();
  });
});

describe('MembershipsService', () => {
  const tx = {
    membership: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    wineryMember: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  const prisma = {
    membership: { findMany: jest.fn(), findUnique: jest.fn() },
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const sessions = { revokeForOrganization: jest.fn().mockResolvedValue(1) };
  let service: MembershipsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new MembershipsService(
      prisma as unknown as PrismaService,
      sessions as unknown as SessionsService,
    );
    tx.wineryMember.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: data.id ?? 'new-member', ...data }),
    );
    tx.wineryMember.update.mockImplementation(({ where, data }) =>
      Promise.resolve({ id: where.id, ...data }),
    );
  });

  it('listForUser ordena plataforma antes que bodega', async () => {
    const org = (type: string, name: string) => ({
      type,
      name,
      status: 'ACTIVE',
    });
    prisma.membership.findMany.mockResolvedValue([
      {
        id: 'w',
        organizationId: 'winery',
        role: 'OWNER',
        status: 'ACTIVE',
        organization: org('WINERY', 'Bodega'),
      },
      {
        id: 'p',
        organizationId: 'platform',
        role: 'ADMIN',
        status: 'ACTIVE',
        organization: org('PLATFORM', 'Drinks on Chain'),
      },
    ]);

    const list = await service.listForUser('user-1');

    expect(list.map((m) => m.organizationType)).toEqual(['PLATFORM', 'WINERY']);
    expect(list[1]).toEqual({
      id: 'w',
      organizationId: 'winery',
      organizationType: 'WINERY',
      organizationName: 'Bodega',
      organizationStatus: 'ACTIVE',
      role: 'OWNER',
      status: 'ACTIVE',
    });
  });

  describe('addToWinery (SE-01)', () => {
    const params = {
      wineryId: 'winery-a',
      userId: 'user-1',
      role: 'ENOLOGIST' as const,
    };

    it('crea la membresía de esta bodega con el mismo id que winery_members', async () => {
      tx.membership.findUnique.mockResolvedValue(null);
      tx.wineryMember.findUnique.mockResolvedValue(null);

      const member = await service.addToWinery(tx as never, params);

      expect(member.id).toBe('new-member');
      expect(tx.membership.create).toHaveBeenCalledWith({
        data: {
          id: 'new-member',
          userId: 'user-1',
          organizationId: 'winery-a',
          role: 'ENOLOGIST',
          status: 'ACTIVE',
        },
      });
      // Solo la organización de la bodega: ninguna otra escritura
      expect(tx.membership.update).not.toHaveBeenCalled();
    });

    it('ya es miembro activo → 409 ORG_ALREADY_MEMBER', async () => {
      tx.membership.findUnique.mockResolvedValue({
        id: 'm1',
        status: 'ACTIVE',
      });
      tx.wineryMember.findUnique.mockResolvedValue({ id: 'm1' });

      await expect(
        service.addToWinery(tx as never, params),
      ).rejects.toMatchObject({
        statusCode: 409,
        errorCode: 'ORG_ALREADY_MEMBER',
      });
      expect(tx.membership.create).not.toHaveBeenCalled();
    });

    it('bloqueada por el dueño → se reactiva con el rol nuevo', async () => {
      tx.membership.findUnique.mockResolvedValue({
        id: 'm1',
        status: 'BLOCKED',
        blockedBy: 'OWNER',
      });
      tx.wineryMember.findUnique.mockResolvedValue({ id: 'm1' });

      await service.addToWinery(tx as never, params);

      expect(tx.membership.update).toHaveBeenCalledWith({
        where: { id: 'm1' },
        data: expect.objectContaining({
          role: 'ENOLOGIST',
          status: 'ACTIVE',
          blockedBy: null,
        }),
      });
      expect(tx.wineryMember.update).toHaveBeenCalledWith({
        where: { id: 'm1' },
        data: expect.objectContaining({ isActive: true }),
      });
    });

    it('bloqueada por la plataforma → 403 ORG_BLOCKED_BY_PLATFORM', async () => {
      tx.membership.findUnique.mockResolvedValue({
        id: 'm1',
        status: 'BLOCKED',
        blockedBy: 'PLATFORM',
      });
      tx.wineryMember.findUnique.mockResolvedValue({ id: 'm1' });

      await expect(
        service.addToWinery(tx as never, params),
      ).rejects.toMatchObject({ errorCode: 'ORG_BLOCKED_BY_PLATFORM' });
    });
  });

  it('block marca BLOCKED y revoca las sesiones con esa organización activa (IAM-13)', async () => {
    tx.membership.update = jest.fn().mockResolvedValue({
      id: 'm1',
      userId: 'user-1',
      organizationId: 'winery-a',
    });

    await service.block('m1', { by: 'OWNER', reason: 'Fin de contrato' });

    expect(tx.membership.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: expect.objectContaining({
        status: 'BLOCKED',
        blockedBy: 'OWNER',
        blockedReason: 'Fin de contrato',
      }),
    });
    expect(tx.wineryMember.updateMany).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { isActive: false },
    });
    expect(sessions.revokeForOrganization).toHaveBeenCalledWith(
      'winery-a',
      'MEMBERSHIP_BLOCKED',
      'user-1',
    );
  });
});
