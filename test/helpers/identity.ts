import * as bcrypt from 'bcrypt';
import {
  MembershipRoleEnum,
  OrganizationStatusEnum,
  OrganizationTypeEnum,
  PrismaClient,
} from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import * as request from 'supertest';
import { PLATFORM_ORGANIZATION_ID } from '../../src/modules/organizations/organization.constants';
import { MfaCrypto } from '../../src/modules/auth/mfa/mfa-crypto';
import { currentTotp } from '../../src/modules/auth/mfa/totp';

type Db = Pick<
  PrismaClient,
  | 'user'
  | 'organization'
  | 'membership'
  | 'session'
  | 'invitation'
  | 'userMfa'
  | '$transaction'
>;

/** Secreto TOTP de las pruebas (base32, 20 bytes). */
export const TEST_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

/** Cifrado de los secretos TOTP con la configuración del entorno de la prueba. */
export function testMfaCrypto(): MfaCrypto {
  return new MfaCrypto(
    new ConfigService({
      JWT_SECRET: process.env.JWT_SECRET,
      MFA_ENCRYPTION_KEY: process.env.MFA_ENCRYPTION_KEY,
    }),
  );
}

/** Inscribe un secreto TOTP conocido (como la semilla de demostración). */
export async function enrollTotp(
  prisma: Pick<PrismaClient, 'userMfa'>,
  userId: string,
  secret = TEST_TOTP_SECRET,
): Promise<void> {
  const secretEncrypted = testMfaCrypto().encrypt(secret);
  await prisma.userMfa.upsert({
    where: { userId },
    create: { userId, secretEncrypted, enrolledAt: new Date() },
    update: {
      secretEncrypted,
      enrolledAt: new Date(),
      lastUsedStep: null,
      failedAttempts: 0,
      lockedUntil: null,
    },
  });
}

/**
 * Inicio de sesión que, si el backend pide el segundo factor (personal de
 * plataforma), lo supera con el código actual del secreto de prueba. Olvida
 * el último paso usado para poder entrar varias veces en el mismo medio
 * minuto. Devuelve la respuesta de la sesión (la del login o la de
 * `mfa/verify`).
 */
export async function loginWithMfa(
  http: () => ReturnType<typeof request>,
  prisma: Pick<PrismaClient, 'user' | 'userMfa'>,
  credentials: { email: string; password: string },
  options: { ip?: string; secret?: string } = {},
): Promise<request.Response> {
  const withIp = (req: request.Test) =>
    options.ip ? req.set('X-Forwarded-For', options.ip) : req;
  const login = await withIp(http().post('/v1/auth/login')).send(credentials);
  if (login.status !== 200 || !login.body?.data?.mfa) {
    return login;
  }
  const user = await prisma.user.findUniqueOrThrow({
    where: { email: credentials.email.toLowerCase() },
  });
  await prisma.userMfa.updateMany({
    where: { userId: user.id },
    data: { lastUsedStep: null },
  });
  return withIp(http().post('/v1/auth/mfa/verify')).send({
    mfaToken: login.body.data.mfa.mfaToken,
    code: currentTotp(options.secret ?? TEST_TOTP_SECRET),
  });
}

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
    /** Secreto TOTP inscrito (por defecto el de prueba; null = sin inscribir). */
    totpSecret?: string | null;
  },
) {
  await ensurePlatformOrganization(prisma);
  const user = await prisma.user.create({
    data: {
      email: params.email,
      passwordHash: await bcrypt.hash(params.password, 4),
      fullName: params.fullName ?? 'Personal de plataforma',
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
  if (params.totpSecret !== null) {
    await enrollTotp(prisma, user.id, params.totpSecret ?? TEST_TOTP_SECRET);
  }
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

  await prisma.invitation.deleteMany({
    where: {
      OR: [
        { organizationId: { in: wineryIds } },
        ...(scope.emailContains
          ? [{ email: { contains: scope.emailContains } }]
          : []),
      ],
    },
  });
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
