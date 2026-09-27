import {
  DEFAULT_SUPERADMIN_NAME,
  SeedConfigError,
  seedOptionsFromEnv,
} from '../seed.options';

describe('seedOptionsFromEnv', () => {
  it('sin variables: ni superusuario ni demo, con aviso', () => {
    const { options, warnings } = seedOptionsFromEnv({});
    expect(options.superadmin).toBeNull();
    expect(options.demo).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  it('nunca usa una contraseña por defecto: sin SUPERADMIN_PASSWORD no hay superusuario', () => {
    const { options, warnings } = seedOptionsFromEnv({
      SUPERADMIN_EMAIL: 'root@example.test',
    });
    expect(options.superadmin).toBeNull();
    expect(warnings[0]).toMatch(/SUPERADMIN_PASSWORD/);
  });

  it('superusuario desde el entorno (correo en minúsculas, nombre por defecto)', () => {
    const { options, warnings } = seedOptionsFromEnv({
      SUPERADMIN_EMAIL: ' Root@Example.TEST ',
      SUPERADMIN_PASSWORD: 'una-clave-larga',
    });
    expect(warnings).toEqual([]);
    expect(options.superadmin).toEqual({
      email: 'root@example.test',
      password: 'una-clave-larga',
      fullName: DEFAULT_SUPERADMIN_NAME,
    });
  });

  it.each(['change-me', 'change-me-please', 'corta'])(
    'rechaza la contraseña "%s"',
    (password) => {
      expect(() =>
        seedOptionsFromEnv({
          SUPERADMIN_EMAIL: 'root@example.test',
          SUPERADMIN_PASSWORD: password,
        }),
      ).toThrow(SeedConfigError);
      expect(() =>
        seedOptionsFromEnv({ SEED_DEMO: 'true', SEED_DEMO_PASSWORD: password }),
      ).toThrow(SeedConfigError);
    },
  );

  it.each(['root', 'change-me@example.com'])(
    'rechaza el correo "%s"',
    (email) => {
      expect(() =>
        seedOptionsFromEnv({
          SUPERADMIN_EMAIL: email,
          SUPERADMIN_PASSWORD: 'una-clave-larga',
        }),
      ).toThrow(SeedConfigError);
    },
  );

  it('SEED_DEMO=true exige SEED_DEMO_PASSWORD', () => {
    expect(() => seedOptionsFromEnv({ SEED_DEMO: 'true' })).toThrow(
      /SEED_DEMO_PASSWORD/,
    );
    const { options } = seedOptionsFromEnv({
      SEED_DEMO: 'TRUE',
      SEED_DEMO_PASSWORD: 'demo-larga-123',
    });
    expect(options.demo).toEqual({ password: 'demo-larga-123' });
  });

  it('SEED_DEMO distinto de true: sin demo; un valor raro es un error', () => {
    expect(
      seedOptionsFromEnv({ SEED_DEMO: 'false', SEED_DEMO_PASSWORD: 'x' })
        .options.demo,
    ).toBeNull();
    expect(() => seedOptionsFromEnv({ SEED_DEMO: 'si' })).toThrow(
      SeedConfigError,
    );
  });
});
