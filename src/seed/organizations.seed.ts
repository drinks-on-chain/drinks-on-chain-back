import { createHmac } from 'crypto';
import {
  MeetingChannelEnum,
  Prisma,
  WineryApplicationStatusEnum,
  WineryCategoryEnum,
  WineryStatusEnum,
} from '@prisma/client';
import { hashOpaqueToken } from '../shared/security/opaque-token';
import { MockFixtures } from './fixtures';

/**
 * Solicitudes de alta y perfil de la Ola 1 de las bodegas de demostración
 * (`SEED_DEMO=true`; contrato O1 §3–§4):
 *
 * - Bodegas: `slug`, prefijo de lote (`ALT`, `CVJ`, `CUR`, `VES`, como en sus
 *   códigos de lote), historia pública, web, fecha de activación e historial
 *   de estados de los mocks. Si otra bodega (no de demostración) ya tiene ese
 *   `slug` o prefijo, se conserva el suyo y se avisa.
 * - Solicitudes en todos los estados, con sus notas, reunión y decisión; las
 *   fechas se desplazan del día de referencia de los mocks a hoy (como las
 *   invitaciones). La sin verificar lleva un enlace secreto (HMAC con
 *   `SEED_DEMO_PASSWORD`, nunca el token legible de los mocks) que se escribe
 *   en el log de la semilla.
 */

export interface DemoApplicationLink {
  email: string;
  path: string;
}

export interface DemoOrganizationsSummary {
  applications: number;
  applicationNotes: number;
  profiles: number;
  statusChanges: number;
  links: DemoApplicationLink[];
  warnings: string[];
}

/** Vida del enlace de verificación de la solicitud de demostración. */
const DEMO_VERIFY_TTL_HOURS = 72;

/** Token de verificación de una solicitud de demostración (determinista, secreto). */
export function demoApplicationToken(
  demoPassword: string,
  fixtureToken: string,
): string {
  return createHmac('sha256', demoPassword)
    .update(`application:${fixtureToken}`)
    .digest('base64url');
}

function referenceInstant(fx: MockFixtures): number {
  return Date.parse(`${fx.source.referenceDay}T12:00:00Z`);
}

export async function seedDemoOrganizations(
  tx: Prisma.TransactionClient,
  fx: MockFixtures,
  options: { demoPassword: string; now?: Date },
): Promise<DemoOrganizationsSummary> {
  const now = options.now ?? new Date();
  const shift = now.getTime() - referenceInstant(fx);
  const moved = (iso: string) => new Date(Date.parse(iso) + shift);
  const warnings: string[] = [];

  // id de las personas de los fixtures → id en la base (por correo)
  const rows = await tx.user.findMany({
    where: { email: { in: fx.users.map((u) => u.email) } },
    select: { id: true, email: true },
  });
  const byEmail = new Map(rows.map((r) => [r.email, r.id]));
  const userId = (fixtureId: string | null | undefined): string | null => {
    if (!fixtureId) return null;
    const fixture = fx.users.find((u) => u.id === fixtureId);
    return fixture ? (byEmail.get(fixture.email) ?? null) : null;
  };
  const userIdByName = (fullName: string): string | null => {
    const fixture = fx.users.find((u) => u.fullName === fullName);
    return fixture ? (byEmail.get(fixture.email) ?? null) : null;
  };

  // ── Perfil de las bodegas ────────────────────────────────────────────────
  const wineries = new Set(fx.wineries.map((w) => w.id));
  let profiles = 0;
  let statusChanges = 0;
  for (const p of fx.wineryProfiles) {
    if (!wineries.has(p.wineryId)) continue;
    const clash = async (field: 'slug' | 'lotPrefix', value: string | null) =>
      value !== null &&
      (await tx.winery.findFirst({
        where: { [field]: value, id: { not: p.wineryId } },
        select: { id: true },
      })) !== null;
    const data: Prisma.WineryUpdateInput = {
      publicStory: p.publicStory,
      website: p.website,
      activatedAt: p.activatedAt ? new Date(p.activatedAt) : null,
    };
    if (await clash('slug', p.slug)) {
      warnings.push(`slug ${p.slug} ya usado por otra bodega`);
    } else {
      data.slug = p.slug;
    }
    if (await clash('lotPrefix', p.lotPrefix)) {
      warnings.push(`prefijo ${p.lotPrefix} ya usado por otra bodega`);
    } else {
      data.lotPrefix = p.lotPrefix;
    }
    await tx.winery.update({ where: { id: p.wineryId }, data });
    await tx.wineryStatusChange.deleteMany({ where: { wineryId: p.wineryId } });
    await tx.wineryStatusChange.createMany({
      data: p.statusHistory.map((h) => ({
        wineryId: p.wineryId,
        status: h.status as WineryStatusEnum,
        changedAt: new Date(h.at),
        byUserId: h.by === 'Sistema' ? null : userIdByName(h.by),
        byName: h.by,
        reason: h.reason,
      })),
    });
    statusChanges += p.statusHistory.length;
    profiles++;
  }

  // ── Solicitudes de alta ──────────────────────────────────────────────────
  const links: DemoApplicationLink[] = [];
  let applicationNotes = 0;
  for (const a of fx.applications) {
    const wineryId = a.wineryId && wineries.has(a.wineryId) ? a.wineryId : null;
    const verifyToken = a._mock.verifyToken
      ? demoApplicationToken(options.demoPassword, a._mock.verifyToken)
      : null;
    const data = {
      status: a.status as WineryApplicationStatusEnum,
      legalName: a.legalName,
      tradeName: a.tradeName,
      taxId: a.taxId,
      category: a.category as WineryCategoryEnum,
      region: a.region,
      contactName: a.contactName,
      contactEmail: a.contactEmail.toLowerCase(),
      contactPhone: a.contactPhone,
      message: a.message,
      verifyTokenHash: verifyToken ? hashOpaqueToken(verifyToken) : null,
      verifyExpiresAt: verifyToken
        ? new Date(now.getTime() + DEMO_VERIFY_TTL_HOURS * 3_600_000)
        : null,
      verifiedAt:
        a.status === WineryApplicationStatusEnum.UNVERIFIED
          ? null
          : moved(a.createdAt),
      assigneeUserId: userId(a.assignee?.userId),
      assigneeName: a.assignee?.fullName ?? null,
      meetingScheduledAt: a.meeting ? moved(a.meeting.scheduledAt) : null,
      meetingChannel: (a.meeting?.channel as MeetingChannelEnum) ?? null,
      meetingNotes: a.meeting?.notes ?? null,
      decisionByUserId: a.decision ? userIdByName(a.decision.by) : null,
      decisionByName: a.decision?.by ?? null,
      decidedAt: a.decision ? moved(a.decision.at) : null,
      decisionReason: a.decision?.reason ?? null,
      wineryId,
      updatedAt: moved(a.updatedAt),
    };
    await tx.wineryApplication.upsert({
      where: { id: a.id },
      update: data,
      create: { id: a.id, ...data, createdAt: moved(a.createdAt) },
    });
    for (const n of a.notes) {
      const note = {
        applicationId: a.id,
        text: n.text,
        authorUserId: userIdByName(n.by),
        authorName: n.by,
        createdAt: moved(n.at),
      };
      await tx.wineryApplicationNote.upsert({
        where: { id: n.id },
        update: note,
        create: { id: n.id, ...note },
      });
      applicationNotes++;
    }
    if (verifyToken) {
      links.push({
        email: data.contactEmail,
        path: `/unirse/verificar?token=${verifyToken}`,
      });
    }
  }

  return {
    applications: fx.applications.length,
    applicationNotes,
    profiles,
    statusChanges,
    links,
    warnings,
  };
}
