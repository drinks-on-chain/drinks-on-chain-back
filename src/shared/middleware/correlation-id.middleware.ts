import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AsyncLocalStorage } from 'async_hooks';
import { runWithRequestContext } from '../context/request-context';

export const correlationLocalStorage = new AsyncLocalStorage<
  Map<string, string>
>();

export const CORRELATION_ID_HEADER = 'x-correlation-id';

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const rawHeader = req.headers[CORRELATION_ID_HEADER];
    const correlationId =
      typeof rawHeader === 'string' && rawHeader.trim().length > 0
        ? rawHeader.trim()
        : uuidv4();

    res.setHeader(CORRELATION_ID_HEADER, correlationId);

    const store = new Map<string, string>();
    store.set('correlationId', correlationId);

    const clientApp = req.headers['x-client-app'];
    correlationLocalStorage.run(store, () => {
      // Contexto de la petición (src/shared/context/request-context.ts): el
      // guard de acceso lo completa con la sesión.
      runWithRequestContext(
        {
          correlationId,
          ip: req.ip ?? null,
          clientApp:
            typeof clientApp === 'string' && clientApp.trim().length > 0
              ? clientApp.trim().slice(0, 50)
              : null,
        },
        () => next(),
      );
    });
  }

  static getCorrelationId(): string | undefined {
    const store = correlationLocalStorage.getStore();
    return store?.get('correlationId');
  }
}
