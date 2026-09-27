import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { OrganizationTypeEnum } from '@prisma/client';
import { PrismaService } from '@shared/prisma/prisma.service';
import { AppException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';
import { ValidationException } from '@shared/exceptions/validation.exception';
import type { AuthenticatedUser } from '@shared/decorators/current-user.decorator';
import type { OrganizationType } from '@modules/organizations/organization.constants';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ORG_TYPES_KEY } from '../decorators/authorization.decorators';
import { isReadMethod } from './authorization.guard';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type TenantRequest = Request & {
  user?: AuthenticatedUser;
  tenantId?: string | null;
};

function firstString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }
  return undefined;
}

/**
 * Bodega sobre la que trabaja una ruta `@OrgType('WINERY')` (`request.tenantId`,
 * que lee `@TenantId()`):
 *
 * - Bodega activa: esa. Si la petición apunta a otra (`wineryId` en la ruta,
 *   la query o el cuerpo) → 404, nunca 403 (no se revela que existe).
 * - Plataforma: la de `?wineryId=` (o `:wineryId`). Las lecturas pueden ir sin
 *   ella (todas las bodegas); las escrituras la exigen → 422 con
 *   `details[{ field: 'wineryId' }]` (OP-07). Una bodega inexistente → 404
 *   `ORG_NOT_FOUND`.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      return true;
    }
    const orgTypes = this.reflector.getAllAndOverride<OrganizationType[]>(
      ORG_TYPES_KEY,
      targets,
    );
    if (!orgTypes?.includes('WINERY')) {
      return true;
    }

    const request = context.switchToHttp().getRequest<TenantRequest>();
    const user = request.user;
    if (!user) {
      return true;
    }
    const params = request.params ?? {};
    const query = (request.query ?? {}) as Record<string, unknown>;
    const body = (request.body ?? {}) as Record<string, unknown>;

    if (user.organizationType === 'WINERY') {
      const target =
        firstString(params.wineryId) ??
        firstString(query.wineryId) ??
        firstString(body.wineryId);
      if (target && target !== user.organizationId) {
        throw new AppException(
          404,
          ErrorCode.NOT_FOUND,
          'Recurso no encontrado',
        );
      }
      request.tenantId = user.organizationId;
      return true;
    }

    if (user.organizationType === 'PLATFORM') {
      const wineryId =
        firstString(params.wineryId) ?? firstString(query.wineryId);
      if (!wineryId) {
        if (!isReadMethod(request.method)) {
          throw ValidationException.forField(
            'wineryId',
            'El personal de plataforma debe indicar la bodega (?wineryId=) en las escrituras',
          );
        }
        request.tenantId = null;
        return true;
      }
      if (!UUID_RE.test(wineryId)) {
        throw ValidationException.forField(
          'wineryId',
          'wineryId debe ser un UUID',
        );
      }
      const organization = await this.prisma.organization.findFirst({
        where: { id: wineryId, type: OrganizationTypeEnum.WINERY },
        select: { id: true },
      });
      if (!organization) {
        throw new AppException(
          404,
          ErrorCode.ORG_NOT_FOUND,
          'Bodega no encontrada',
        );
      }
      request.tenantId = wineryId;
      return true;
    }

    // El AuthorizationGuard ya rechazó cualquier otro caso
    request.tenantId = null;
    return true;
  }
}
