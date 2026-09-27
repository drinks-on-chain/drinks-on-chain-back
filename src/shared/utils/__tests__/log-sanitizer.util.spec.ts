import { sanitizeLogData } from '../log-sanitizer.util';

describe('LogSanitizerUtil', () => {
  it('should redact sensitive password and secret keys in object', () => {
    const rawData = {
      email: 'user@example.com',
      password: 'mySecretPassword123',
      pin: '1234',
      token: 'jwt.token.here',
      publicInfo: 'visible',
    };

    const sanitized = sanitizeLogData(rawData) as Record<string, unknown>;

    expect(sanitized.email).toBe('user@example.com');
    expect(sanitized.publicInfo).toBe('visible');
    expect(sanitized.password).toBe('***REDACTED***');
    expect(sanitized.pin).toBe('***REDACTED***');
    expect(sanitized.token).toBe('***REDACTED***');
  });

  it('should redact 56-char Stellar secret seed strings starting with S', () => {
    const stellarSecret =
      'S0000000000000000000000000000000000000000000000000000000';
    const rawData = {
      relayerKey: stellarSecret,
      stellarAccount:
        'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    };

    const sanitized = sanitizeLogData(rawData) as Record<string, unknown>;

    expect(sanitized.relayerKey).toBe('S***[STELLAR_SECRET_REDACTED]***');
    expect(sanitized.stellarAccount).toBe(
      'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    );
  });

  it('should recursively sanitize nested objects and arrays', () => {
    const rawData = {
      users: [
        { name: 'Alice', password_hash: 'hash123' },
        { name: 'Bob', password_hash: 'hash456' },
      ],
      config: {
        nested: {
          apiKey: 'secret-api-key',
        },
      },
    };

    const sanitized = sanitizeLogData(rawData) as {
      users: Array<{ name: string; password_hash: string }>;
      config: { nested: { apiKey: string } };
    };

    expect(sanitized.users[0].password_hash).toBe('***REDACTED***');
    expect(sanitized.users[1].password_hash).toBe('***REDACTED***');
    expect(sanitized.config.nested.apiKey).toBe('***REDACTED***');
  });
});
