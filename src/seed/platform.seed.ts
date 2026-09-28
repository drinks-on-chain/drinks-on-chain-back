import {
  MembershipRoleEnum,
  MembershipStatusEnum,
  OrganizationStatusEnum,
  OrganizationTypeEnum,
  PrismaClient,
  WalletPurposeEnum,
  WalletTypeEnum,
} from '@prisma/client';
import { Keypair } from '@stellar/stellar-sdk';
import { v4 as uuidv4 } from 'uuid';
import {
  PLATFORM_ORGANIZATION_ID,
  PLATFORM_ORGANIZATION_NAME,
} from '../modules/organizations/organization.constants';
import { SeedSuperadmin } from './seed.options';

type Db = Pick<
  PrismaClient,
  'organization' | 'user' | 'membership' | 'userWallet'
>;

/** Organización de plataforma (la crea también la migración). */
export async function ensurePlatformOrganization(db: Db): Promise<void> {
  await db.organization.upsert({
    where: { id: PLATFORM_ORGANIZATION_ID },
    update: {},
    create: {
      id: PLATFORM_ORGANIZATION_ID,
      type: OrganizationTypeEnum.PLATFORM,
      name: PLATFORM_ORGANIZATION_NAME,
      status: OrganizationStatusEnum.ACTIVE,
    },
  });
}

/**
 * Superusuario desde el entorno: cuenta (la contraseña es siempre la de
 * `SUPERADMIN_PASSWORD`), membresía `SUPERADMIN` activa en la organización de
 * plataforma (contrato O0 §4) y billetera custodial si no tiene ninguna.
 */
export async function upsertSuperadmin(
  db: Db,
  superadmin: SeedSuperadmin,
  passwordHash: string,
): Promise<{ id: string; created: boolean }> {
  const existing = await db.user.findUnique({
    where: { email: superadmin.email },
    select: { id: true },
  });
  const user = await db.user.upsert({
    where: { email: superadmin.email },
    update: { fullName: superadmin.fullName, passwordHash, isActive: true },
    create: {
      email: superadmin.email,
      fullName: superadmin.fullName,
      passwordHash,
      isActive: true,
      preferredLocale: 'es',
    },
  });

  await db.membership.upsert({
    where: {
      userId_organizationId: {
        userId: user.id,
        organizationId: PLATFORM_ORGANIZATION_ID,
      },
    },
    update: {
      role: MembershipRoleEnum.SUPERADMIN,
      status: MembershipStatusEnum.ACTIVE,
      blockedBy: null,
      blockedReason: null,
      blockedAt: null,
    },
    create: {
      userId: user.id,
      organizationId: PLATFORM_ORGANIZATION_ID,
      role: MembershipRoleEnum.SUPERADMIN,
    },
  });

  const wallet = await db.userWallet.findFirst({ where: { userId: user.id } });
  if (!wallet) {
    await db.userWallet.create({
      data: {
        userId: user.id,
        stellarPublicAddress: Keypair.random().publicKey(),
        dynamicVaultId: `dyn_vault_${uuidv4()}`,
        walletType: WalletTypeEnum.CUSTODIAL,
        walletPurpose: WalletPurposeEnum.CONSUMER_NFT,
        isPrimary: true,
      },
    });
  }

  return { id: user.id, created: !existing };
}
