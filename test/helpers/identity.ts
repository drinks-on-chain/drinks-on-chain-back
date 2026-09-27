import * as bcrypt from 'bcrypt';
import {
  MembershipRoleEnum,
  OrganizationStatusEnum,
  OrganizationTypeEnum,
  PrismaClient,
  UserRoleEnum,
} from '@prisma/client';
import { PLATFORM_ORGANIZATION_ID } from '../../src/modules/organizations/organization.constants';

type Db = Pick<
  PrismaClient,
  'user' | 'organization' | 'membership' | 'session' | '$transaction'
>;

/** Organización de plataforma (la crea la migración; se asegura por si acaso). */
export async function ensurePlatformOrganization(prisma: Db): Promise<void> {
  await prisma.organization.upsert({
    where: { id: PLATFORM_ORGANIZATION_ID },
    update: {},
    create: {
      id: PLATFORM_ORGANIZATION_ID,
      type: OrganizationTypeEnum.PLATFORM,
      name: 'Drinks on Chain',
      status: OrganizationStatusEnum.ACTIVE,
    },
  });
}

/**
 * Personal de plataforma como lo deja el seeder: cuenta + membresía de la
 * organización de plataforma con su rol (SUPERADMIN por defecto).
 */
export async function createPlatformUser(
  prisma: Db,
  params: {
    email: string;
    password: string;
    fullName?: string;
    role?: MembershipRoleEnum;
  },
) {
  await ensurePlatformOrganization(prisma);
  const user = await prisma.user.create({
    data: {
      email: params.email,
      passwordHash: await bcrypt.hash(params.password, 4),
      fullName: params.fullName ?? 'Personal de plataforma',
      userRole: UserRoleEnum.PLATFORM_ADMIN,
      isActive: true,
    },
  });
  await prisma.membership.create({
    data: {
      userId: user.id,
      organizationId: PLATFORM_ORGANIZATION_ID,
      role: params.role ?? MembershipRoleEnum.SUPERADMIN,
    },
  });
  return user;
}

/**
 * Borra sesiones, membresías y organizaciones de las personas (por correo) y
 * bodegas de una prueba. Va antes de borrar bodegas y usuarios: las claves
 * foráneas nuevas son RESTRICT (docs-back/03 §13).
 */
export async function deleteIdentityData(
  prisma: Db,
  scope: { emailContains?: string; wineryIds?: string[] },
): Promise<void> {
  const wineryIds = scope.wineryIds?.filter(Boolean) ?? [];
  const users = scope.emailContains
    ? await prisma.user.findMany({
        where: { email: { contains: scope.emailContains } },
        select: { id: true },
      })
    : [];
  const userIds = users.map((u) => u.id);

  await prisma.session.deleteMany({
    where: {
      OR: [
        { userId: { in: userIds } },
        { activeOrganizationId: { in: wineryIds } },
      ],
    },
  });
  await prisma.membership.deleteMany({
    where: {
      OR: [{ userId: { in: userIds } }, { organizationId: { in: wineryIds } }],
    },
  });
  await prisma.user.updateMany({
    where: { lastOrganizationId: { in: wineryIds } },
    data: { lastOrganizationId: null },
  });
  await prisma.organization.deleteMany({
    where: { id: { in: wineryIds }, type: OrganizationTypeEnum.WINERY },
  });
}
