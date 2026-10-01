import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of } from 'rxjs';
import {
  DEPRECATED_ROUTE_KEY,
  DeprecatedRouteInterceptor,
} from '../deprecated-route.decorator';

function context(replacement: string | undefined) {
  const headers: Record<string, string> = {};
  const handler = () => undefined;
  if (replacement)
    Reflect.defineMetadata(DEPRECATED_ROUTE_KEY, replacement, handler);
  const ctx = {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({
      getRequest: () => ({
        method: 'POST',
        url: '/v1/wineries',
        user: { id: 'u-1' },
      }),
      getResponse: () => ({
        setHeader: (name: string, value: string) => (headers[name] = value),
      }),
    }),
  } as unknown as ExecutionContext;
  return { ctx, headers };
}

describe('rutas obsoletas (H1, contrato O1 §11)', () => {
  const interceptor = new DeprecatedRouteInterceptor(new Reflector());

  it('avisa en los logs y responde Deprecation y Link a la sustituta', () => {
    const warn = jest
      .spyOn(interceptor['logger'], 'warn')
      .mockImplementation(() => undefined);
    const { ctx, headers } = context('/v1/public/winery-applications');
    interceptor.intercept(ctx, { handle: () => of(null) });
    expect(headers).toEqual({
      Deprecation: 'true',
      Link: '</v1/public/winery-applications>; rel="successor-version"',
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('POST /v1/wineries'),
    );
  });

  it('sin la marca no hace nada', () => {
    const { ctx, headers } = context(undefined);
    interceptor.intercept(ctx, { handle: () => of(null) });
    expect(headers).toEqual({});
  });
});
