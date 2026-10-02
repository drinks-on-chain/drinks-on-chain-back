/**
 * Límites y captcha de la lista de espera (contrato O1b §1). Se leen del
 * entorno en cada petición (como los límites por minuto de `/auth/*`), con
 * estos valores por defecto, pensados para un evento donde mucha gente
 * comparte la misma red.
 */
export const WAITLIST_DEFAULTS = {
  /** Inscripciones por minuto e IP real (`WAITLIST_LIMIT_IP_MINUTE`). */
  ipPerMinute: 20,
  /** Inscripciones por hora e IP real (`WAITLIST_LIMIT_IP_HOUR`). */
  ipPerHour: 300,
  /** Inscripciones por hora y correo (`WAITLIST_LIMIT_EMAIL_HOUR`). */
  emailPerHour: 3,
} as const;

export interface WaitlistConfig {
  ipPerMinute: number;
  ipPerHour: number;
  emailPerHour: number;
  /** `WAITLIST_CAPTCHA_REQUIRED=true`: se exige `captchaToken` válido. */
  captchaRequired: boolean;
}

function positiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function waitlistConfig(
  env: Record<string, string | undefined> = process.env,
): WaitlistConfig {
  return {
    ipPerMinute: positiveInt(
      env.WAITLIST_LIMIT_IP_MINUTE,
      WAITLIST_DEFAULTS.ipPerMinute,
    ),
    ipPerHour: positiveInt(
      env.WAITLIST_LIMIT_IP_HOUR,
      WAITLIST_DEFAULTS.ipPerHour,
    ),
    emailPerHour: positiveInt(
      env.WAITLIST_LIMIT_EMAIL_HOUR,
      WAITLIST_DEFAULTS.emailPerHour,
    ),
    captchaRequired:
      (env.WAITLIST_CAPTCHA_REQUIRED ?? '').trim().toLowerCase() === 'true',
  };
}
