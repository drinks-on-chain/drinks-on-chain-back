import { ConfigService } from '@nestjs/config';
import {
  CaptchaService,
  TURNSTILE_TEST_SECRETS,
} from '@shared/captcha/captcha.service';
import {
  assertStrongPassword,
  passwordProblems,
} from '../account/password-policy';
import { MfaCrypto } from '../mfa/mfa-crypto';
import {
  currentTotp,
  newRecoveryCode,
  newTotpSecret,
  normalizeRecoveryCode,
  totpUri,
  verifyTotp,
} from '../mfa/totp';

const config = (values: Record<string, string | undefined>) =>
  ({
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      const v = values[key];
      if (v === undefined) throw new Error(key);
      return v;
    },
  }) as unknown as ConfigService;

const JWT_SECRET = 'jwt-secret-for-tests-at-least-32-characters';

describe('Política de contraseñas (contrato O1 §1)', () => {
  it('acepta una frase larga', () => {
    expect(passwordProblems('vendimia-de-altura-2026')).toEqual([]);
  });

  it.each([
    ['corta', 'al menos 10'],
    ['password123', 'común'],
    ['1234567890', 'común'],
    ['aaaaaaaaaaaa', 'repetido'],
    ['abcdefghijklm', 'secuencia'],
  ])('rechaza %s', (password, fragment) => {
    expect(passwordProblems(password).join(' ')).toContain(fragment);
  });

  it('rechaza el propio correo', () => {
    expect(
      passwordProblems('ana.gutierrez', { email: 'ana.gutierrez@x.bo' }),
    ).toContain('No puede ser tu dirección de correo');
  });

  it('422 AUTH_WEAK_PASSWORD con un detalle por problema en el campo', () => {
    expect(() => assertStrongPassword('corta', 'newPassword')).toThrow(
      expect.objectContaining({
        statusCode: 422,
        errorCode: 'AUTH_WEAK_PASSWORD',
        details: [
          {
            field: 'newPassword',
            message: 'La contraseña debe tener al menos 10 caracteres',
          },
        ],
      }),
    );
  });
});

describe('TOTP (PLT-05)', () => {
  it('acepta el código actual y el del paso anterior, y no el mismo paso dos veces', () => {
    const secret = newTotpSecret();
    const now = Math.floor(Date.now() / 1000);
    const step = verifyTotp(secret, currentTotp(secret, now), null);
    expect(step).not.toBeNull();
    // ±30 s de deriva
    expect(verifyTotp(secret, currentTotp(secret, now - 30), null)).not.toBe(
      null,
    );
    // Repetición: no se acepta un paso ya usado
    expect(verifyTotp(secret, currentTotp(secret, now), step)).toBeNull();
    // Fuera de la ventana
    expect(verifyTotp(secret, currentTotp(secret, now - 120), null)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', null)).toBeNull();
  });

  it('admite el secreto de demostración de los mocks (15 bytes)', () => {
    const demo = 'DRINKSONCHAINDEMOTOTPKEY';
    expect(verifyTotp(demo, currentTotp(demo), null)).not.toBeNull();
  });

  it('URI otpauth con el emisor', () => {
    expect(totpUri('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', 'a@b.bo')).toMatch(
      /^otpauth:\/\/totp\/Drinks%20on%20Chain:a%40b\.bo\?secret=/,
    );
  });

  it('códigos de recuperación XXXXX-XXXXX normalizables', () => {
    const code = newRecoveryCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(normalizeRecoveryCode(` ${code.toLowerCase()} `)).toBe(
      code.replace('-', ''),
    );
    expect(normalizeRecoveryCode('123')).toBeNull();
  });
});

describe('MfaCrypto', () => {
  it('cifra y descifra con la clave del entorno; no se lee con otra', () => {
    const a = new MfaCrypto(
      config({ JWT_SECRET, MFA_ENCRYPTION_KEY: 'k'.repeat(40) }),
    );
    const b = new MfaCrypto(
      config({ JWT_SECRET, MFA_ENCRYPTION_KEY: 'z'.repeat(40) }),
    );
    const payload = a.encrypt('SECRETO');
    expect(payload.startsWith('v1.')).toBe(true);
    expect(payload).not.toContain('SECRETO');
    expect(a.decrypt(payload)).toBe('SECRETO');
    expect(() => b.decrypt(payload)).toThrow();
  });

  it('sin clave usa la derivada de JWT_SECRET y al definirla sigue leyendo lo anterior', () => {
    const fallback = new MfaCrypto(config({ JWT_SECRET }));
    expect(fallback.usesFallbackKey).toBe(true);
    const old = fallback.encrypt('SECRETO');
    const oldCode = fallback.hashRecoveryCode('ABCDE12345');

    const configured = new MfaCrypto(
      config({ JWT_SECRET, MFA_ENCRYPTION_KEY: 'k'.repeat(40) }),
    );
    expect(configured.decrypt(old)).toBe('SECRETO');
    expect(configured.needsReencrypt(old)).toBe(true);
    expect(configured.recoveryCodeHashCandidates('ABCDE12345')).toContain(
      oldCode,
    );
  });
});

describe('CaptchaService (Turnstile)', () => {
  it('clave de prueba que siempre valida: sin red', async () => {
    const captcha = new CaptchaService(config({ NODE_ENV: 'test' }));
    const fetchImpl = jest.fn();
    captcha.useFetch(fetchImpl);
    await expect(captcha.verify('XXXX.DUMMY.TOKEN.XXXX', null)).resolves.toBe(
      undefined,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(captcha.verify('', null)).rejects.toMatchObject({
      errorCode: 'CAPTCHA_INVALID',
    });
  });

  it('clave de prueba que siempre falla → 422 CAPTCHA_INVALID en captchaToken', async () => {
    const captcha = new CaptchaService(
      config({ TURNSTILE_SECRET_KEY: TURNSTILE_TEST_SECRETS.ALWAYS_FAILS }),
    );
    await expect(captcha.verify('tok', null)).rejects.toMatchObject({
      statusCode: 422,
      errorCode: 'CAPTCHA_INVALID',
      details: [expect.objectContaining({ field: 'captchaToken' })],
    });
  });

  it('clave real: pregunta a Cloudflare; sin respuesta → 503', async () => {
    const captcha = new CaptchaService(
      config({ TURNSTILE_SECRET_KEY: '0x4AAAAAAAreal-secret' }),
    );
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: false, 'error-codes': ['bad'] }),
      })
      .mockRejectedValueOnce(new Error('sin red'));
    captcha.useFetch(fetchImpl);

    await expect(captcha.verify('tok', '203.0.113.7')).resolves.toBe(undefined);
    const body = fetchImpl.mock.calls[0][1].body as URLSearchParams;
    expect(body.get('remoteip')).toBe('203.0.113.7');
    await expect(captcha.verify('tok', null)).rejects.toMatchObject({
      errorCode: 'CAPTCHA_INVALID',
    });
    await expect(captcha.verify('tok', null)).rejects.toMatchObject({
      statusCode: 503,
      errorCode: 'CAPTCHA_UNAVAILABLE',
    });
  });
});
