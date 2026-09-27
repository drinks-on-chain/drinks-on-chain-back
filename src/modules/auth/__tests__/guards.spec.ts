import {
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../guards/roles.guard';
import { TenantGuard } from '../guards/tenant.guard';
import { UserRoleEnum } from '@prisma/client';

describe('Auth Guards', () => {
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
  });

  describe('RolesGuard', () => {
    let guard: RolesGuard;

    beforeEach(() => {
      guard = new RolesGuard(reflector);
    });

    const createMockContext = (user: unknown): ExecutionContext =>
      ({
        getHandler: jest.fn(),
        getClass: jest.fn(),
        switchToHttp: () => ({
          getRequest: () => ({ user }),
        }),
      }) as unknown as ExecutionContext;

    it('debe permitir acceso si la ruta no requiere roles específicos', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(null);
      const context = createMockContext({ userRole: UserRoleEnum.CONSUMER });

      expect(guard.canActivate(context)).toBe(true);
    });

    it('debe permitir acceso a PLATFORM_ADMIN aun sin rol explícito', () => {
      jest
        .spyOn(reflector, 'getAllAndOverride')
        .mockReturnValue([UserRoleEnum.WINERY_ADMIN]);
      const context = createMockContext({
        userRole: UserRoleEnum.PLATFORM_ADMIN,
      });

      expect(guard.canActivate(context)).toBe(true);
    });

    it('debe permitir acceso si el usuario posee uno de los roles requeridos', () => {
      jest
        .spyOn(reflector, 'getAllAndOverride')
        .mockReturnValue([UserRoleEnum.ENOLOGIST, UserRoleEnum.WINERY_ADMIN]);
      const context = createMockContext({ userRole: UserRoleEnum.ENOLOGIST });

      expect(guard.canActivate(context)).toBe(true);
    });

    it('debe arrojar ForbiddenException si el rol no coincide', () => {
      jest
        .spyOn(reflector, 'getAllAndOverride')
        .mockReturnValue([UserRoleEnum.PLATFORM_ADMIN]);
      const context = createMockContext({ userRole: UserRoleEnum.CONSUMER });

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });
  });

  describe('TenantGuard', () => {
    let guard: TenantGuard;

    beforeEach(() => {
      guard = new TenantGuard(reflector);
    });

    const createMockContext = (
      user: unknown,
      params: Record<string, string> = {},
      // El flag público lo decide el mock de Reflector, no el contexto.
      _isPublic = false,
    ): ExecutionContext =>
      ({
        getHandler: jest.fn(),
        getClass: jest.fn(),
        switchToHttp: () => ({
          getRequest: () => ({
            user,
            params,
            query: {},
            body: {},
          }),
        }),
      }) as unknown as ExecutionContext;

    it('debe permitir acceso inmediato si la ruta es pública', () => {
      jest
        .spyOn(reflector, 'getAllAndOverride')
        .mockReturnValueOnce(true) // IS_PUBLIC_KEY
        .mockReturnValueOnce(false); // SKIP_TENANT_KEY

      const context = createMockContext(null, {}, true);
      expect(guard.canActivate(context)).toBe(true);
    });

    it('debe permitir acceso irrestricto a PLATFORM_ADMIN', () => {
      jest
        .spyOn(reflector, 'getAllAndOverride')
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(false);

      const context = createMockContext({
        userRole: UserRoleEnum.PLATFORM_ADMIN,
        wineryId: null,
      });
      expect(guard.canActivate(context)).toBe(true);
    });

    it('debe permitir acceso cuando el wineryId solicitado coincide con el del usuario', () => {
      jest
        .spyOn(reflector, 'getAllAndOverride')
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(false);

      const context = createMockContext(
        {
          userRole: UserRoleEnum.ENOLOGIST,
          wineryId: 'winery-123',
        },
        { wineryId: 'winery-123' },
      );

      expect(guard.canActivate(context)).toBe(true);
    });

    it('debe arrojar NotFoundException (Security by Obscurity) si el wineryId no coincide', () => {
      jest
        .spyOn(reflector, 'getAllAndOverride')
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(false);

      const context = createMockContext(
        {
          userRole: UserRoleEnum.ENOLOGIST,
          wineryId: 'winery-123',
        },
        { wineryId: 'winery-999' },
      );

      expect(() => guard.canActivate(context)).toThrow(NotFoundException);
    });
  });
});
