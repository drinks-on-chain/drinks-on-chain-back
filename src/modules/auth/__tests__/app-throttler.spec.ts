import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { ThrottlerOptions } from '@nestjs/throttler';
import {
  AUTH_THROTTLER,
  GLOBAL_THROTTLER,
  PASSPORT_THROTTLER,
  PUBLIC_WINERIES_THROTTLER,
  throttlerOptionsFromConfig,
} from '../rate-limit/app-throttler.guard';

function options(env: Record<string, string> = {}): ThrottlerOptions[] {
  const config = { get: (key: string) => env[key] } as unknown as ConfigService;
  const result = throttlerOptionsFromConfig(config);
  return Array.isArray(result) ? result : result.throttlers;
}

const contextOf = (controller: string, handler = 'handler') =>
  ({
    getClass: () => ({ name: controller }),
    getHandler: () => ({ name: handler }),
  }) as unknown as ExecutionContext;

const named = (list: ThrottlerOptions[], name: string) => {
  const found = list.find((t) => t.name === name);
  if (!found) throw new Error(`Sin límite ${name}`);
  return found;
};

const skips = (throttler: ThrottlerOptions, controller: string) =>
  throttler.skipIf?.(contextOf(controller)) ?? false;

describe('límites de peticiones (SE-06, IAM-07, PUB-05)', () => {
  it('cuatro límites por minuto: global, auth, pasaporte y perfiles públicos', () => {
    const list = options();
    expect(list.map((t) => [t.name, t.limit, t.ttl])).toEqual([
      [GLOBAL_THROTTLER, 300, 60_000],
      [AUTH_THROTTLER, 20, 60_000],
      [PASSPORT_THROTTLER, 60, 60_000],
      [PUBLIC_WINERIES_THROTTLER, 120, 60_000],
    ]);
  });

  it('pasaporte: 60/min por IP solo en sus rutas, con un contador común (contrato O2 §12.4)', () => {
    const passport = named(options(), PASSPORT_THROTTLER);
    expect(skips(passport, 'PublicPassportsController')).toBe(false);
    for (const other of [
      'LotsController',
      'PublicWineriesController',
      'AuthController',
      'LotViewsController',
    ]) {
      expect(skips(passport, other)).toBe(true);
    }
    // La misma clave para todas las rutas del pasaporte: no se reparte la enumeración entre ellas
    const key = (handler: string) =>
      passport.generateKey?.(
        contextOf('PublicPassportsController', handler),
        '203.0.113.7',
        PASSPORT_THROTTLER,
      );
    expect(key('passport')).toBe('passport:203.0.113.7');
    expect(key('bottle')).toBe(key('lot'));
  });

  it('perfiles públicos de bodegas: 120/min por IP en el directorio y en el perfil', () => {
    const wineries = named(options(), PUBLIC_WINERIES_THROTTLER);
    expect(skips(wineries, 'PublicWineriesController')).toBe(false);
    expect(skips(wineries, 'PublicWineriesDirectoryController')).toBe(false);
    expect(skips(wineries, 'PublicPassportsController')).toBe(true);
    expect(skips(wineries, 'WineryManagementController')).toBe(true);
  });

  it('el límite de auth sigue solo en sus controladores', () => {
    const auth = named(options(), AUTH_THROTTLER);
    expect(skips(auth, 'AuthController')).toBe(false);
    expect(skips(auth, 'PublicPassportsController')).toBe(true);
  });

  it('se ajustan por entorno; un valor inválido deja el de por defecto', () => {
    const list = options({
      RATE_LIMIT_PASSPORT_PER_MINUTE: '5',
      RATE_LIMIT_PUBLIC_WINERIES_PER_MINUTE: 'muchas',
      RATE_LIMIT_GLOBAL_PER_MINUTE: '0',
    });
    expect(named(list, PASSPORT_THROTTLER).limit).toBe(5);
    expect(named(list, PUBLIC_WINERIES_THROTTLER).limit).toBe(120);
    expect(named(list, GLOBAL_THROTTLER).limit).toBe(300);
  });
});
