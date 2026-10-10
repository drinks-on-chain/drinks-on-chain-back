import type {
  MembershipRole,
  PlatformRole,
} from '@modules/organizations/organization.constants';
import { ROLES_BY_ORGANIZATION_TYPE } from '@modules/organizations/organization.constants';

/**
 * Matriz de permisos de la Ola 1 (PLT-04; contrato O1 §9 y docs-back/05 §3).
 * Fuente única de verdad: la sirve `GET /v1/platform/permissions` y de ella
 * salen los `@Roles(...)` de las rutas del back office (`platformRolesWith`).
 * Las claves y etiquetas son las de `@drinks-on-chain/mocks`.
 *
 * - `FULL`: lee y escribe · `READ`: solo lee · `OWN`: solo lo de su
 *   organización · `NONE`: nada.
 * - El superusuario tiene lo mismo que administración y además no se puede
 *   bloquear ni degradar (`PLATFORM_SUPERADMIN_PROTECTED`).
 */
export type PermissionLevel = 'FULL' | 'READ' | 'OWN' | 'NONE';

export interface CapabilityDefinition {
  key: string;
  label: string;
  roles: Partial<Record<MembershipRole, PermissionLevel>>;
}

const WINERY_STAFF = ['ENOLOGIST', 'AGRONOMIST', 'OPERATOR', 'ACCOUNTANT'];
const others = (level: PermissionLevel) =>
  Object.fromEntries(WINERY_STAFF.map((r) => [r, level])) as Partial<
    Record<MembershipRole, PermissionLevel>
  >;

export const CAPABILITIES: readonly CapabilityDefinition[] = [
  {
    key: 'platform.users',
    label: 'Usuarios internos',
    roles: { SUPERADMIN: 'FULL', ADMIN: 'FULL' },
  },
  {
    key: 'settings',
    label: 'Configuración',
    roles: {
      SUPERADMIN: 'FULL',
      ADMIN: 'FULL',
      OPERATIONS: 'READ',
      SUPPORT: 'READ',
      OWNER: 'READ',
      ...others('READ'),
    },
  },
  {
    key: 'applications',
    label: 'Solicitudes y alta de bodegas',
    roles: {
      SUPERADMIN: 'FULL',
      ADMIN: 'FULL',
      OPERATIONS: 'FULL',
      SUPPORT: 'READ',
    },
  },
  {
    key: 'waitlist',
    label: 'Lista de espera',
    roles: {
      SUPERADMIN: 'FULL',
      ADMIN: 'FULL',
      OPERATIONS: 'FULL',
      SUPPORT: 'READ',
    },
  },
  {
    key: 'wineries.suspend',
    label: 'Suspender y reactivar bodegas',
    roles: { SUPERADMIN: 'FULL', ADMIN: 'FULL', OPERATIONS: 'FULL' },
  },
  {
    key: 'wineries.revoke',
    label: 'Revocar bodega, transferir titularidad, bloquear cuenta completa',
    roles: { SUPERADMIN: 'FULL', ADMIN: 'FULL' },
  },
  {
    key: 'team',
    label: 'Equipo de una bodega',
    roles: {
      SUPERADMIN: 'FULL',
      ADMIN: 'FULL',
      OPERATIONS: 'FULL',
      SUPPORT: 'FULL',
      OWNER: 'OWN',
      ...others('READ'),
    },
  },
  {
    key: 'audit',
    label: 'Bitácora',
    roles: {
      SUPERADMIN: 'FULL',
      ADMIN: 'FULL',
      OPERATIONS: 'FULL',
      SUPPORT: 'FULL',
      OWNER: 'OWN',
    },
  },
  // Ola 3 (contrato O3 §10)
  {
    key: 'tokenization',
    label: 'Tokenización: bandeja, colecciones y cierre con faltante',
    roles: {
      SUPERADMIN: 'FULL',
      ADMIN: 'FULL',
      OPERATIONS: 'FULL',
      SUPPORT: 'READ',
      OWNER: 'OWN',
      ENOLOGIST: 'READ',
      ACCOUNTANT: 'READ',
    },
  },
  {
    key: 'chain',
    label:
      'Cadena: transacciones, identidad de las bodegas, conciliación y alertas',
    roles: {
      SUPERADMIN: 'FULL',
      ADMIN: 'FULL',
      OPERATIONS: 'FULL',
      SUPPORT: 'READ',
      OWNER: 'READ',
      ...others('READ'),
    },
  },
  {
    key: 'chain.admin',
    label:
      'Abandonar transacciones, pausar o reanudar un contrato en la red y quemar NFT sin vender',
    roles: { SUPERADMIN: 'FULL', ADMIN: 'FULL' },
  },
];

export const ALL_ROLES: readonly MembershipRole[] = [
  ...ROLES_BY_ORGANIZATION_TYPE.PLATFORM,
  ...ROLES_BY_ORGANIZATION_TYPE.WINERY,
  ...ROLES_BY_ORGANIZATION_TYPE.PICKUP_POINT,
];

export type CapabilityKey =
  | 'platform.users'
  | 'settings'
  | 'applications'
  | 'waitlist'
  | 'wineries.suspend'
  | 'wineries.revoke'
  | 'team'
  | 'audit'
  | 'tokenization'
  | 'chain'
  | 'chain.admin';

export function levelOf(
  key: CapabilityKey,
  role: string | null | undefined,
): PermissionLevel {
  const capability = CAPABILITIES.find((c) => c.key === key);
  if (!capability || !role) return 'NONE';
  return capability.roles[role as MembershipRole] ?? 'NONE';
}

/**
 * Roles de plataforma con alguno de los niveles en una capacidad, para
 * `@Roles(...platformRolesWith('platform.users', 'FULL'))`.
 */
export function platformRolesWith(
  key: CapabilityKey,
  ...levels: PermissionLevel[]
): PlatformRole[] {
  return (
    ROLES_BY_ORGANIZATION_TYPE.PLATFORM as readonly PlatformRole[]
  ).filter((role) => levels.includes(levelOf(key, role)));
}

/** `GET /v1/platform/permissions`: cada capacidad con el nivel de cada rol. */
export function permissionMatrix(): {
  capabilities: {
    key: string;
    label: string;
    roles: Record<MembershipRole, PermissionLevel>;
  }[];
} {
  return {
    capabilities: CAPABILITIES.map((c) => ({
      key: c.key,
      label: c.label,
      roles: Object.fromEntries(
        ALL_ROLES.map((role) => [role, c.roles[role] ?? 'NONE']),
      ) as Record<MembershipRole, PermissionLevel>,
    })),
  };
}
