import {
  Injectable,
  CanActivate,
  ExecutionContext,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRoleEnum } from '@prisma/client';
import { SKIP_TENANT_KEY } from '../decorators/skip-tenant.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const isSkipped = this.reflector.getAllAndOverride<boolean>(
      SKIP_TENANT_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (isSkipped) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      return true;
    }

    // PLATFORM_ADMIN tiene acceso global a todos los inquilinos
    if (user.userRole === UserRoleEnum.PLATFORM_ADMIN) {
      request.tenantId =
        request.query?.wineryId ||
        request.params?.wineryId ||
        user.wineryId ||
        null;
      return true;
    }

    // Extraer wineryId objetivo desde params, query o body si se especifica
    const targetWineryId =
      request.params?.wineryId ||
      request.query?.wineryId ||
      request.body?.wineryId;

    // Si el endpoint apunta a un recurso de bodega específico y no coincide con el tenant del usuario
    if (targetWineryId && user.wineryId && targetWineryId !== user.wineryId) {
      // Regla de Seguridad por Oscuridad: Responder 404 para no revelar existencia del recurso
      throw new NotFoundException('Recurso no encontrado');
    }

    // Inyectar el tenantId en el request para uso en controladores y servicios
    request.tenantId = user.wineryId ?? null;

    return true;
  }
}
