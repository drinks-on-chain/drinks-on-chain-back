import {
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';

export const TenantId = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest();
    const tenantId = request.tenantId || request.user?.wineryId;

    if (!tenantId) {
      throw new ForbiddenException(
        'Tenant context (wineryId) is required for this operation',
      );
    }

    return tenantId as string;
  },
);
