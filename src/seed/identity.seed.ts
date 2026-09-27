import { createHmac } from 'crypto';
import {
  InvitationStatusEnum,
  MembershipRoleEnum,
  Prisma,
} from '@prisma/client';
import { PLATFORM_ORGANIZATION_ID } from '../modules/organizations/organization.constants';
import { hashOpaqueToken } from '../shared/security/opaque-token';
import { MockFixtures } from './fixtures';
import { DEMO_PLATFORM_ROLES } from './demo.seed';

/**
 * Invitaciones y segundo factor de demostración (Ola 1, `SEED_DEMO=true`).
 *
 * - Invitaciones de los mocks con sus ids, correos, roles y estados; las
 *   fechas se desplazan del día de referencia de los mocks a hoy, así las
 *   pendientes siguen vigentes. El token **no** es el legible de los mocks
 *   (`demo-invitacion-…`, público): es un HMAC con `SEED_DEMO_PASSWORD`, de modo
 *   que solo quien conoce esa contraseña (y lee el log de la semilla) puede
 *   aceptarlas en un servidor.
 * - TOTP del personal interno inscrito en los mocks con `SEED_DEMO_TOTP_SECRET`
 *   (cifrado como lo hace la API). Sin códigos de recuperación.
 */

export interface DemoInvitationLink {
  email: string;
  status: string;
  app: 'ERP' | 'BACKOFFICE' | 'POS';
  path: string;
}

export interface DemoIdentitySummary {
  invitations: number;
  links: DemoInvitationLink[];
  totpEnrolled: number;
}

/** Token de una invitación de demostración (determinista, secreto). */
export function demoInvitationToken(
  demoPassword: string,
  fixtureToken: string,
): string {
  return createHmac('sha256', demoPassword)
    .update(`invitation:${fixtureToken}`)
    .digest('base64url');
}

/** El reloj de los mocks empieza el día de referencia a las 12:00 UTC. */
function referenceInstant(fx: MockFixtures): number {
  return Date.parse(`${fx.source.referenceDay}T12:00:00Z`);
}

export async function seedDemoIdentity(
  tx: Prisma.TransactionClient,
  fx: MockFixtures,
  options: {
    demoPassword: string;
    encryptTotp: ((secret: string) => string) | null;
    totpSecret: string | null;
    now?: Date;
  },
): Promise<DemoIdentitySummary> {
  const now = options.now ?? new Date();
  const shift = now.getTime() - referenceInstant(fx);
  const moved = (iso: string | null) =>
    iso === null ? null : new Date(Date.parse(iso) + shift);

  // id de los fixtures → id en la base (por correo: puede diferir)
  const emails = fx.users.map((u) => u.email);
  const rows = await tx.user.findMany({
    where: { email: { in: emails } },
    select: { id: true, email: true },
  });
  const byEmail = new Map(rows.map((r) => [r.email, r.id]));
  const userId = (fixtureId: string): string | null => {
    const fixture = fx.users.find((u) => u.id === fixtureId);
    return fixture ? (byEmail.get(fixture.email) ?? null) : null;
  };
  const wineries = new Set(fx.wineries.map((w) => w.id));

  const links: DemoInvitationLink[] = [];
  let invitations = 0;
  for (const inv of fx.invitations) {
    const organizationId =
      inv.organizationType === 'PLATFORM'
        ? PLATFORM_ORGANIZATION_ID
        : inv.organizationId;
    if (inv.organizationType === 'WINERY' && !wineries.has(organizationId)) {
      continue;
    }
    if (inv.organizationType === 'PICKUP_POINT') {
      continue;
    }
    const token = demoInvitationToken(options.demoPassword, inv._mock.token);
    const data = {
      email: inv.email.toLowerCase(),
      organizationId,
      role: inv.role as MembershipRoleEnum,
      status: inv.status as InvitationStatusEnum,
      tokenHash: hashOpaqueToken(token),
      expiresAt: moved(inv.expiresAt)!,
      invitedByUserId: userId(inv.invitedBy.userId),
      invitedByName: inv.invitedBy.fullName,
      viaPlatform: inv.invitedBy.viaPlatform,
      inviteeName: inv._mock.inviteeName,
      purpose: inv.role === 'OWNER' ? 'OWNER_ONBOARDING' : 'MEMBER',
      acceptedAt: moved(inv._mock.acceptedAt),
      acceptedByUserId: inv._mock.acceptedAt
        ? (byEmail.get(inv.email.toLowerCase()) ?? null)
        : null,
      revokedAt: moved(inv._mock.revokedAt),
      lastSentAt: moved(inv.createdAt)!,
    };
    await tx.invitation.upsert({
      where: { id: inv.id },
      update: data,
      create: { id: inv.id, ...data, createdAt: moved(inv.createdAt)! },
    });
    invitations++;
    if (inv.status === 'PENDING' || inv.status === 'EXPIRED') {
      links.push({
        email: data.email,
        status: inv.status,
        app: inv.organizationType === 'PLATFORM' ? 'BACKOFFICE' : 'ERP',
        path: `/invitacion/${token}`,
      });
    }
  }

  let totpEnrolled = 0;
  if (options.totpSecret && options.encryptTotp) {
    for (const entry of fx.staffMfa) {
      const fixtureUser = fx.users.find((u) => u.id === entry.userId);
      const role = fixtureUser?._mock.platformRole;
      const id = userId(entry.userId);
      if (
        !entry.enrolled ||
        !id ||
        !(DEMO_PLATFORM_ROLES as readonly string[]).includes(role ?? '')
      ) {
        continue;
      }
      const secretEncrypted = options.encryptTotp(options.totpSecret);
      const enrolledAt = entry.enrolledAt ? new Date(entry.enrolledAt) : now;
      await tx.userMfa.upsert({
        where: { userId: id },
        create: { userId: id, secretEncrypted, enrolledAt },
        update: {
          secretEncrypted,
          enrolledAt,
          lastUsedStep: null,
          failedAttempts: 0,
          lockedUntil: null,
        },
      });
      await tx.mfaRecoveryCode.deleteMany({ where: { userId: id } });
      totpEnrolled++;
    }
  }

  return { invitations, links, totpEnrolled };
}
