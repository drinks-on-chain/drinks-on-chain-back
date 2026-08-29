import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AsyncLocalStorage } from 'async_hooks';

export const correlationLocalStorage = new AsyncLocalStorage<Map<string, string>>();

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

    correlationLocalStorage.run(store, () => {
      next();
    });
  }

  static getCorrelationId(): string | undefined {
    const store = correlationLocalStorage.getStore();
    return store?.get('correlationId');
  }
}
