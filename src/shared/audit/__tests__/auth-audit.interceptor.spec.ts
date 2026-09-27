import {
  CallHandler,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { AuthAuditInterceptor } from '../auth-audit.interceptor';
import type { AuditService } from '../audit.service';
import { AppException } from '@shared/exceptions/app.exception';

function httpContext(req: Record<string, unknown>): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe('AuthAuditInterceptor', () => {
  const audit = { recordStandalone: jest.fn().mockResolvedValue({}) };
  const interceptor = new AuthAuditInterceptor(
    audit as unknown as AuditService,
  );

  beforeEach(() => jest.clearAllMocks());

  it('registra el inicio de sesión correcto con la persona', async () => {
    const next: CallHandler = {
      handle: () => of({ user: { id: 'u-1', fullName: 'Ana' } }),
    };
    const result = await lastValueFrom(
      interceptor.intercept(
        httpContext({
          method: 'POST',
          originalUrl: '/v1/auth/login',
          body: { email: ' Ana@Test.BO ', password: 'secreto' },
        }),
        next,
      ),
    );
    expect(result).toEqual({ user: { id: 'u-1', fullName: 'Ana' } });
    expect(audit.recordStandalone).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'AUTH_LOGIN_SUCCEEDED',
        resource: { type: 'user', id: 'u-1' },
        actor: { userId: 'u-1', fullName: 'Ana' },
        after: { email: 'ana@test.bo' },
      }),
    );
    // La contraseña nunca llega a la bitácora
    expect(JSON.stringify(audit.recordStandalone.mock.calls)).not.toContain(
      'secreto',
    );
  });

  it('registra el fallo 401 y devuelve el mismo error', async () => {
    const error = new UnauthorizedException('Credenciales de acceso inválidas');
    const next: CallHandler = { handle: () => throwError(() => error) };
    await expect(
      lastValueFrom(
        interceptor.intercept(
          httpContext({
            method: 'POST',
            originalUrl: '/v1/auth/login',
            body: { email: 'x@test.bo', password: 'mala' },
          }),
          next,
        ),
      ),
    ).rejects.toBe(error);
    expect(audit.recordStandalone).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'AUTH_LOGIN_FAILED',
        actor: { userId: null },
        after: { email: 'x@test.bo', status: 401 },
      }),
    );
  });

  it('también registra los 401 de AppException (sin HttpException)', async () => {
    const error = new AppException(401, 'AUTH_INVALID_CREDENTIALS', 'x');
    await expect(
      lastValueFrom(
        interceptor.intercept(
          httpContext({
            method: 'POST',
            originalUrl: '/v1/auth/login',
            body: { email: 'y@test.bo' },
          }),
          { handle: () => throwError(() => error) },
        ),
      ),
    ).rejects.toBe(error);
    expect(audit.recordStandalone).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'AUTH_LOGIN_FAILED',
        after: { email: 'y@test.bo', status: 401 },
      }),
    );
  });

  it('no registra otras rutas ni errores de validación', async () => {
    await lastValueFrom(
      interceptor.intercept(
        httpContext({ method: 'GET', originalUrl: '/v1/health' }),
        { handle: () => of({}) },
      ),
    );
    const validation = Object.assign(new Error('x'), { status: 422 });
    await expect(
      lastValueFrom(
        interceptor.intercept(
          httpContext({ method: 'POST', originalUrl: '/v1/auth/login' }),
          { handle: () => throwError(() => validation) },
        ),
      ),
    ).rejects.toBe(validation);
    expect(audit.recordStandalone).not.toHaveBeenCalled();
  });

  it('si la bitácora falla, el login responde igual', async () => {
    audit.recordStandalone.mockRejectedValueOnce(new Error('db caída'));
    const result = await lastValueFrom(
      interceptor.intercept(
        httpContext({
          method: 'POST',
          originalUrl: '/v1/auth/login',
          body: { email: 'a@b.bo' },
        }),
        { handle: () => of({ user: { id: 'u-2' } }) },
      ),
    );
    expect(result).toEqual({ user: { id: 'u-2' } });
  });
});
