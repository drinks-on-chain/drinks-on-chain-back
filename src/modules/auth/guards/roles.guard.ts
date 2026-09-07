import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRoleEnum } from '@prisma/client';
import { ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRoleEnum[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest();

    if (!user || !user.userRole) {
      throw new ForbiddenException(
        'Acceso denegado: Usuario no autenticado o sin rol asignado',
      );
    }

    // El administrador de la plataforma tiene acceso irrestricto
    if (user.userRole === UserRoleEnum.PLATFORM_ADMIN) {
      return true;
    }

    const hasRole = requiredRoles.includes(user.userRole);

    if (!hasRole) {
      throw new ForbiddenException(
        `Acceso denegado: El rol '${user.userRole}' no tiene los permisos necesarios`,
      );
    }

    return true;
  }
}
