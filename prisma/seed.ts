import {
  MembershipRoleEnum,
  MembershipStatusEnum,
  OrganizationStatusEnum,
  OrganizationTypeEnum,
  PrismaClient,
  UserRoleEnum,
  WalletPurposeEnum,
  WalletTypeEnum,
} from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { Keypair } from '@stellar/stellar-sdk';
import { v4 as uuidv4 } from 'uuid';
import * as dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();

/** Mismo id que src/modules/organizations/organization.constants.ts y la migración. */
const PLATFORM_ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001';

async function main() {
  const superadminEmail = (
    process.env.SUPERADMIN_EMAIL || 'admin.master@drinksonchain.bo'
  )
    .toLowerCase()
    .trim();
  const superadminPassword = process.env.SUPERADMIN_PASSWORD || 'Password123!';
  const superadminName =
    process.env.SUPERADMIN_NAME || 'Platform Super Administrator';

  console.log(`🌱 Iniciando Seeder de Drinks on Chain...`);
  console.log(`👤 Configurando Superadministrador (${superadminEmail})...`);

  const passwordHash = await bcrypt.hash(superadminPassword, 12);

  // Upsert idempotente de Superadmin
  const superadmin = await prisma.user.upsert({
    where: { email: superadminEmail },
    update: {
      fullName: superadminName,
      userRole: UserRoleEnum.PLATFORM_ADMIN,
      isActive: true,
      passwordHash,
    },
    create: {
      email: superadminEmail,
      fullName: superadminName,
      userRole: UserRoleEnum.PLATFORM_ADMIN,
      passwordHash,
      isActive: true,
      preferredLocale: 'es',
    },
  });

  console.log(`✅ Superadministrador configurado con ID: ${superadmin.id}`);

  // Organización de plataforma (la crea también la migración) y membresía
  // SUPERADMIN del superadministrador (contrato O0 §4)
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
  await prisma.membership.upsert({
    where: {
      userId_organizationId: {
        userId: superadmin.id,
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
      userId: superadmin.id,
      organizationId: PLATFORM_ORGANIZATION_ID,
      role: MembershipRoleEnum.SUPERADMIN,
    },
  });
  console.log(`🏛️  Membresía SUPERADMIN en la organización de plataforma`);

  // Verificar si ya tiene billetera custodial
  const existingWallet = await prisma.userWallet.findFirst({
    where: { userId: superadmin.id },
  });

  if (!existingWallet) {
    const randomKeypair = Keypair.random();
    const vaultId = `dyn_vault_${uuidv4()}`;

    await prisma.userWallet.create({
      data: {
        userId: superadmin.id,
        stellarPublicAddress: randomKeypair.publicKey(),
        dynamicVaultId: vaultId,
        walletType: WalletTypeEnum.CUSTODIAL,
        walletPurpose: WalletPurposeEnum.CONSUMER_NFT,
        isPrimary: true,
      },
    });

    console.log(
      `💳 Billetera custodial aprovisionada para Superadmin: ${randomKeypair.publicKey()}`,
    );
  } else {
    console.log(
      `💳 Billetera custodial ya existente: ${existingWallet.stellarPublicAddress}`,
    );
  }

  console.log(`🎉 Seeding completado exitosamente.`);
}

main()
  .catch((e) => {
    console.error('❌ Error durante la ejecución del seeder:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
