import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { identityFromUser, updateRequestContext } from './request-context';

/**
 * Completa el contexto de la petición con la identidad que dejó la estrategia
 * JWT en `request.user`. Los interceptores corren después de los guardias,
 * así que aquí el token ya está validado.
 */
@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() === 'http') {
      const request = context.switchToHttp().getRequest<{ user?: unknown }>();
      const identity = identityFromUser(request.user);
      if (identity) updateRequestContext(identity);
    }
    return next.handle();
  }
}
