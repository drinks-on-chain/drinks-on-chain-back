import {
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { UserRoleEnum } from '@prisma/client';

export const TenantId = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): string | undefined => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user;
    const isPlatformAdmin = user?.userRole === UserRoleEnum.PLATFORM_ADMIN;

    const tenantId =
      request.tenantId ||
      request.query?.wineryId ||
      request.params?.wineryId ||
      user?.wineryId;

    if (!tenantId) {
      if (isPlatformAdmin) {
        return undefined;
      }
      throw new ForbiddenException(
        'Tenant context (wineryId) is required for this operation',
      );
    }

    return tenantId as string;
  },
);
