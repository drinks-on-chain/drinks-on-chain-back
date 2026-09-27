import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AppException } from '../exceptions/app.exception';
import { ErrorCode } from '../exceptions/error-codes';

/**
 * Bodega de la petición, resuelta por el `TenantGuard` en las rutas
 * `@OrgType('WINERY')`: la bodega activa, o la de `?wineryId=` si quien llama
 * es personal de plataforma. `undefined` solo en lecturas de plataforma sin
 * `?wineryId=` (todas las bodegas).
 */
export const TenantId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => {
    const request = ctx.switchToHttp().getRequest<{
      tenantId?: string | null;
      user?: { organizationType?: string | null };
    }>();
    if (request.tenantId) {
      return request.tenantId;
    }
    if (request.user?.organizationType === 'PLATFORM') {
      return undefined;
    }
    throw new AppException(
      403,
      ErrorCode.AUTH_INSUFFICIENT_PERMISSIONS,
      'Esta operación requiere una bodega activa',
    );
  },
);
