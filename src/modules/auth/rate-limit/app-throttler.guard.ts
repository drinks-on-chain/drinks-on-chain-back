import { ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ThrottlerException,
  ThrottlerGuard,
  ThrottlerLimitDetail,
  ThrottlerModuleOptions,
} from '@nestjs/throttler';
import type { Response } from 'express';

/** Límite global por IP real (todas las rutas juntas). */
export const GLOBAL_THROTTLER = 'global';
/** Límite de las rutas de `/auth/*` (por ruta e IP; se ajusta con `@Throttle`). */
export const AUTH_THROTTLER = 'auth';

export const DEFAULT_RATE_LIMITS = {
  globalPerMinute: 300,
  authPerMinute: 20,
  loginPerMinute: 10,
  signupPerMinute: 5,
  refreshPerMinute: 30,
} as const;

function positiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Límite por minuto de una ruta de autenticación (variable de entorno o por defecto). */
export function authRouteLimit(
  envName: string,
  fallback: number,
): () => number {
  return () => positiveInt(process.env[envName], fallback);
}

/**
 * Controladores con el límite de `/auth/*` (por IP y ruta): sesión, cuenta,
 * segundo factor y las rutas públicas de invitaciones (tokens).
 */
export const AUTH_RATE_LIMITED_CONTROLLERS: ReadonlySet<string> = new Set([
  'AuthController',
  'AccountController',
  'MfaController',
  'PublicInvitationsController',
]);

const isAuthRoute = (context: ExecutionContext): boolean =>
  AUTH_RATE_LIMITED_CONTROLLERS.has(context.getClass().name);

/**
 * Límites de peticiones (SE-06, IAM-07). La IP es la real (`request.ip` con
 * `trust proxy`, ver `configureApp`):
 * - `global`: `RATE_LIMIT_GLOBAL_PER_MINUTE` (300) por IP para toda la API;
 * - `auth`: `RATE_LIMIT_AUTH_PER_MINUTE` (20) por IP y ruta de `/auth/*`, con
 *   límites propios en login, signup y refresh (`@Throttle`).
 */
export function throttlerOptionsFromConfig(
  config: ConfigService,
): ThrottlerModuleOptions {
  return {
    throttlers: [
      {
        name: GLOBAL_THROTTLER,
        ttl: 60_000,
        limit: positiveInt(
          config.get('RATE_LIMIT_GLOBAL_PER_MINUTE'),
          DEFAULT_RATE_LIMITS.globalPerMinute,
        ),
        // Un solo contador por IP para todas las rutas
        generateKey: (_context, tracker, name) => `${name}:${tracker}`,
      },
      {
        name: AUTH_THROTTLER,
        ttl: 60_000,
        limit: positiveInt(
          config.get('RATE_LIMIT_AUTH_PER_MINUTE'),
          DEFAULT_RATE_LIMITS.authPerMinute,
        ),
        skipIf: (context) => !isAuthRoute(context),
      },
    ],
  };
}

/**
 * `ThrottlerGuard` global con `Retry-After` estándar (el de la librería añade
 * el nombre del límite al nombre de la cabecera).
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    const response = context.switchToHttp().getResponse<Response>();
    response.setHeader(
      'Retry-After',
      String(Math.max(1, Math.ceil(detail.timeToBlockExpire))),
    );
    throw new ThrottlerException(await this.getErrorMessage(context, detail));
  }

  protected async shouldSkip(context: ExecutionContext): Promise<boolean> {
    return context.getType() !== 'http';
  }
}
