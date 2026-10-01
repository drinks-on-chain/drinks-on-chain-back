import type { INestApplication } from '@nestjs/common';
import {
  AudienceEnum,
  MembershipRoleEnum,
  OrganizationStatusEnum,
  OrganizationTypeEnum,
  WineryCategoryEnum,
  WineryMemberRoleEnum,
  WineryStatusEnum,
} from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import { MembershipsService } from '../../src/modules/organizations/memberships.service';
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
  return app.get(AccessTokenService).sign({
    sub: params.userId,
    aud: 'STAFF',
    org: params.organizationId,
    orgType: params.organizationType,
    role: params.role,
    sid: session.id,
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
  params: {
    name: string;
    taxId: string;
    status?: WineryStatusEnum;
    category?: WineryCategoryEnum;
    region?: string;
  },
) {
  const id = randomUUID();
  const status = params.status ?? WineryStatusEnum.ACTIVE;
  await prisma.winery.create({
    data: {
      id,
      legalName: `${params.name} S.R.L.`,
      commercialName: params.name,
      beverageCategory: params.category ?? WineryCategoryEnum.WINERY,
      taxIdNit: params.taxId,
      geographicRegion: params.region ?? 'Tarija',
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

/**
 * Persona con contraseña en una bodega, como la deja aceptar una invitación
 * (desde H1 no hay autoinscripción ni `my/members`): cuenta nueva (o la de
 * `userId`), membresía y su espejo en `winery_members` (mismo id, autoría de
 * la trazabilidad). Devuelve el id de la persona y el de la membresía.
 */
export async function addWineryMember(
  app: INestApplication,
  params: {
    wineryId: string;
    role: WineryMemberRoleEnum | `${WineryMemberRoleEnum}`;
    professionalLicenseNumber?: string;
    /** Persona existente; si falta, se crea con `email`, `password` y `fullName`. */
    userId?: string;
    email?: string;
    password?: string;
    fullName?: string;
  },
): Promise<{ userId: string; membershipId: string }> {
  const prisma = app.get(PrismaService);
  let userId = params.userId;
  if (!userId) {
    const user = await prisma.user.create({
      data: {
        email: params.email!.toLowerCase(),
        passwordHash: await bcrypt.hash(params.password ?? 'e2e-sin-login', 4),
        fullName: params.fullName ?? 'Miembro e2e',
        emailVerifiedAt: new Date(),
      },
    });
    userId = user.id;
  }
  const member = await prisma.$transaction((tx) =>
    app.get(MembershipsService).addToWinery(tx, {
      wineryId: params.wineryId,
      userId: userId!,
      role: params.role as WineryMemberRoleEnum,
      professionalLicenseNumber: params.professionalLicenseNumber,
    }),
  );
  return { userId, membershipId: member.id };
}

/**
 * Bodega `ACTIVE` (o en `status`) con su dueña, que puede iniciar sesión con
 * `password`: el estado que dejaban `signup` + `POST /wineries` + `approve`
 * antes de H1 (ahora solicitud o alta directa + invitación aceptada).
 */
export async function wineryWithOwner(
  app: INestApplication,
  params: {
    name: string;
    taxId?: string;
    email: string;
    password: string;
    fullName?: string;
    status?: WineryStatusEnum;
    category?: WineryCategoryEnum;
    region?: string;
  },
): Promise<{ wineryId: string; ownerId: string; membershipId: string }> {
  const prisma = app.get(PrismaService);
  const wineryId = await createActiveWinery(prisma, {
    name: params.name,
    taxId:
      params.taxId ??
      `${Date.now()}${Math.floor(Math.random() * 1e4)}`.slice(-15),
    status: params.status,
    category: params.category,
    region: params.region,
  });
  const { userId, membershipId } = await addWineryMember(app, {
    wineryId,
    role: WineryMemberRoleEnum.OWNER,
    email: params.email,
    password: params.password,
    fullName: params.fullName ?? `Dueña ${params.name}`,
  });
  return { wineryId, ownerId: userId, membershipId };
}
