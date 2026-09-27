import type { Request, Response } from 'express';
import type { AuthResponseDto } from '../dto/auth-response.dto';
import { setRefreshCookie, useSecureCookie } from './refresh-cookie';
import type { SessionSettings } from './session.config';
import type { ClientInfo } from './sessions.service';

/** Sesión emitida: cuerpo de la respuesta y datos de la cookie `doc_rt`. */
export interface IssuedSession {
  body: AuthResponseDto;
  refreshToken: string;
  cookieMaxAgeSeconds: number;
}

/** Pone la cookie `doc_rt` de una sesión emitida y devuelve el cuerpo. */
export function respondWithSession(
  req: Request,
  res: Response,
  issued: IssuedSession,
  settings: Pick<SessionSettings, 'nodeEnv'>,
): AuthResponseDto {
  setRefreshCookie(
    res,
    issued.refreshToken,
    issued.cookieMaxAgeSeconds,
    useSecureCookie(settings.nodeEnv, req),
  );
  return issued.body;
}

/** IP real y agente de la petición (para la sesión y los retos). */
export function clientInfo(req: Request): ClientInfo {
  const agent = req.headers['user-agent'];
  return {
    ip: req.ip ?? null,
    userAgent: typeof agent === 'string' ? agent : null,
  };
}
