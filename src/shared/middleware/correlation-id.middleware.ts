import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  CLIENT_APP_HEADER,
  getRequestContext,
  parseClientApp,
  runWithRequestContext,
} from '../context/request-context';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

/** Un identificador de correlación válido: corto y sin caracteres de control. */
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;

/**
 * Crea el contexto de la petición (`src/shared/context/request-context.ts`)
 * con el `X-Correlation-ID` recibido (o uno nuevo), la IP y la app de origen
 * (`X-Client-App`), y devuelve el identificador en la respuesta. La identidad
 * la completa `RequestContextInterceptor` tras los guardias.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const rawHeader = req.headers[CORRELATION_ID_HEADER];
    const candidate = typeof rawHeader === 'string' ? rawHeader.trim() : '';
    const correlationId = CORRELATION_ID_PATTERN.test(candidate)
      ? candidate
      : uuidv4();

    res.setHeader(CORRELATION_ID_HEADER, correlationId);

    runWithRequestContext(
      {
        correlationId,
        ip: req.ip ?? req.socket?.remoteAddress ?? null,
        clientApp: parseClientApp(req.headers[CLIENT_APP_HEADER]),
      },
      () => {
        next();
      },
    );
  }

  static getCorrelationId(): string | undefined {
    return getRequestContext()?.correlationId ?? undefined;
  }
}
