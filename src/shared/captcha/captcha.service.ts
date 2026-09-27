import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException } from '@shared/exceptions/app.exception';
import { ErrorCode } from '@shared/exceptions/error-codes';

/**
 * Claves secretas de prueba publicadas por Cloudflare
 * (https://developers.cloudflare.com/turnstile/troubleshooting/testing/).
 * Con ellas no se llama a Cloudflare: el resultado es el documentado, lo que
 * permite desarrollar y probar sin red.
 */
export const TURNSTILE_TEST_SECRETS = {
  ALWAYS_PASSES: '1x0000000000000000000000000000000AA',
  ALWAYS_FAILS: '2x0000000000000000000000000000000AA',
  TOKEN_ALREADY_SPENT: '3x0000000000000000000000000000000AA',
} as const;

export const TURNSTILE_VERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Los tokens de Turnstile miden hasta 2048 caracteres. */
export const MAX_CAPTCHA_TOKEN_LENGTH = 2048;

const VERIFY_TIMEOUT_MS = 5000;

interface SiteverifyResponse {
  success?: boolean;
  'error-codes'?: string[];
}

export type FetchLike = (
  url: string,
  init: { method: string; body: URLSearchParams; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export function captchaInvalid(): AppException {
  return new AppException(
    422,
    ErrorCode.CAPTCHA_INVALID,
    'No pudimos comprobar que eres una persona: vuelve a intentarlo',
    [{ field: 'captchaToken', message: 'El captcha no es válido o caducó' }],
  );
}

/**
 * Captcha de los formularios públicos (docs-back/07 §10, contrato O1 §0):
 * Cloudflare Turnstile. El frontend obtiene un token y aquí se comprueba con
 * `TURNSTILE_SECRET_KEY` antes de procesar nada.
 *
 * - Sin clave fuera de producción → la de prueba que siempre valida.
 * - En producción la clave es obligatoria (validación del entorno); si es una
 *   de prueba, se avisa al arrancar.
 * - Token rechazado → 422 `CAPTCHA_INVALID` en `captchaToken`; Cloudflare no
 *   responde → 503 `CAPTCHA_UNAVAILABLE` (nunca se deja pasar).
 */
@Injectable()
export class CaptchaService implements OnModuleInit {
  private readonly logger = new Logger(CaptchaService.name);
  private readonly secret: string;
  private readonly isProduction: boolean;
  private fetchImpl: FetchLike;

  constructor(config: ConfigService) {
    this.isProduction = config.get<string>('NODE_ENV') === 'production';
    const configured = config.get<string>('TURNSTILE_SECRET_KEY')?.trim();
    this.secret = configured || TURNSTILE_TEST_SECRETS.ALWAYS_PASSES;
    this.fetchImpl = (url, init) => fetch(url, init);
  }

  onModuleInit(): void {
    if (this.isTestSecret()) {
      const message =
        'TURNSTILE_SECRET_KEY es una clave de prueba de Cloudflare: el captcha no protege nada (solo desarrollo y pruebas)';
      if (this.isProduction) {
        this.logger.warn(message);
      } else {
        this.logger.log(message);
      }
    }
  }

  /** Para las pruebas: sustituye la llamada HTTP a Cloudflare. */
  useFetch(fetchImpl: FetchLike): void {
    this.fetchImpl = fetchImpl;
  }

  isTestSecret(): boolean {
    return (Object.values(TURNSTILE_TEST_SECRETS) as string[]).includes(
      this.secret,
    );
  }

  /** Comprueba el token; lanza 422 `CAPTCHA_INVALID` o 503 `CAPTCHA_UNAVAILABLE`. */
  async verify(token: string | null | undefined, ip: string | null) {
    if (
      typeof token !== 'string' ||
      token.trim().length === 0 ||
      token.length > MAX_CAPTCHA_TOKEN_LENGTH
    ) {
      throw captchaInvalid();
    }

    switch (this.secret) {
      case TURNSTILE_TEST_SECRETS.ALWAYS_PASSES:
        return;
      case TURNSTILE_TEST_SECRETS.ALWAYS_FAILS:
      case TURNSTILE_TEST_SECRETS.TOKEN_ALREADY_SPENT:
        throw captchaInvalid();
    }

    const body = new URLSearchParams({ secret: this.secret, response: token });
    if (ip) body.set('remoteip', ip);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
    let result: SiteverifyResponse;
    try {
      const response = await this.fetchImpl(TURNSTILE_VERIFY_URL, {
        method: 'POST',
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Turnstile respondió ${response.status}`);
      }
      result = (await response.json()) as SiteverifyResponse;
    } catch (error) {
      this.logger.error({
        message: 'No se pudo comprobar el captcha con Cloudflare',
        error: error instanceof Error ? error.message : String(error),
      });
      throw new AppException(
        503,
        ErrorCode.CAPTCHA_UNAVAILABLE,
        'No pudimos comprobar el captcha en este momento: vuelve a intentarlo en unos minutos',
      );
    } finally {
      clearTimeout(timer);
    }

    if (result.success !== true) {
      this.logger.warn({
        message: 'Captcha rechazado',
        errorCodes: result['error-codes'] ?? [],
      });
      throw captchaInvalid();
    }
  }
}
