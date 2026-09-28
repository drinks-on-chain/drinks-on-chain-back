import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import {
  parseDurationSeconds,
  sessionSettingsFromConfig,
} from '../sessions/session.config';
import {
  readCookie,
  readRefreshToken,
  useSecureCookie,
} from '../sessions/refresh-cookie';
import {
  DEFAULT_LOGIN_ATTEMPT_POLICY,
  lockSecondsFor,
} from '../rate-limit/login-attempts.service';
import { parseTrustProxy } from '../../../config/trust-proxy.config';

const config = (values: Record<string, unknown>) =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

describe('session.config', () => {
  it.each([
    ['900', 900],
    ['900s', 900],
    ['15m', 900],
    ['1h', 3600],
    ['7d', 604800],
    [900, 900],
    ['x', null],
    ['', null],
    [undefined, null],
  ])('parseDurationSeconds(%p) = %p', (raw, expected) => {
    expect(parseDurationSeconds(raw as string)).toBe(expected);
  });

  it('el acceso nunca pasa de 15 min aunque JWT_EXPIRES_IN pida más (SE-03)', () => {
    expect(
      sessionSettingsFromConfig(config({ JWT_EXPIRES_IN: '7d' }))
        .accessTokenTtlSeconds,
    ).toBe(900);
    expect(
      sessionSettingsFromConfig(config({ JWT_EXPIRES_IN: '5m' }))
        .accessTokenTtlSeconds,
    ).toBe(300);
  });

  it('valores por defecto: 7 días personal, 30 consumidores, 20 s de gracia', () => {
    const settings = sessionSettingsFromConfig(config({}));
    expect(settings.staffSessionTtlSeconds).toBe(7 * 86400);
    expect(settings.consumerSessionTtlSeconds).toBe(30 * 86400);
    expect(settings.refreshGraceSeconds).toBe(20);
    // SE-05 activo por defecto desde la Ola 1; `false` lo deja en aviso
    expect(settings.enforceActiveOrganization).toBe(true);
    expect(
      sessionSettingsFromConfig(config({ FEATURE_ENFORCE_ACTIVE_ORG: false }))
        .enforceActiveOrganization,
    ).toBe(false);
    expect(
      sessionSettingsFromConfig(config({ FEATURE_ENFORCE_ACTIVE_ORG: 'false' }))
        .enforceActiveOrganization,
    ).toBe(false);
    expect(
      sessionSettingsFromConfig(config({ FEATURE_ENFORCE_ACTIVE_ORG: true }))
        .enforceActiveOrganization,
    ).toBe(true);
  });
});

describe('refresh-cookie', () => {
  const req = (headers: Record<string, string>) =>
    ({ headers }) as unknown as Request;

  it('Secure siempre salvo en desarrollo con origen localhost', () => {
    expect(useSecureCookie('production', req({}))).toBe(true);
    expect(
      useSecureCookie('test', req({ origin: 'http://localhost:3002' })),
    ).toBe(true);
    expect(
      useSecureCookie('development', req({ origin: 'http://localhost:3002' })),
    ).toBe(false);
    expect(
      useSecureCookie('development', req({ host: '127.0.0.1:4000' })),
    ).toBe(false);
    expect(
      useSecureCookie(
        'development',
        req({ origin: 'https://erp.136.243.223.39.sslip.io' }),
      ),
    ).toBe(true);
  });

  it('lee el refresco solo de la cookie doc_rt (el cuerpo se retiró en H1)', () => {
    const withCookie = req({ cookie: 'a=1; doc_rt=abc.1.xyz; b=2' });
    expect(readCookie(withCookie, 'doc_rt')).toBe('abc.1.xyz');
    expect(readRefreshToken(withCookie)).toBe('abc.1.xyz');
    expect(readRefreshToken(req({ cookie: 'a=1' }))).toBeNull();
    expect(readRefreshToken(req({}))).toBeNull();
  });
});

describe('bloqueo progresivo (IAM-07)', () => {
  const policy = DEFAULT_LOGIN_ATTEMPT_POLICY;

  it('sin bloqueo por debajo del umbral y el doble con cada fallo de más, con tope', () => {
    expect(lockSecondsFor(4, 5, policy)).toBe(0);
    expect(lockSecondsFor(5, 5, policy)).toBe(60);
    expect(lockSecondsFor(6, 5, policy)).toBe(120);
    expect(lockSecondsFor(7, 5, policy)).toBe(240);
    expect(lockSecondsFor(50, 5, policy)).toBe(policy.maxLockSeconds);
  });
});

describe('TRUST_PROXY (SE-06)', () => {
  it.each([
    [undefined, false],
    ['', false],
    ['false', false],
    ['1', 1],
    ['loopback', 'loopback'],
  ])('%p → %p', (raw, expected) => {
    expect(parseTrustProxy(raw)).toBe(expected);
  });

  it('rechaza true (cualquiera elegiría su IP)', () => {
    expect(() => parseTrustProxy('true')).toThrow(/TRUST_PROXY/);
  });
});
