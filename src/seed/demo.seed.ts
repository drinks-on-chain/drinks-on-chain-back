import {
  MembershipStatusEnum,
  OrganizationTypeEnum,
  Prisma,
} from '@prisma/client';
import { PLATFORM_ORGANIZATION_ID } from '../modules/organizations/organization.constants';
import { FixtureUser, FixtureWineryMember, MockFixtures } from './fixtures';
import { platformMembershipId } from './ids';

/**
 * Datos de demostración (0.10, OPS-09) a partir de los fixtures de los mocks,
 * con sus mismos ids, nombres, códigos y fechas: una pantalla muestra lo mismo
 * con los mocks y con el backend.
 *
 * Idempotente: cada fila se escribe con `upsert` por su id fijo (o por su
 * clave natural: correo, persona + organización) y las lecturas de
 * fermentación con `createMany({ skipDuplicates })`. Volver a ejecutarla
 * devuelve los datos de demostración a su estado inicial sin duplicar nada y
 * sin tocar lo que se haya creado aparte.
 */

/** Roles de plataforma de demostración (el superusuario sale del entorno). */
export const DEMO_PLATFORM_ROLES = ['ADMIN', 'OPERATIONS', 'SUPPORT'] as const;
type DemoPlatformRole = (typeof DEMO_PLATFORM_ROLES)[number];

export interface DemoSeedSummary {
  users: number;
  platformMemberships: number;
  wineries: number;
  wineryMemberships: number;
  wallets: number;
  terroirs: number;
  harvestBatches: number;
  fermentationTanks: number;
  fermentationLogs: number;
  enologicalTreatments: number;
  wineAgings: number;
  productionBatches: number;
  bottlingBatches: number;
  labAnalyses: number;
}

export interface DemoPeople {
  /** Personal interno (ADMIN, OPERATIONS, SUPPORT) y personas de bodega. */
  included: FixtureUser[];
  /** Personas de los mocks que la semilla no crea (y por qué). */
  skipped: { user: FixtureUser; reason: string }[];
}

function isDemoPlatformRole(
  role: string | undefined,
): role is DemoPlatformRole {
  return (DEMO_PLATFORM_ROLES as readonly string[]).includes(role ?? '');
}

/**
 * Personas que crea la semilla: el personal interno de demo y quien tenga
 * alguna membresía de bodega. Quedan fuera el `SUPERADMIN` de los mocks (el
 * superusuario es el del entorno), los consumidores y el cajero del POS (sin
 * organización hasta el Marketplace y el POS).
 */
export function selectDemoPeople(fx: MockFixtures): DemoPeople {
  const wineryPeople = new Set(
    fx.wineries.flatMap((w) => w.members.map((m) => m.userId)),
  );
  const included: FixtureUser[] = [];
  const skipped: DemoPeople['skipped'] = [];
  for (const user of fx.users) {
    const platformRole = user._mock.platformRole;
    if (isDemoPlatformRole(platformRole) || wineryPeople.has(user.id)) {
      included.push(user);
    } else if (platformRole === 'SUPERADMIN') {
      skipped.push({
        user,
        reason: 'SUPERADMIN: el superusuario sale de SUPERADMIN_*',
      });
    } else {
      skipped.push({ user, reason: 'sin organización' });
    }
  }
  return { included, skipped };
}

const date = (iso: string): Date => new Date(iso);
const optionalDate = (iso: string | null): Date | null =>
  iso === null ? null : new Date(iso);
const json = (
  value: object | null,
): Prisma.InputJsonValue | typeof Prisma.DbNull =>
  value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue);

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`Semilla: falta ${what} en los fixtures`);
  }
  return value;
}

/** Quién autoriza los tratamientos de una bodega (los mocks no lo guardan). */
function treatmentAuthorizer(
  members: readonly FixtureWineryMember[],
): FixtureWineryMember | undefined {
  const active = members.filter((m) => m.isActive);
  return (
    active.find((m) => m.memberRole === 'ENOLOGIST') ??
    active.find((m) => m.memberRole === 'OWNER')
  );
}

export async function seedDemo(
  tx: Prisma.TransactionClient,
  fx: MockFixtures,
  passwordHash: string,
): Promise<DemoSeedSummary> {
  const { included } = selectDemoPeople(fx);

  // ---------------------------------------------------------------------------
  // Personas (por correo) y personal interno
  // ---------------------------------------------------------------------------
  /** id de los fixtures → id en la base (difiere si el correo ya existía). */
  const userIds = new Map<string, string>();
  let platformMemberships = 0;
  for (const u of included) {
    const user = await tx.user.upsert({
      where: { email: u.email },
      update: {
        fullName: u.fullName,
        passwordHash,
        isActive: u.isActive,
        phoneNumber: u.phoneNumber,
        preferredLocale: u.preferredLocale,
      },
      create: {
        id: u.id,
        email: u.email,
        fullName: u.fullName,
        phoneNumber: u.phoneNumber,
        preferredLocale: u.preferredLocale,
        isActive: u.isActive,
        passwordHash,
        lastLoginAt: optionalDate(u.lastLoginAt),
        createdAt: date(u.createdAt),
      },
      select: { id: true },
    });
    userIds.set(u.id, user.id);

    const platformRole = u._mock.platformRole;
    if (isDemoPlatformRole(platformRole)) {
      await tx.membership.upsert({
        where: {
          userId_organizationId: {
            userId: user.id,
            organizationId: PLATFORM_ORGANIZATION_ID,
          },
        },
        update: {
          role: platformRole,
          status: MembershipStatusEnum.ACTIVE,
          blockedBy: null,
          blockedReason: null,
          blockedAt: null,
        },
        create: {
          id: platformMembershipId(u.id),
          userId: user.id,
          organizationId: PLATFORM_ORGANIZATION_ID,
          role: platformRole,
          createdAt: date(u.createdAt),
        },
      });
      platformMemberships++;
    }
  }

  // ---------------------------------------------------------------------------
  // Bodegas (mismo id que su organización), miembros y membresías
  // ---------------------------------------------------------------------------
  /** id del miembro en los fixtures → id en la base (winery_members = memberships). */
  const memberIds = new Map<string, string>();
  /** id del miembro en los fixtures → id de su persona en la base. */
  const memberUsers = new Map<string, string>();
  const authorizerByWinery = new Map<string, string>();
  let wineryMemberships = 0;

  for (const w of fx.wineries) {
    const data = {
      legalName: w.legalName,
      commercialName: w.commercialName,
      beverageCategory: w.beverageCategory,
      taxIdNit: w.taxIdNit,
      senasagSanitaryReg: w.senasagSanitaryReg,
      geographicRegion: w.geographicRegion,
      countryCode: w.countryCode,
      address: w.address,
      contactEmail: w.contactEmail,
      contactPhone: w.contactPhone,
      logoUrl: w.logoUrl,
      stellarPublicKey: w.stellarPublicKey,
      // Bóveda simulada (como la del worker) solo si la bodega tiene cuenta
      dynamicVaultId: w.stellarPublicKey ? `demo-vault-${w.id}` : null,
      onchainProducerId: w.onchainProducerId,
      onchainRegisterTxHash: w.onchainRegisterTxHash,
      isExportCertified: w.isExportCertified,
      certificationStatus: w.certificationStatus,
      approvedAt: optionalDate(w.approvedAt),
    };
    await tx.winery.upsert({
      where: { id: w.id },
      update: data,
      create: { id: w.id, ...data, createdAt: date(w.createdAt) },
    });
    await tx.organization.upsert({
      where: { id: w.id },
      update: { name: w.commercialName, status: w.certificationStatus },
      create: {
        id: w.id,
        type: OrganizationTypeEnum.WINERY,
        name: w.commercialName,
        status: w.certificationStatus,
        wineryId: w.id,
        createdAt: date(w.createdAt),
      },
    });

    for (const m of w.members) {
      const userId = userIds.get(m.userId);
      if (!userId) continue;
      const member = await tx.wineryMember.upsert({
        where: { userId_wineryId: { userId, wineryId: w.id } },
        update: {
          memberRole: m.memberRole,
          professionalLicenseNumber: m.professionalLicenseNumber,
          isActive: m.isActive,
        },
        create: {
          id: m.id,
          userId,
          wineryId: w.id,
          memberRole: m.memberRole,
          professionalLicenseNumber: m.professionalLicenseNumber,
          isActive: m.isActive,
          joinedAt: date(m.joinedAt),
        },
        select: { id: true },
      });
      const block = m.isActive
        ? undefined
        : fx.memberBlocks.find((b) => b.membershipId === m.id);
      const status = m.isActive
        ? MembershipStatusEnum.ACTIVE
        : MembershipStatusEnum.BLOCKED;
      const blocked = {
        blockedBy: block?.by ?? null,
        blockedReason: block?.reason ?? null,
        blockedAt: block ? date(block.at) : null,
      };
      await tx.membership.upsert({
        where: {
          userId_organizationId: { userId, organizationId: w.id },
        },
        update: { role: m.memberRole, status, ...blocked },
        create: {
          // En las bodegas, el id de la membresía es el del miembro
          id: member.id,
          userId,
          organizationId: w.id,
          role: m.memberRole,
          status,
          ...blocked,
          createdAt: date(m.joinedAt),
        },
      });
      memberIds.set(m.id, member.id);
      memberUsers.set(m.id, userId);
      wineryMemberships++;
    }

    const authorizer = treatmentAuthorizer(w.members);
    if (authorizer && memberIds.has(authorizer.id)) {
      authorizerByWinery.set(w.id, memberIds.get(authorizer.id)!);
    }
  }

  const memberRef = (id: string | null): string | null =>
    id === null ? null : required(memberIds.get(id), `el miembro ${id}`);

  // ---------------------------------------------------------------------------
  // Billeteras de las personas creadas
  // ---------------------------------------------------------------------------
  let wallets = 0;
  for (const wallet of fx.wallets) {
    const userId = userIds.get(wallet.userId);
    if (!userId) continue;
    await tx.userWallet.upsert({
      where: { id: wallet.id },
      update: { wineryId: wallet.wineryId, isPrimary: wallet.isPrimary },
      create: {
        id: wallet.id,
        userId,
        wineryId: wallet.wineryId,
        stellarPublicAddress: wallet.stellarPublicAddress,
        dynamicVaultId: `demo-vault-${wallet.id}`,
        walletType: wallet.walletType,
        walletPurpose: wallet.walletPurpose,
        isPrimary: wallet.isPrimary,
        createdAt: date(wallet.createdAt),
      },
    });
    wallets++;
  }

  // ---------------------------------------------------------------------------
  // Trazabilidad: parcelas → vendimia → tanques (lecturas y tratamientos) →
  // crianza o destilación → embotellado → laboratorio
  // ---------------------------------------------------------------------------
  for (const t of fx.terroirs) {
    const data = {
      wineryId: t.wineryId,
      parcelName: t.parcelName,
      cadastreCode: t.cadastreCode,
      surfaceHectares: t.surfaceHectares,
      altitudeMasl: t.altitudeMasl,
      latitude: t.latitude,
      longitude: t.longitude,
      geographicPolygonGeojson: json(t.geographicPolygonGeojson),
      rawMaterialType: t.rawMaterialType,
      varietyName: t.varietyName,
      soilType: t.soilType,
      irrigationSystem: t.irrigationSystem,
      isDoEligible: t.isDoEligible,
      doType: t.doType,
      doCertificateUrl: t.doCertificateUrl,
      isActive: t.isActive,
    };
    await tx.terroir.upsert({
      where: { id: t.id },
      update: data,
      create: { id: t.id, ...data, createdAt: date(t.createdAt) },
    });
  }

  for (const h of fx.harvestBatches) {
    const data = {
      wineryId: h.wineryId,
      terroirId: h.terroirId,
      harvestBatchCode: h.harvestBatchCode,
      intakeDate: date(h.intakeDate),
      harvestYear: h.harvestYear,
      grossWeightKg: h.grossWeightKg,
      tareWeightKg: h.tareWeightKg,
      netWeightKg: h.netWeightKg,
      brixDegrees: h.brixDegrees,
      initialPh: h.initialPh,
      initialAcidityGl: h.initialAcidityGl,
      temperatureAtIntakeC: h.temperatureAtIntakeC,
      phytosanitaryStatus: h.phytosanitaryStatus,
      phytoInspectionPdfUrl: h.phytoInspectionPdfUrl,
      certifiedByMemberId: memberRef(h.certifiedByMemberId),
      notes: h.notes,
    };
    await tx.harvestBatch.upsert({
      where: { id: h.id },
      update: data,
      create: { id: h.id, ...data, createdAt: date(h.createdAt) },
    });
  }

  const tankWinery = new Map<string, string>();
  for (const t of fx.fermentationTanks) {
    tankWinery.set(t.id, t.wineryId);
    const data = {
      wineryId: t.wineryId,
      harvestBatchId: t.harvestBatchId,
      tankCode: t.tankCode,
      capacityLiters: t.capacityLiters,
      material: t.material,
      volumeFilledLiters: t.volumeFilledLiters,
      destinationType: t.destinationType,
      status: t.status,
      startDate: date(t.startDate),
      endDate: optionalDate(t.endDate),
    };
    await tx.fermentationTank.upsert({
      where: { id: t.id },
      update: data,
      create: { id: t.id, ...data, createdAt: date(t.createdAt) },
    });
  }

  // Lecturas y tratamientos: solo se añaden (son registros históricos)
  await tx.fermentationLog.createMany({
    data: fx.fermentationLogs.map((l) => ({
      id: l.id,
      fermentationTankId: l.fermentationTankId,
      temperatureCelsius: l.temperatureCelsius,
      specificGravity: l.specificGravity,
      phValue: l.phValue,
      co2Observations: l.co2Observations,
      recordedAt: date(l.recordedAt),
      recordedByUserId: required(
        memberUsers.get(l.recordedByMemberId),
        `la persona del miembro ${l.recordedByMemberId}`,
      ),
      notes: l.notes,
    })),
    skipDuplicates: true,
  });

  await tx.enologicalTreatment.createMany({
    data: fx.enologicalTreatments.map((t) => {
      const wineryId = required(
        tankWinery.get(t.fermentationTankId),
        `el tanque ${t.fermentationTankId}`,
      );
      return {
        id: t.id,
        fermentationTankId: t.fermentationTankId,
        treatmentType: t.treatmentType,
        additiveName: t.additiveName,
        additiveSupplier: t.additiveSupplier,
        dosageAppliedGPerHl: t.dosageAppliedGPerHl,
        totalAppliedG: t.totalAppliedG,
        regulatoryAuthCode: t.regulatoryAuthCode,
        appliedAt: date(t.appliedAt),
        authorizedByMemberId: required(
          authorizerByWinery.get(wineryId),
          `quien autorice los tratamientos de la bodega ${wineryId}`,
        ),
        notes: t.notes,
      };
    }),
    skipDuplicates: true,
  });

  for (const a of fx.wineAgings) {
    const data = {
      wineryId: a.wineryId,
      fermentationTankId: a.fermentationTankId,
      containerType: a.containerType,
      containerMaterial: a.containerMaterial,
      containerCode: a.containerCode,
      barrelUseCycle: a.barrelUseCycle,
      volumeLiters: a.volumeLiters,
      plannedMonths: a.plannedMonths,
      lockUntilDate: date(a.lockUntilDate),
      agingStatus: a.agingStatus,
      notes: a.notes,
    };
    await tx.wineAgingBatch.upsert({
      where: { id: a.id },
      update: data,
      create: { id: a.id, ...data, createdAt: date(a.createdAt) },
    });
  }

  for (const p of fx.productionBatches) {
    const data = {
      wineryId: p.wineryId,
      fermentationTankId: p.fermentationTankId,
      processType: p.processType,
      equipmentIdentifier: p.equipmentIdentifier,
      processStartDate: date(p.processStartDate),
      processEndDate: optionalDate(p.processEndDate),
      inputVolumeLiters: p.inputVolumeLiters,
      outputVolumeLiters: p.outputVolumeLiters,
      wasteVolumeLiters: p.wasteVolumeLiters,
      initialAlcoholPercentage: p.initialAlcoholPercentage,
      isDoEligible: p.isDoEligible,
      mandatoryRestUntil: optionalDate(p.mandatoryRestUntil),
      restStatus: p.restStatus,
      additionalParams: json(p.additionalParams),
      notes: p.notes,
    };
    await tx.productionBatch.upsert({
      where: { id: p.id },
      update: data,
      create: { id: p.id, ...data, createdAt: date(p.createdAt) },
    });
  }

  for (const b of fx.bottlingBatches) {
    const data = {
      wineryId: b.wineryId,
      wineAgingBatchId: b.wineAgingBatchId,
      productionBatchId: b.productionBatchId,
      productType: b.productType,
      internationalLotCode: b.internationalLotCode,
      finalAlcoholAbv: b.finalAlcoholAbv,
      waterDilutionLiters: b.waterDilutionLiters,
      totalBottlesPackaged: b.totalBottlesPackaged,
      packagingFormatCl: b.packagingFormatCl,
      bottleType: b.bottleType,
      labelDesignUrl: b.labelDesignUrl,
      bottlingDate: date(b.bottlingDate),
      releasedByMemberId: memberRef(b.releasedByMemberId),
      blockchainAnchorTxHash: b.blockchainAnchorTxHash,
      blockchainDataHash: b.blockchainDataHash,
      isAnchoredOnChain: b.isAnchoredOnChain,
      anchoredAt: optionalDate(b.anchoredAt),
      qrBatchUrl: b.qrBatchUrl,
    };
    await tx.bottlingBatch.upsert({
      where: { id: b.id },
      update: data,
      create: { id: b.id, ...data, createdAt: date(b.createdAt) },
    });
  }

  for (const l of fx.labAnalyses) {
    const data = {
      bottlingBatchId: l.bottlingBatchId,
      certifiedLaboratoryName: l.certifiedLaboratoryName,
      accreditedLabCertificationCode: l.accreditedLabCertificationCode,
      analysisRequestDate: optionalDate(l.analysisRequestDate),
      testPerformedAt: date(l.testPerformedAt),
      actualAlcoholAbv: l.actualAlcoholAbv,
      totalAlcoholAbv: l.totalAlcoholAbv,
      totalAcidityTartaricGl: l.totalAcidityTartaricGl,
      volatileAcidityAceticGl: l.volatileAcidityAceticGl,
      freeSulfurDioxideMgL: l.freeSulfurDioxideMgL,
      totalSulfurDioxideMgL: l.totalSulfurDioxideMgL,
      reducingSugarsGl: l.reducingSugarsGl,
      totalDryExtractGl: l.totalDryExtractGl,
      sugarFreeDryExtractGl: l.sugarFreeDryExtractGl,
      overpressureBar: l.overpressureBar,
      methanolContentMgL: l.methanolContentMgL,
      copperContentMgL: l.copperContentMgL,
      additionalParams: json(l.additionalParams),
      laboratoryReportPdfUrl: l.laboratoryReportPdfUrl,
      conformsToSenasagStandards: l.conformsToSenasagStandards,
      conformsToEuStandards: l.conformsToEuStandards,
      conformsToUsaStandards: l.conformsToUsaStandards,
      reviewedByMemberId: memberRef(l.reviewedByMemberId),
    };
    await tx.batchLabAnalysis.upsert({
      where: { id: l.id },
      update: data,
      create: { id: l.id, ...data, createdAt: date(l.createdAt) },
    });
  }

  return {
    users: included.length,
    platformMemberships,
    wineries: fx.wineries.length,
    wineryMemberships,
    wallets,
    terroirs: fx.terroirs.length,
    harvestBatches: fx.harvestBatches.length,
    fermentationTanks: fx.fermentationTanks.length,
    fermentationLogs: fx.fermentationLogs.length,
    enologicalTreatments: fx.enologicalTreatments.length,
    wineAgings: fx.wineAgings.length,
    productionBatches: fx.productionBatches.length,
    bottlingBatches: fx.bottlingBatches.length,
    labAnalyses: fx.labAnalyses.length,
  };
}
