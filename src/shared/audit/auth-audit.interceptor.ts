import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, from, throwError } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';
import { Request } from 'express';
import { AuditService } from './audit.service';
import { AuditAction } from './audit.actions';

/** Rutas de seguridad que se registran sin tocar el módulo de autenticación. */
const LOGIN_ROUTE = /^\/v1\/auth\/login\/?(\?.*)?$/;

function loggedUser(
  result: unknown,
): { id: string; fullName: string | null } | null {
  if (typeof result !== 'object' || result === null) return null;
  // Con o sin el envoltorio { success, data } según el orden de interceptores
  const body = result as { user?: unknown; data?: { user?: unknown } };
  const user = body.user ?? body.data?.user;
  if (typeof user !== 'object' || user === null) return null;
  const { id, fullName } = user as { id?: unknown; fullName?: unknown };
  if (typeof id !== 'string') return null;
  return { id, fullName: typeof fullName === 'string' ? fullName : null };
}

/** Estado HTTP de un error (HttpException de Nest o AppException propia). */
function statusOf(error: unknown): number | undefined {
  if (error instanceof HttpException) return error.getStatus();
  if (typeof error === 'object' && error !== null) {
    const e = error as { statusCode?: unknown; status?: unknown };
    if (typeof e.statusCode === 'number') return e.statusCode;
    if (typeof e.status === 'number') return e.status;
  }
  return undefined;
}

/**
 * Inicio de sesión correcto y fallido en la bitácora (docs-back/07 §4.1,
 * "Seguridad"), observando `POST /v1/auth/login` desde fuera del módulo de
 * autenticación. Cada intento abre su propia transacción: el login no tiene
 * otra escritura con la que agruparlo.
 *
 * Si el módulo de sesiones pasa a registrar estos eventos él mismo (con
 * `AuditService.record` dentro de su transacción), basta con quitar este
 * interceptor de `AuditModule`.
 *
 * Un fallo al escribir la entrada no cambia la respuesta del login: se
 * registra en el log con nivel `error`.
 */
@Injectable()
export class AuthAuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuthAuditInterceptor.name);

  constructor(private readonly audit: AuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<Request>();
    const path = request.originalUrl || request.url || '';
    if (request.method !== 'POST' || !LOGIN_ROUTE.test(path)) {
      return next.handle();
    }
    const body = (request.body ?? {}) as { email?: unknown };
    const email =
      typeof body.email === 'string'
        ? body.email.toLowerCase().trim().slice(0, 255)
        : null;

    return next.handle().pipe(
      mergeMap((result) => {
        const user = loggedUser(result);
        return from(
          this.safeRecord(() =>
            this.audit.recordStandalone({
              action: AuditAction.AUTH_LOGIN_SUCCEEDED,
              resource: { type: 'user', id: user?.id ?? null },
              actor: user
                ? { userId: user.id, fullName: user.fullName }
                : undefined,
              organizationId: null,
              after: { email },
            }),
          ).then(() => result),
        );
      }),
      catchError((error: unknown) => {
        const status = statusOf(error);
        // Solo credenciales rechazadas; los 422/429 no son intentos válidos
        if (status !== 401 && status !== 403) {
          return throwError(() => error);
        }
        return from(
          this.safeRecord(() =>
            this.audit.recordStandalone({
              action: AuditAction.AUTH_LOGIN_FAILED,
              resource: { type: 'user', id: null },
              actor: { userId: null },
              after: { email, status },
            }),
          ),
        ).pipe(mergeMap(() => throwError(() => error)));
      }),
    );
  }

  private async safeRecord(write: () => Promise<unknown>): Promise<void> {
    try {
      await write();
    } catch (error) {
      this.logger.error({
        message: 'No se pudo registrar el inicio de sesión en la bitácora',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
