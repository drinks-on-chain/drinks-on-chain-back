import { MembershipRoleEnum, OrganizationTypeEnum } from '@prisma/client';

/**
 * Organización de plataforma (Drinks on Chain). Id fijo: lo crea la migración
 * `20260927120000_organizations_memberships_sessions` y lo asegura el seeder.
 */
export const PLATFORM_ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001';
export const PLATFORM_ORGANIZATION_NAME = 'Drinks on Chain';

export type OrganizationType = `${OrganizationTypeEnum}`;
export type MembershipRole = `${MembershipRoleEnum}`;
export type PlatformRole = 'SUPERADMIN' | 'ADMIN' | 'OPERATIONS' | 'SUPPORT';
export type WineryRole =
  'OWNER' | 'ENOLOGIST' | 'AGRONOMIST' | 'OPERATOR' | 'ACCOUNTANT';
export type PickupPointRole = 'MANAGER' | 'CASHIER';
export type Audience = 'STAFF' | 'CONSUMER';

/** Roles válidos por tipo de organización (contrato O0 §4). */
export const ROLES_BY_ORGANIZATION_TYPE: Record<
  OrganizationType,
  readonly MembershipRole[]
> = {
  PLATFORM: ['SUPERADMIN', 'ADMIN', 'OPERATIONS', 'SUPPORT'],
  WINERY: ['OWNER', 'ENOLOGIST', 'AGRONOMIST', 'OPERATOR', 'ACCOUNTANT'],
  PICKUP_POINT: ['MANAGER', 'CASHIER'],
};

export function isRoleValidForType(
  type: OrganizationType,
  role: MembershipRole,
): boolean {
  return ROLES_BY_ORGANIZATION_TYPE[type].includes(role);
}

/**
 * Personal de plataforma que opera sobre una bodega con `?wineryId=` (contrato
 * O0 §6, OP-07): lectura y escritura. `SUPPORT` solo lee.
 */
export const PLATFORM_WINERY_OPERATORS: readonly PlatformRole[] = [
  'SUPERADMIN',
  'ADMIN',
  'OPERATIONS',
];
export const PLATFORM_WINERY_READERS: readonly PlatformRole[] = [
  ...PLATFORM_WINERY_OPERATORS,
  'SUPPORT',
];

/** Orden de preferencia de la organización activa por defecto: plataforma antes que bodega. */
export const ORGANIZATION_TYPE_PRIORITY: Record<OrganizationType, number> = {
  PLATFORM: 0,
  WINERY: 1,
  PICKUP_POINT: 2,
};
