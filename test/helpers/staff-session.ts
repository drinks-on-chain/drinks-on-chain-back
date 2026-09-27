import type { INestApplication } from '@nestjs/common';
import {
  AudienceEnum,
  MembershipRoleEnum,
  OrganizationStatusEnum,
  OrganizationTypeEnum,
  UserRoleEnum,
  WineryCategoryEnum,
  WineryStatusEnum,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { SessionsService } from '../../src/modules/auth/sessions/sessions.service';
import { AccessTokenService } from '../../src/modules/auth/sessions/access-token.service';
import { PrismaService } from '../../src/shared/prisma/prisma.service';
import { PLATFORM_ORGANIZATION_ID } from '../../src/modules/organizations/organization.constants';
import { ensurePlatformOrganization } from './identity';

/**
 * Sesiones de prueba sin pasar por el login (que para el personal de
 * plataforma pide el segundo factor desde la Ola 1): abre la sesión en la
 * base y firma el acceso con los mismos claims que el login.
 */
export async function staffToken(
  app: INestApplication,
  params: {
    userId: string;
    email: string;
    organizationId: string;
    organizationType: 'PLATFORM' | 'WINERY';
    role: MembershipRoleEnum;
  },
): Promise<string> {
  const { session } = await app.get(SessionsService).create({
    userId: params.userId,
    audience: AudienceEnum.STAFF,
    activeOrganizationId: params.organizationId,
    client: { ip: '127.0.0.1', userAgent: 'e2e' },
    // Una sesión de plataforma exige el segundo factor (PLT-05)
    mfaVerified: params.organizationType === 'PLATFORM',
  });
  const winery = params.organizationType === 'WINERY';
  return app.get(AccessTokenService).sign({
    sub: params.userId,
    aud: 'STAFF',
    org: params.organizationId,
    orgType: params.organizationType,
    role: params.role,
    sid: session.id,
    email: params.email,
    userRole: winery ? UserRoleEnum.WINERY_ADMIN : UserRoleEnum.PLATFORM_ADMIN,
    wineryId: winery ? params.organizationId : null,
    memberRole: winery ? params.role : null,
  });
}

/** Cuenta con membresía en una organización (sin contraseña utilizable). */
export async function createMember(
  prisma: PrismaService,
  params: {
    email: string;
    fullName: string;
    organizationId: string;
    role: MembershipRoleEnum;
  },
) {
  const user = await prisma.user.create({
    data: {
      email: params.email,
      passwordHash: 'e2e-sin-login',
      fullName: params.fullName,
      userRole:
        params.organizationId === PLATFORM_ORGANIZATION_ID
          ? UserRoleEnum.PLATFORM_ADMIN
          : UserRoleEnum.WINERY_ADMIN,
    },
  });
  const membership = await prisma.membership.create({
    data: {
      userId: user.id,
      organizationId: params.organizationId,
      role: params.role,
    },
  });
  return { user, membership };
}

/** Personal de plataforma con su token. */
export async function platformStaff(
  app: INestApplication,
  prisma: PrismaService,
  params: { email: string; fullName: string; role: MembershipRoleEnum },
) {
  await ensurePlatformOrganization(prisma);
  const { user, membership } = await createMember(prisma, {
    ...params,
    organizationId: PLATFORM_ORGANIZATION_ID,
  });
  const token = await staffToken(app, {
    userId: user.id,
    email: user.email,
    organizationId: PLATFORM_ORGANIZATION_ID,
    organizationType: 'PLATFORM',
    role: params.role,
  });
  return { user, membership, token };
}

/** Bodega activa con su organización (mismo id). */
export async function createActiveWinery(
  prisma: PrismaService,
  params: { name: string; taxId: string; status?: WineryStatusEnum },
) {
  const id = randomUUID();
  const status = params.status ?? WineryStatusEnum.ACTIVE;
  await prisma.winery.create({
    data: {
      id,
      legalName: `${params.name} S.R.L.`,
      commercialName: params.name,
      beverageCategory: WineryCategoryEnum.WINERY,
      taxIdNit: params.taxId,
      geographicRegion: 'Tarija',
      contactEmail: `contacto+${id.slice(0, 8)}@test.bo`,
      certificationStatus: status,
    },
  });
  await prisma.organization.create({
    data: {
      id,
      type: OrganizationTypeEnum.WINERY,
      name: params.name,
      status: status as unknown as OrganizationStatusEnum,
      wineryId: id,
    },
  });
  return id;
}
