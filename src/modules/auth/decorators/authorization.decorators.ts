import { SetMetadata } from '@nestjs/common';
import type {
  Audience as AudienceValue,
  MembershipRole,
  OrganizationType,
} from '@modules/organizations/organization.constants';

export const AUDIENCE_KEY = 'auth:audience';
export const ORG_TYPES_KEY = 'auth:orgTypes';
export const ROLES_KEY = 'auth:roles';
export const REQUIRE_ACTIVE_ORG_KEY = 'auth:requireActiveOrg';

/**
 * Audiencia exigida (claim `aud`): `STAFF` (con alguna membresía) o
 * `CONSUMER`. Contrato O0 §6.
 */
export const Audience = (...audiences: AudienceValue[]) =>
  SetMetadata(AUDIENCE_KEY, audiences);

/**
 * Tipo de la organización activa (claim `orgType`). Una ruta con `WINERY`
 * trabaja sobre una bodega: la resuelve el `TenantGuard` (la activa, o la de
 * `?wineryId=` si quien llama es personal de plataforma, OP-07).
 */
export const OrgType = (...types: OrganizationType[]) =>
  SetMetadata(ORG_TYPES_KEY, types);

/**
 * Roles en la organización activa (claim `role`), p. ej.
 * `@Roles('OWNER', 'ENOLOGIST')`. En las rutas de bodega, el personal de
 * plataforma (SUPERADMIN, ADMIN, OPERATIONS; SUPPORT solo lectura) pasa sin
 * necesitar un rol de bodega (contrato O0 §6).
 */
export const Roles = (...roles: MembershipRole[]) =>
  SetMetadata(ROLES_KEY, roles);

/**
 * Ruta del ERP que exige la bodega activa en estado `ACTIVE` (SE-05). En la
 * Ola 0 solo deja un aviso en los logs; con `FEATURE_ENFORCE_ACTIVE_ORG=true`
 * responde 403 `ORG_NOT_ACTIVE` (Ola 1). `allow` admite además otros estados
 * (contrato O1 §4: el perfil y la bitácora propia se leen en `SUSPENDED`).
 */
export const RequireActiveOrg = (
  options: { allow?: readonly ('INVITED' | 'SUSPENDED')[] } = {},
) => SetMetadata(REQUIRE_ACTIVE_ORG_KEY, { allow: options.allow ?? [] });
