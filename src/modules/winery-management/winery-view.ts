import {
  InvitationStatusEnum,
  MembershipRoleEnum,
  MembershipStatusEnum,
  Prisma,
} from '@prisma/client';
import { slugify } from '@modules/wineries/winery-identity';
import {
  PublicWineryProfileDto,
  WineryDetailDto,
  WineryOwnerDto,
  WinerySummaryDto,
} from './dto/winery.dto';

/** Relaciones que necesita el resumen del directorio. */
export const WINERY_SUMMARY_INCLUDE = {
  organization: {
    include: {
      memberships: {
        where: { role: MembershipRoleEnum.OWNER },
        include: {
          user: { select: { id: true, fullName: true, email: true } },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      },
      invitations: {
        where: {
          role: MembershipRoleEnum.OWNER,
          purpose: 'OWNER_ONBOARDING',
          status: {
            in: [InvitationStatusEnum.PENDING, InvitationStatusEnum.EXPIRED],
          },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: 1,
      },
      _count: {
        select: {
          memberships: { where: { status: MembershipStatusEnum.ACTIVE } },
        },
      },
    },
  },
} satisfies Prisma.WineryInclude;

/** Además, el historial de estados (ficha). */
export const WINERY_DETAIL_INCLUDE = {
  ...WINERY_SUMMARY_INCLUDE,
  statusChanges: { orderBy: [{ changedAt: 'asc' }, { id: 'asc' }] },
} satisfies Prisma.WineryInclude;

export type WineryWithSummary = Prisma.WineryGetPayload<{
  include: typeof WINERY_SUMMARY_INCLUDE;
}>;
export type WineryWithDetail = Prisma.WineryGetPayload<{
  include: typeof WINERY_DETAIL_INCLUDE;
}>;

/**
 * Dueño de la ficha: el miembro `OWNER` activo; si no hay, la persona de la
 * invitación de alta pendiente (sin cuenta aún: `userId: null`); si no, el
 * último `OWNER` aunque esté bloqueado.
 */
export function ownerOf(winery: WineryWithSummary): WineryOwnerDto | null {
  const memberships = winery.organization?.memberships ?? [];
  const active = memberships.find(
    (m) => m.status === MembershipStatusEnum.ACTIVE,
  );
  if (active) {
    return {
      userId: active.user.id,
      fullName: active.user.fullName,
      email: active.user.email,
    };
  }
  const invited = winery.organization?.invitations[0];
  if (invited) {
    return {
      userId: null,
      fullName: invited.inviteeName ?? invited.email,
      email: invited.email,
    };
  }
  const any = memberships[memberships.length - 1];
  return any
    ? {
        userId: any.user.id,
        fullName: any.user.fullName,
        email: any.user.email,
      }
    : null;
}

export function toWinerySummary(winery: WineryWithSummary): WinerySummaryDto {
  return {
    id: winery.id,
    slug: winery.slug ?? slugify(winery.commercialName),
    legalName: winery.legalName,
    tradeName: winery.commercialName,
    taxId: winery.taxIdNit,
    category: winery.beverageCategory,
    region: winery.geographicRegion,
    status: winery.certificationStatus,
    lotPrefix: winery.lotPrefix,
    owner: ownerOf(winery),
    membersCount: winery.organization?._count.memberships ?? 0,
    createdAt: winery.createdAt.toISOString(),
    activatedAt: winery.activatedAt?.toISOString() ?? null,
  };
}

export function toWineryDetail(winery: WineryWithDetail): WineryDetailDto {
  return {
    ...toWinerySummary(winery),
    address: winery.address,
    senasagRegistration: winery.senasagSanitaryReg,
    contactEmail: winery.contactEmail,
    contactPhone: winery.contactPhone,
    logoUrl: winery.logoUrl,
    publicStory: winery.publicStory,
    website: winery.website,
    statusHistory: winery.statusChanges.map((c) => ({
      status: c.status,
      at: c.changedAt.toISOString(),
      by: c.byName,
      reason: c.reason,
    })),
  };
}

export function toPublicProfile(
  winery: Pick<
    WineryWithSummary,
    | 'slug'
    | 'commercialName'
    | 'geographicRegion'
    | 'beverageCategory'
    | 'logoUrl'
    | 'publicStory'
    | 'website'
  >,
): PublicWineryProfileDto {
  return {
    slug: winery.slug ?? slugify(winery.commercialName),
    tradeName: winery.commercialName,
    region: winery.geographicRegion,
    category: winery.beverageCategory,
    logoUrl: winery.logoUrl,
    publicStory: winery.publicStory,
    website: winery.website,
  };
}
