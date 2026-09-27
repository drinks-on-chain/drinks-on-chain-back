import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import {
  RequestContext,
  getRequestContext,
  identityFromUser,
  setRequestContext,
} from './request-context';

/**
 * Completa el contexto de la petición con la identidad que dejó la validación
 * del token en `request.user`. Los interceptores corren después de los
 * guardias, así que aquí el token ya está validado. Solo rellena lo que siga
 * vacío: si un guardia ya puso la sesión en el contexto, manda la suya.
 */
@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const store = getRequestContext();
    if (store && context.getType() === 'http') {
      const request = context.switchToHttp().getRequest<{ user?: unknown }>();
      const identity = identityFromUser(request.user);
      if (identity) {
        const patch: Partial<RequestContext> = {};
        for (const [key, value] of Object.entries(identity)) {
          const k = key as keyof RequestContext;
          if ((store[k] === null || store[k] === undefined) && value !== null) {
            (patch as Record<string, unknown>)[k] = value;
          }
        }
        setRequestContext(patch);
      }
    }
    return next.handle();
  }
}
