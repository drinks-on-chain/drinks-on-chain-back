import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Fixtures de `@drinks-on-chain/mocks` que usa la semilla de demostración
 * (copiados con `pnpm seed:sync`; versión en `fixtures/source.json`). Solo se
 * tipan los campos que la semilla lee.
 */

type IsoDate = string;

export interface FixtureWineryMember {
  id: string;
  userId: string;
  memberRole: 'OWNER' | 'ENOLOGIST' | 'AGRONOMIST' | 'OPERATOR' | 'ACCOUNTANT';
  professionalLicenseNumber: string | null;
  isActive: boolean;
  joinedAt: IsoDate;
}

export interface FixtureWinery {
  id: string;
  legalName: string;
  commercialName: string;
  beverageCategory: 'WINERY' | 'BREWERY' | 'DISTILLERY' | 'OTHER';
  taxIdNit: string;
  senasagSanitaryReg: string | null;
  geographicRegion: string;
  countryCode: string;
  address: string | null;
  contactEmail: string;
  contactPhone: string | null;
  logoUrl: string | null;
  stellarPublicKey: string | null;
  onchainProducerId: string | null;
  onchainRegisterTxHash: string | null;
  isExportCertified: boolean;
  certificationStatus: 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
  approvedAt: IsoDate | null;
  createdAt: IsoDate;
  members: FixtureWineryMember[];
}

export interface FixtureUser {
  id: string;
  email: string;
  fullName: string;
  phoneNumber: string | null;
  preferredLocale: string;
  isActive: boolean;
  lastLoginAt: IsoDate | null;
  createdAt: IsoDate;
  _mock: {
    key: string;
    platformRole?: 'SUPERADMIN' | 'ADMIN' | 'OPERATIONS' | 'SUPPORT';
  };
}

export interface FixtureWallet {
  id: string;
  userId: string;
  wineryId: string | null;
  stellarPublicAddress: string;
  walletType: 'CUSTODIAL' | 'SELF_CUSTODY';
  walletPurpose: 'CONSUMER_NFT' | 'PRODUCER_SIGNING';
  isPrimary: boolean;
  createdAt: IsoDate;
}

export interface FixtureMemberBlock {
  membershipId: string;
  organizationId: string;
  by: 'OWNER' | 'PLATFORM';
  reason: string;
  at: IsoDate;
}

export interface FixtureTerroir {
  id: string;
  wineryId: string;
  parcelName: string;
  cadastreCode: string | null;
  surfaceHectares: number;
  altitudeMasl: number;
  latitude: number | null;
  longitude: number | null;
  geographicPolygonGeojson: object | null;
  rawMaterialType: string;
  varietyName: string;
  soilType: string | null;
  irrigationSystem: string | null;
  isDoEligible: boolean;
  doType: string | null;
  doCertificateUrl: string | null;
  isActive: boolean;
  createdAt: IsoDate;
}

export interface FixtureHarvestBatch {
  id: string;
  wineryId: string;
  terroirId: string;
  harvestBatchCode: string;
  intakeDate: IsoDate;
  harvestYear: number;
  grossWeightKg: number;
  tareWeightKg: number;
  netWeightKg: number;
  /** Último análisis de madurez; nulos sin análisis. */
  brixDegrees: number | null;
  initialPh: number | null;
  initialAcidityGl: number | null;
  temperatureAtIntakeC: number | null;
  phytosanitaryStatus:
    'PENDING_INSPECTION' | 'APPROVED' | 'REJECTED' | 'QUARANTINE';
  phytoInspectionPdfUrl: string | null;
  certifiedByMemberId: string | null;
  notes: string | null;
  createdAt: IsoDate;
  /** `null` = uva recibida sin lote. */
  lotId: string | null;
  terroirSnapshot: {
    parcelName: string;
    altitudeMasl: number;
    varietyName: string;
    rawMaterialType: string;
    takenAt: IsoDate;
  } | null;
}

/** Quién hizo algo, como lo devuelve la API (`TraceActor`). */
export interface FixtureActor {
  membershipId: string;
  userId: string;
  fullName: string;
  role: string;
}

export interface FixtureFermentationTank {
  id: string;
  wineryId: string;
  harvestBatchId: string;
  tankCode: string;
  capacityLiters: number | null;
  material: string | null;
  volumeFilledLiters: number | null;
  destinationType:
    | 'WINE_AGING'
    | 'SINGANI_DIST'
    | 'BEER_MATURATION'
    | 'SPIRITS_DIST'
    | 'OTHER'
    | null;
  status: 'FILLING' | 'FERMENTING' | 'COMPLETED' | 'TRANSFERRED' | 'CLEANED';
  startDate: IsoDate;
  endDate: IsoDate | null;
  createdAt: IsoDate;
  lotId: string;
  finalVolumeLiters: number | null;
  inputs: { harvestBatchId: string; kg: number }[];
  /** Solo en los tanques creados con las acciones de la Ola 2. */
  transitions?: {
    status: 'FILLING' | 'FERMENTING' | 'COMPLETED' | 'TRANSFERRED' | 'CLEANED';
    at: IsoDate;
    by: FixtureActor | null;
  }[];
}

export interface FixtureFermentationLog {
  id: string;
  fermentationTankId: string;
  temperatureCelsius: number;
  specificGravity: number | null;
  phValue: number | null;
  co2Observations: string | null;
  recordedAt: IsoDate;
  notes: string | null;
  recordedByMemberId: string;
}

export interface FixtureEnologicalTreatment {
  id: string;
  fermentationTankId: string;
  treatmentType:
    | 'ACIDITY_CORRECTION'
    | 'SO2_ADDITION'
    | 'CLARIFICATION'
    | 'FILTRATION_AID'
    | 'NUTRIENT_ADDITION'
    | 'ENZYME_ADDITION'
    | 'OAK_CHIPS'
    | 'FINING_AGENT'
    | 'STABILIZATION'
    | 'OTHER';
  additiveName: string;
  additiveSupplier: string | null;
  dosageAppliedGPerHl: number;
  totalAppliedG: number | null;
  regulatoryAuthCode: string;
  appliedAt: IsoDate;
  notes: string | null;
}

export interface FixtureWineAging {
  id: string;
  wineryId: string;
  fermentationTankId: string;
  containerType: string;
  containerMaterial: string | null;
  containerCode: string | null;
  barrelUseCycle: number | null;
  volumeLiters: number | null;
  plannedMonths: number;
  lockUntilDate: IsoDate;
  agingStatus: 'AGING' | 'READY' | 'BOTTLED' | 'DISCARDED';
  notes: string | null;
  createdAt: IsoDate;
  lotId: string;
  /** Día de calendario (`YYYY-MM-DD`). */
  startDate: string | null;
  containerCount: number | null;
}

export interface FixtureProductionBatch {
  id: string;
  wineryId: string;
  fermentationTankId: string;
  processType:
    | 'SINGANI_DISTILLATION'
    | 'SPIRITS_DISTILLATION'
    | 'BEER_MATURATION'
    | 'SECONDARY_FERMENTATION'
    | 'OTHER';
  equipmentIdentifier: string;
  processStartDate: IsoDate;
  processEndDate: IsoDate | null;
  inputVolumeLiters: number | null;
  outputVolumeLiters: number | null;
  wasteVolumeLiters: number | null;
  initialAlcoholPercentage: number | null;
  isDoEligible: boolean;
  mandatoryRestUntil: IsoDate | null;
  restStatus: 'NOT_REQUIRED' | 'RESTING' | 'READY' | 'BOTTLED' | 'DISCARDED';
  additionalParams: object | null;
  notes: string | null;
  createdAt: IsoDate;
  lotId: string;
  headsLiters: number | null;
  heartLiters: number | null;
  tailsLiters: number | null;
  vinasseLiters: number | null;
  heartAbvPercent: number | null;
}

export interface FixtureBottlingBatch {
  id: string;
  wineryId: string;
  wineAgingBatchId: string | null;
  productionBatchId: string | null;
  productType:
    'WINE' | 'SINGANI' | 'BEER' | 'SPIRITS' | 'CIDER' | 'MEAD' | 'OTHER';
  internationalLotCode: string;
  finalAlcoholAbv: number;
  waterDilutionLiters: number | null;
  totalBottlesPackaged: number;
  packagingFormatCl: number;
  bottleType: string | null;
  labelDesignUrl: string | null;
  bottlingDate: IsoDate;
  releasedByMemberId: string | null;
  blockchainAnchorTxHash: string | null;
  blockchainDataHash: string | null;
  isAnchoredOnChain: boolean;
  anchoredAt: IsoDate | null;
  qrBatchUrl: string | null;
  createdAt: IsoDate;
  lotId: string;
  balance: { availableLiters: number } | null;
  leftover: {
    liters: number;
    disposition: 'RETAINED' | 'DISCARDED';
    notes: string | null;
  } | null;
}

export interface FixtureLabAnalysis {
  id: string;
  bottlingBatchId: string;
  certifiedLaboratoryName: string;
  accreditedLabCertificationCode: string;
  analysisRequestDate: IsoDate | null;
  testPerformedAt: IsoDate;
  actualAlcoholAbv: number;
  totalAlcoholAbv: number | null;
  totalAcidityTartaricGl: number;
  volatileAcidityAceticGl: number;
  freeSulfurDioxideMgL: number | null;
  totalSulfurDioxideMgL: number | null;
  reducingSugarsGl: number | null;
  totalDryExtractGl: number | null;
  sugarFreeDryExtractGl: number | null;
  overpressureBar: number | null;
  methanolContentMgL: number | null;
  copperContentMgL: number | null;
  additionalParams: object | null;
  laboratoryReportPdfUrl: string;
  conformsToSenasagStandards: boolean;
  conformsToEuStandards: boolean;
  conformsToUsaStandards: boolean;
  reviewedByMemberId: string | null;
  createdAt: IsoDate;
  lotId: string;
  methanolMg100mlAa: number | null;
  conformityStatus: 'CONFORMING' | 'NON_CONFORMING' | 'INCOMPLETE';
  supersededAt: IsoDate | null;
  recordedBy: FixtureActor | null;
  report: { key: string; sha256: string | null } | null;
}

/** Lote del servidor (contrato O2 §2.1), con la forma de `GET /v1/lots/{id}`. */
export interface FixtureLot {
  id: string;
  wineryId: string;
  reference: string;
  lotCode: string | null;
  name: string;
  productType: 'WINE' | 'SINGANI' | null;
  stage:
    | 'ORIGIN'
    | 'HARVEST'
    | 'FERMENTING'
    | 'AGING'
    | 'DISTILLING'
    | 'RESTING'
    | 'BOTTLED'
    | 'CERTIFIED'
    | 'ANCHORED'
    | 'REJECTED'
    | 'DISCARDED';
  stageChangedAt: IsoDate;
  harvestYear: number;
  estimatedBottles: number | null;
  bottles: number | null;
  labStatus: 'NOT_RECORDED' | 'CONFORMING' | 'NON_CONFORMING' | 'INCOMPLETE';
  dossierStatus: 'OPEN' | 'CLOSED';
  createdAt: IsoDate;
  updatedAt: IsoDate;
  plannedTerroirIds: string[];
  plannedFormatCl: number | null;
  targetAbvPercent: number | null;
  /** Día de calendario (`YYYY-MM-DD`). */
  targetReadyDate: string | null;
  /** Instantánea de reglas (`LotRules`). */
  rules: { takenAt: IsoDate; origin: 'LOT_CREATION' | 'MIGRATION' } & Record<
    string,
    unknown
  >;
  discarded: { at: IsoDate; by: FixtureActor | null; reason: string } | null;
  notes: string | null;
  createdBy: FixtureActor | null;
}

export interface FixtureMaturityAnalysis {
  id: string;
  harvestBatchId: string;
  brixDegrees: number;
  ph: number;
  acidityGl: number;
  measuredAt: IsoDate;
  recordedAt: IsoDate;
  recordedBy: FixtureActor | null;
  notes: string | null;
  source: 'ERP' | 'MIGRATION';
}

export interface FixturePhytoDecision {
  id: string;
  harvestBatchId: string;
  decision: 'APPROVED' | 'REJECTED' | 'QUARANTINE';
  decidedAt: IsoDate;
  recordedAt: IsoDate;
  decidedBy: FixtureActor | null;
  inspectionReport: { key: string; sha256: string | null } | null;
  notes: string | null;
  source: 'ERP' | 'MIGRATION';
}

/** Evento de la línea de tiempo del lote (contrato O2 §11.1). */
export interface FixtureLotEvent {
  lotId: string;
  id: string;
  seq: number;
  type: string;
  occurredAt: IsoDate;
  recordedAt: IsoDate;
  stage: FixtureLot['stage'];
  actor: FixtureActor | null;
  summary: string;
  data: Record<string, unknown>;
  resource: { type: string; id: string };
  visibility: 'PUBLIC' | 'INTERNAL';
  corrected: boolean;
}

/** Corrección compensatoria (contrato O2 §9). */
export interface FixtureCorrection {
  id: string;
  lotId: string | null;
  target: { type: string; id: string };
  kind: 'AMEND' | 'VOID';
  changes: { field: string; before: unknown; after: unknown }[];
  reason: string;
  createdAt: IsoDate;
  createdBy: FixtureActor | null;
}

export interface FixtureInvitation {
  id: string;
  email: string;
  organizationId: string;
  organizationType: 'PLATFORM' | 'WINERY' | 'PICKUP_POINT';
  organizationName: string;
  role: string;
  status: 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'REVOKED';
  expiresAt: IsoDate;
  createdAt: IsoDate;
  invitedBy: { userId: string; fullName: string; viaPlatform: boolean };
  _mock: {
    token: string;
    inviteeName: string | null;
    acceptedAt: IsoDate | null;
    revokedAt: IsoDate | null;
  };
}

/** Solicitud de alta de los mocks (contrato O1 §3). */
export interface FixtureApplication {
  id: string;
  status:
    | 'UNVERIFIED'
    | 'RECEIVED'
    | 'IN_REVIEW'
    | 'MEETING_SCHEDULED'
    | 'APPROVED'
    | 'REJECTED';
  createdAt: IsoDate;
  updatedAt: IsoDate;
  legalName: string;
  tradeName: string;
  taxId: string;
  category: 'WINERY' | 'BREWERY' | 'DISTILLERY' | 'OTHER';
  region: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string | null;
  message: string | null;
  assignee: { userId: string; fullName: string } | null;
  meeting: {
    scheduledAt: IsoDate;
    channel: 'CALL' | 'VIDEO' | 'IN_PERSON';
    notes: string | null;
  } | null;
  decision: { by: string; at: IsoDate; reason: string | null } | null;
  wineryId: string | null;
  notes: { id: string; text: string; by: string; at: IsoDate }[];
  _mock: { verifyToken: string | null };
}

/** Perfil de la Ola 1 de una bodega de los mocks (slug, prefijo, historial). */
export interface FixtureWineryProfile {
  wineryId: string;
  slug: string;
  lotPrefix: string | null;
  publicStory: string | null;
  website: string | null;
  activatedAt: IsoDate | null;
  statusHistory: {
    status: 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
    at: IsoDate;
    by: string;
    reason: string | null;
  }[];
}

/** Quién tiene el segundo factor inscrito en los mocks (sin secretos). */
export interface FixtureStaffMfa {
  userId: string;
  enrolled: boolean;
  enrolledAt: IsoDate | null;
}

export interface FixtureSource {
  package: string;
  version: string;
  git: string | null;
  referenceDay: string;
}

export interface MockFixtures {
  source: FixtureSource;
  wineries: FixtureWinery[];
  users: FixtureUser[];
  wallets: FixtureWallet[];
  memberBlocks: FixtureMemberBlock[];
  invitations: FixtureInvitation[];
  staffMfa: FixtureStaffMfa[];
  applications: FixtureApplication[];
  wineryProfiles: FixtureWineryProfile[];
  terroirs: FixtureTerroir[];
  harvestBatches: FixtureHarvestBatch[];
  fermentationTanks: FixtureFermentationTank[];
  fermentationLogs: FixtureFermentationLog[];
  enologicalTreatments: FixtureEnologicalTreatment[];
  wineAgings: FixtureWineAging[];
  productionBatches: FixtureProductionBatch[];
  bottlingBatches: FixtureBottlingBatch[];
  labAnalyses: FixtureLabAnalysis[];
  lots: FixtureLot[];
  maturityAnalyses: FixtureMaturityAnalysis[];
  phytoDecisions: FixturePhytoDecision[];
  lotEvents: FixtureLotEvent[];
  corrections: FixtureCorrection[];
}

/** Carpeta de los fixtures: junto al código (`src/seed` o `dist/seed`). */
export const FIXTURES_DIR = join(__dirname, 'fixtures');

function read<T>(dir: string, file: string): T {
  return JSON.parse(readFileSync(join(dir, file), 'utf8')) as T;
}

export function loadMockFixtures(dir: string = FIXTURES_DIR): MockFixtures {
  return {
    source: read(dir, 'source.json'),
    wineries: read(dir, 'wineries.json'),
    users: read(dir, 'users.json'),
    wallets: read(dir, 'wallets.json'),
    memberBlocks: read(dir, 'member-blocks.json'),
    invitations: read(dir, 'invitations.json'),
    staffMfa: read(dir, 'staff-mfa.json'),
    applications: read(dir, 'applications.json'),
    wineryProfiles: read(dir, 'winery-profiles.json'),
    terroirs: read(dir, 'terroirs.json'),
    harvestBatches: read(dir, 'harvest-batches.json'),
    fermentationTanks: read(dir, 'fermentation-tanks.json'),
    fermentationLogs: read(dir, 'fermentation-logs.json'),
    enologicalTreatments: read(dir, 'enological-treatments.json'),
    wineAgings: read(dir, 'wine-aging.json'),
    productionBatches: read(dir, 'production-batches.json'),
    bottlingBatches: read(dir, 'bottling.json'),
    labAnalyses: read(dir, 'lab-analyses.json'),
    lots: read(dir, 'lots.json'),
    maturityAnalyses: read(dir, 'maturity-analyses.json'),
    phytoDecisions: read(dir, 'phyto-decisions.json'),
    lotEvents: read(dir, 'lot-events.json'),
    corrections: read(dir, 'corrections.json'),
  };
}
