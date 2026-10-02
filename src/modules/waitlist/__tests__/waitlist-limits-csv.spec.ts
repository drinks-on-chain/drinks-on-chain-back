import type Redis from 'ioredis';
import { RetryAfterException } from '@shared/exceptions/app.exception';
import { CSV_BOM } from '@modules/audit/audit-csv';
import type { WaitlistEntryDto } from '../dto/waitlist.dto';
import { WAITLIST_DEFAULTS, waitlistConfig } from '../waitlist.config';
import { WaitlistKeys, WaitlistRateLimiter } from '../waitlist-rate-limiter';
import {
  WAITLIST_CSV_COLUMNS,
  waitlistCsvHeader,
  waitlistCsvRow,
  waitlistExportFilename,
} from '../waitlist-csv';

/** Redis mínimo en memoria: INCR, EXPIRE y TTL. */
function fakeRedis(status = 'ready') {
  const counters = new Map<string, number>();
  const ttls = new Map<string, number>();
  return {
    status,
    counters,
    ttls,
    connect: jest.fn().mockResolvedValue(undefined),
    once: jest.fn(),
    off: jest.fn(),
    incr: jest.fn((key: string) => {
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return Promise.resolve(next);
    }),
    expire: jest.fn((key: string, seconds: number) => {
      ttls.set(key, seconds);
      return Promise.resolve(1);
    }),
    ttl: jest.fn((key: string) => Promise.resolve(ttls.get(key) ?? -1)),
  };
}

const ENV_KEYS = [
  'WAITLIST_LIMIT_IP_MINUTE',
  'WAITLIST_LIMIT_IP_HOUR',
  'WAITLIST_LIMIT_EMAIL_HOUR',
  'WAITLIST_CAPTCHA_REQUIRED',
] as const;

describe('Lista de espera · configuración y límites', () => {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });
  afterAll(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('valores por defecto del contrato: 20/min y 300/h por IP, 3/h por correo, sin captcha', () => {
    expect(waitlistConfig({})).toEqual({
      ipPerMinute: 20,
      ipPerHour: 300,
      emailPerHour: 3,
      captchaRequired: false,
    });
    expect(WAITLIST_DEFAULTS).toEqual({
      ipPerMinute: 20,
      ipPerHour: 300,
      emailPerHour: 3,
    });
  });

  it('se configuran por entorno; un valor inválido cae al de por defecto', () => {
    expect(
      waitlistConfig({
        WAITLIST_LIMIT_IP_MINUTE: '50',
        WAITLIST_LIMIT_IP_HOUR: '1000',
        WAITLIST_LIMIT_EMAIL_HOUR: '0',
        WAITLIST_CAPTCHA_REQUIRED: ' TRUE ',
      }),
    ).toEqual({
      ipPerMinute: 50,
      ipPerHour: 1000,
      emailPerHour: 3,
      captchaRequired: true,
    });
    expect(
      waitlistConfig({ WAITLIST_CAPTCHA_REQUIRED: '1' }).captchaRequired,
    ).toBe(false);
  });

  it('por correo: 3 por hora y la cuarta → 429 con los segundos que faltan', async () => {
    const redis = fakeRedis();
    const limiter = new WaitlistRateLimiter(redis as unknown as Redis);
    const email = 'lucia@example.com';
    for (let i = 0; i < 3; i++) {
      await expect(limiter.checkEmail(email)).resolves.toBeUndefined();
    }
    const key = WaitlistKeys.emailHour(email);
    // El correo va como hash: sin datos personales en Redis
    expect(key).not.toContain('lucia');
    expect(redis.expire).toHaveBeenCalledTimes(1);
    redis.ttls.set(key, 1234);
    const error = await limiter.checkEmail(email).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RetryAfterException);
    expect(error).toMatchObject({
      statusCode: 429,
      errorCode: 'TOO_MANY_REQUESTS',
      retryAfterSeconds: 1234,
    });
    // Otro correo no se ve afectado
    await expect(limiter.checkEmail('otro@example.com')).resolves.toBe(
      undefined,
    );
  });

  it('por IP: límite por hora configurable; sin IP no cuenta', async () => {
    process.env.WAITLIST_LIMIT_IP_HOUR = '2';
    const redis = fakeRedis();
    const limiter = new WaitlistRateLimiter(redis as unknown as Redis);
    await limiter.checkIp('203.0.113.9');
    await limiter.checkIp('203.0.113.9');
    await expect(limiter.checkIp('203.0.113.9')).rejects.toMatchObject({
      statusCode: 429,
      retryAfterSeconds: 3600,
    });
    await expect(limiter.checkIp('203.0.113.10')).resolves.toBeUndefined();
    await expect(limiter.checkIp(null)).resolves.toBeUndefined();
  });

  it('clave sin caducidad: se le vuelve a poner y se anuncia una hora', async () => {
    process.env.WAITLIST_LIMIT_IP_HOUR = '1';
    const redis = fakeRedis();
    const limiter = new WaitlistRateLimiter(redis as unknown as Redis);
    await limiter.checkIp('203.0.113.9');
    redis.ttls.clear();
    await expect(limiter.checkIp('203.0.113.9')).rejects.toMatchObject({
      retryAfterSeconds: 3600,
    });
    expect(redis.ttls.get(WaitlistKeys.ipHour('203.0.113.9'))).toBe(3600);
  });

  it('sin Redis no bloquea a nadie', async () => {
    process.env.WAITLIST_LIMIT_EMAIL_HOUR = '1';
    const down = fakeRedis('wait');
    const limiter = new WaitlistRateLimiter(down as unknown as Redis);
    await limiter.checkEmail('a@example.com');
    await expect(limiter.checkEmail('a@example.com')).resolves.toBeUndefined();
    expect(down.connect).toHaveBeenCalled();
    expect(down.incr).not.toHaveBeenCalled();

    const failing = fakeRedis();
    failing.incr.mockRejectedValue(new Error('ECONNRESET'));
    const second = new WaitlistRateLimiter(failing as unknown as Redis);
    await expect(second.checkIp('203.0.113.9')).resolves.toBeUndefined();
  });
});

describe('Lista de espera · CSV', () => {
  const entry: WaitlistEntryDto = {
    id: '00000000-0000-4000-8000-000000000001',
    type: 'WINERY',
    position: 3,
    status: 'CONTACTED',
    fullName: '=HYPERLINK("http://malo")',
    email: 'rodrigo@altocamargo.test',
    phone: '+591 72110022',
    city: null,
    interest: null,
    wineryName: 'Viñas "Alto", Camargo',
    region: 'Valle de Cinti',
    produces: 'BOTH',
    message: 'Primera línea\nsegunda',
    locale: 'es',
    source: 'tarija-2026',
    consentAt: '2026-10-01T15:00:00.000Z',
    createdAt: '2026-10-01T15:00:00.000Z',
    contactedAt: '2026-10-01T16:00:00.000Z',
    contactedBy: 'Valeria Méndez',
    notes: '@interno',
  };

  it('cabecera con BOM y sin IP ni agente de usuario', () => {
    const header = waitlistCsvHeader();
    expect(header.startsWith(CSV_BOM)).toBe(true);
    expect(header.endsWith('\r\n')).toBe(true);
    expect(header.slice(1).trim().split(',')).toEqual([
      ...WAITLIST_CSV_COLUMNS,
    ]);
    expect(WAITLIST_CSV_COLUMNS).not.toContain('ip');
    expect(WAITLIST_CSV_COLUMNS).not.toContain('userAgent');
    expect(WAITLIST_CSV_COLUMNS).not.toContain('id');
  });

  it('celdas protegidas contra fórmulas, comillas, comas y saltos', () => {
    expect(waitlistCsvRow(entry)).toBe(
      [
        '3',
        'WINERY',
        'CONTACTED',
        `"'=HYPERLINK(""http://malo"")"`,
        'rodrigo@altocamargo.test',
        `'+591 72110022`,
        '',
        '',
        '"Viñas ""Alto"", Camargo"',
        'Valle de Cinti',
        'BOTH',
        '"Primera línea\nsegunda"',
        'es',
        'tarija-2026',
        '2026-10-01T15:00:00.000Z',
        '2026-10-01T15:00:00.000Z',
        '2026-10-01T16:00:00.000Z',
        'Valeria Méndez',
        `'@interno`,
      ].join(',') + '\r\n',
    );
  });

  it('nombre del archivo con fecha y hora UTC', () => {
    expect(waitlistExportFilename(new Date('2026-10-01T14:30:59.000Z'))).toBe(
      'lista-de-espera-20261001-1430.csv',
    );
  });
});
