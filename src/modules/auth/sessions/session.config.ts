import { ConfigService } from '@nestjs/config';

/** Acceso de 15 min (contrato O0 §5): tope aunque `JWT_EXPIRES_IN` pida más. */
export const MAX_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const DEFAULT_REFRESH_GRACE_SECONDS = 20;
export const DEFAULT_SESSION_TTL_STAFF_DAYS = 7;
export const DEFAULT_SESSION_TTL_CONSUMER_DAYS = 30;

export interface SessionSettings {
  /** Vida del token de acceso en segundos (≤ 900). */
  accessTokenTtlSeconds: number;
  /** Vida deslizante de la renovación del personal (7 días). */
  staffSessionTtlSeconds: number;
  /** Vida deslizante de la renovación de los consumidores (30 días). */
  consumerSessionTtlSeconds: number;
  /** Ventana en la que un refresco recién rotado devuelve el mismo par nuevo. */
  refreshGraceSeconds: number;
  /** `NODE_ENV`: sin `Secure` en la cookie solo en desarrollo con localhost. */
  nodeEnv: string;
  /** SE-05: 403 ORG_NOT_ACTIVE en el ERP con la bodega no ACTIVE (Ola 1). */
  enforceActiveOrganization: boolean;
}

/**
 * Convierte `900`, `900s`, `15m`, `1h` o `7d` en segundos. Devuelve `null`
 * si el formato no se reconoce.
 */
export function parseDurationSeconds(
  raw: string | number | undefined | null,
): number | null {
  if (raw === undefined || raw === null || raw === '') {
    return null;
  }
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null;
  }
  const match = /^(\d+)\s*(ms|s|m|h|d)?$/i.exec(raw.trim());
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  const unit = (match[2] ?? 's').toLowerCase();
  const factor: Record<string, number> = {
    ms: 0.001,
    s: 1,
    m: 60,
    h: 3600,
    d: 86400,
  };
  const seconds = Math.floor(value * factor[unit]);
  return seconds > 0 ? seconds : null;
}

function positiveNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function isTrue(value: unknown): boolean {
  return String(value ?? '').toLowerCase() === 'true';
}

export function sessionSettingsFromConfig(
  config: ConfigService,
): SessionSettings {
  const configuredAccess = parseDurationSeconds(
    config.get<string>('JWT_EXPIRES_IN'),
  );
  return {
    accessTokenTtlSeconds: Math.min(
      configuredAccess ?? MAX_ACCESS_TOKEN_TTL_SECONDS,
      MAX_ACCESS_TOKEN_TTL_SECONDS,
    ),
    staffSessionTtlSeconds:
      positiveNumber(
        config.get('SESSION_TTL_STAFF_DAYS'),
        DEFAULT_SESSION_TTL_STAFF_DAYS,
      ) * 86400,
    consumerSessionTtlSeconds:
      positiveNumber(
        config.get('SESSION_TTL_CONSUMER_DAYS'),
        DEFAULT_SESSION_TTL_CONSUMER_DAYS,
      ) * 86400,
    refreshGraceSeconds: positiveNumber(
      config.get('REFRESH_GRACE_SECONDS'),
      DEFAULT_REFRESH_GRACE_SECONDS,
    ),
    nodeEnv: config.get<string>('NODE_ENV') ?? 'development',
    enforceActiveOrganization: isTrue(config.get('FEATURE_ENFORCE_ACTIVE_ORG')),
  };
}

export const SESSION_SETTINGS = Symbol('SESSION_SETTINGS');
