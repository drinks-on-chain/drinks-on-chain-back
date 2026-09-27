import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';
import type { AuthenticatedUser } from '@shared/decorators/current-user.decorator';
import {
  Audience,
  MembershipRole,
  OrganizationType,
  PLATFORM_WINERY_OPERATORS,
  PLATFORM_WINERY_READERS,
  PlatformRole,
} from '@modules/organizations/organization.constants';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import {
  AUDIENCE_KEY,
  ORG_TYPES_KEY,
  REQUIRE_ACTIVE_ORG_KEY,
  ROLES_KEY,
} from '../decorators/authorization.decorators';
import { SESSION_SETTINGS, SessionSettings } from '../sessions/session.config';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isReadMethod(method: string | undefined): boolean {
  return READ_METHODS.has((method ?? 'GET').toUpperCase());
}

function forbidden(message: string): AppException {
  return new AppException(
    403,
    ErrorCode.AUTH_INSUFFICIENT_PERMISSIONS,
    message,
  );
}

/**
 * ¿Puede el personal de plataforma operar en una ruta de bodega? (contrato O0
 * §6, OP-07): SUPERADMIN, ADMIN y OPERATIONS leen y escriben; SUPPORT solo lee.
 */
export function platformCanOperateOnWinery(
  role: string | null,
  method: string | undefined,
): boolean {
  const allowed: readonly PlatformRole[] = isReadMethod(method)
    ? PLATFORM_WINERY_READERS
    : PLATFORM_WINERY_OPERATORS;
  return role !== null && (allowed as readonly string[]).includes(role);
}

/**
 * Guard global de autorización (contrato O0 §6). Evalúa, contra la
 * organización activa de la sesión, `@Audience()`, `@OrgType()` y `@Roles()`;
 * y `@RequireActiveOrg()` (SE-05: aviso en la Ola 0, 403 `ORG_NOT_ACTIVE` con
 * `FEATURE_ENFORCE_ACTIVE_ORG=true`).
 */
@Injectable()
export class AuthorizationGuard implements CanActivate {
  private readonly logger = new Logger(AuthorizationGuard.name);

  constructor(
    private readonly reflector: Reflector,
    @Inject(SESSION_SETTINGS) private readonly settings: SessionSettings,
  ) {}

  private meta<T>(key: string, context: ExecutionContext): T | undefined {
    return this.reflector.getAllAndOverride<T>(key, [
      context.getHandler(),
      context.getClass(),
    ]);
  }

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') {
      return true;
    }
    if (this.meta<boolean>(IS_PUBLIC_KEY, context)) {
      return true;
    }
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser }>();
    const user = request.user;
    if (!user) {
      throw forbidden('Acceso denegado');
    }

    const audiences = this.meta<Audience[]>(AUDIENCE_KEY, context);
    if (audiences?.length && !audiences.includes(user.audience)) {
      throw forbidden(`Requiere audiencia ${audiences.join(' o ')}`);
    }

    const orgTypes = this.meta<OrganizationType[]>(ORG_TYPES_KEY, context);
    const roles = this.meta<MembershipRole[]>(ROLES_KEY, context);

    if (orgTypes?.length) {
      const activeType = user.organizationType;
      if (activeType && orgTypes.includes(activeType)) {
        this.checkRoles(user, roles);
      } else if (
        orgTypes.includes('WINERY') &&
        activeType === 'PLATFORM' &&
        platformCanOperateOnWinery(user.role, request.method)
      ) {
        // Plataforma sobre una bodega: la bodega la resuelve el TenantGuard
      } else {
        throw forbidden(
          `Requiere una organización activa de tipo ${orgTypes.join(' o ')}${
            orgTypes.includes('WINERY') && activeType === 'PLATFORM'
              ? ' (o un rol de plataforma que pueda operar sobre bodegas)'
              : ''
          }`,
        );
      }
    } else {
      this.checkRoles(user, roles);
    }

    const requireActive = this.meta<{ allow?: readonly string[] } | boolean>(
      REQUIRE_ACTIVE_ORG_KEY,
      context,
    );
    const allowedStatuses =
      typeof requireActive === 'object' ? (requireActive.allow ?? []) : [];
    if (
      requireActive &&
      user.organizationType === 'WINERY' &&
      user.organizationStatus !== 'ACTIVE' &&
      !allowedStatuses.includes(user.organizationStatus ?? '')
    ) {
      if (this.settings.enforceActiveOrganization) {
        throw new AppException(
          403,
          ErrorCode.ORG_NOT_ACTIVE,
          'La bodega activa no está habilitada para operar el ERP',
          [{ field: null, message: user.organizationStatus ?? 'UNKNOWN' }],
        );
      }
      this.logger.warn(
        `SE-05: ${request.method} ${request.originalUrl ?? request.url} con la bodega ${user.organizationId} en estado ${user.organizationStatus} (se permitirá hasta la Ola 1)`,
      );
    }
    return true;
  }

  private checkRoles(
    user: AuthenticatedUser,
    roles: MembershipRole[] | undefined,
  ): void {
    if (!roles?.length) {
      return;
    }
    if (!user.role || !(roles as string[]).includes(user.role)) {
      throw forbidden(
        `Acceso denegado: el rol '${user.role ?? 'ninguno'}' no tiene los permisos necesarios`,
      );
    }
  }
}
