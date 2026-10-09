import { envValidationSchema } from '../env.validation';

describe('Environment Validation Schema (Joi)', () => {
  const validEnv = {
    NODE_ENV: 'development',
    PORT: 4000,
    APP_NAME: 'Drinks on Chain Backend',
    DATABASE_URL:
      'postgresql://postgres:change-me@localhost:5435/drinks_on_chain_db',
    REDIS_URL: 'redis://localhost:6379',
    JWT_SECRET: 'super-secret-key-drinks-on-chain-min-32-chars',
    JWT_EXPIRES_IN: '900s',
    JWT_REFRESH_SECRET: 'super-secret-refresh-key-min-32-chars',
    CORS_ALLOWED_ORIGINS: 'http://localhost:3002',
    TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
  };

  const without = (key: string): Record<string, unknown> => {
    const copy: Record<string, unknown> = { ...validEnv };
    delete copy[key];
    return copy;
  };

  it('should validate a complete and correct environment configuration', () => {
    const { error, value } = envValidationSchema.validate(validEnv);
    expect(error).toBeUndefined();
    expect(value.PORT).toBe(4000);
    expect(value.NODE_ENV).toBe('development');
    expect(value.STELLAR_NETWORK).toBe('TESTNET');
  });

  it('should fail if DATABASE_URL is missing or invalid', () => {
    const { error } = envValidationSchema.validate(without('DATABASE_URL'));
    expect(error).toBeDefined();
    expect(error?.message).toContain(
      'DATABASE_URL is a required environment variable',
    );
  });

  it('should fail if JWT_SECRET is less than 32 characters', () => {
    const invalid = { ...validEnv, JWT_SECRET: 'short-secret' };
    const { error } = envValidationSchema.validate(invalid);
    expect(error).toBeDefined();
    expect(error?.message).toContain(
      'JWT_SECRET must be at least 32 characters long',
    );
  });

  it('valida las variables de la cadena solo si se definen (Ola 3; ver chain-config.spec)', () => {
    const invalid = { ...validEnv, CHAIN_SECRET_OPERATIONS: 'INVALID_KEY' };
    const { error } = envValidationSchema.validate(invalid);
    expect(error).toBeDefined();
    expect(error?.message).toContain(
      'CHAIN_SECRET_OPERATIONS no tiene el formato esperado',
    );
    expect(error?.message).not.toContain('INVALID_KEY');

    const { error: noKeyError } = envValidationSchema.validate(validEnv);
    expect(noKeyError).toBeUndefined();
  });

  it('el custodio ENV no arranca contra la red pública', () => {
    const { error } = envValidationSchema.validate({
      ...validEnv,
      STELLAR_NETWORK: 'PUBLIC',
      CHAIN_CUSTODY_DRIVER: 'ENV',
    });
    expect(error?.message).toContain(
      'CHAIN_CUSTODY_DRIVER=ENV no se admite con STELLAR_NETWORK=PUBLIC',
    );
  });

  it('should not require integrations that do not exist yet (OP-03)', () => {
    // Sin Dynamic, Supabase, pasarela bancaria, contratos CONTRACT_* ni
    // ninguna variable de la cadena: el backend arranca igual, con la cadena
    // deshabilitada y la emisión apagada (ADR-011).
    const { error, value } = envValidationSchema.validate(validEnv);
    expect(error).toBeUndefined();
    expect(value.CHAIN_MINT_ENABLED).toBe(false);
    expect(value.CHAIN_CUSTODY_DRIVER).toBeUndefined();
    expect(value.STELLAR_RPC_URL).toBeUndefined();
    // Las de antes de la Ola 3 ya no existen en el esquema
    expect(value).not.toHaveProperty('STELLAR_HORIZON_URL');
    expect(value).not.toHaveProperty('STELLAR_INDEXER_POLL_INTERVAL_MS');
  });

  it('should ignore legacy variables left in an old .env', () => {
    const legacy = {
      ...validEnv,
      DYNAMIC_API_KEY: 'legacy',
      SUPABASE_URL: 'https://legacy.supabase.co',
      CONTRACT_PRODUCT_NFT: 'legacy',
      // Variables de la cadena de antes de la Ola 3, aunque no sean válidas
      STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
      STELLAR_SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
      STELLAR_RELAYER_SECRET_KEY: 'legacy',
      STELLAR_INDEXER_POLL_INTERVAL_MS: '5000',
      // docker compose pasaba la red en minúsculas
      STELLAR_NETWORK: 'testnet',
    };
    const { error } = envValidationSchema.validate(legacy, {
      allowUnknown: true,
    });
    expect(error).toBeUndefined();
  });

  it('should apply default values for optional settings', () => {
    const minimal: Record<string, unknown> = { ...validEnv };
    delete minimal.PORT;
    delete minimal.NODE_ENV;
    delete minimal.CORS_ALLOWED_ORIGINS;

    const { error, value } = envValidationSchema.validate(minimal);
    expect(error).toBeUndefined();
    expect(value.PORT).toBe(4000);
    expect(value.NODE_ENV).toBe('development');
    expect(value.STORAGE_DRIVER).toBe('local');
  });

  describe('sesiones y límites (0.5)', () => {
    it('JWT_EXPIRES_IN por defecto es 900s y acepta duraciones', () => {
      const minimal: Record<string, unknown> = { ...validEnv };
      delete minimal.JWT_EXPIRES_IN;
      expect(envValidationSchema.validate(minimal).value.JWT_EXPIRES_IN).toBe(
        '900s',
      );
      expect(
        envValidationSchema.validate({ ...validEnv, JWT_EXPIRES_IN: '7d' })
          .error,
      ).toBeUndefined();
      expect(
        envValidationSchema.validate({ ...validEnv, JWT_EXPIRES_IN: 'siempre' })
          .error,
      ).toBeDefined();
    });

    it('JWT_REFRESH_EXPIRES_IN (obsoleta) se sigue aceptando', () => {
      expect(
        envValidationSchema.validate({
          ...validEnv,
          JWT_REFRESH_EXPIRES_IN: '30d',
        }).error,
      ).toBeUndefined();
    });

    it('TRUST_PROXY=true se rechaza; 1 se acepta', () => {
      expect(
        envValidationSchema.validate({ ...validEnv, TRUST_PROXY: 'true' }).error
          ?.message,
      ).toContain('TRUST_PROXY=true');
      expect(
        envValidationSchema.validate({ ...validEnv, TRUST_PROXY: '1' }).error,
      ).toBeUndefined();
    });

    it('PROXY_SHARED_SECRET: vacío o secretos de 32+ caracteres separados por comas', () => {
      const long = 'a'.repeat(32);
      expect(
        envValidationSchema.validate({ ...validEnv, PROXY_SHARED_SECRET: '' })
          .error,
      ).toBeUndefined();
      expect(
        envValidationSchema.validate({
          ...validEnv,
          PROXY_SHARED_SECRET: `${long},${'b'.repeat(40)}`,
        }).error,
      ).toBeUndefined();
      expect(
        envValidationSchema.validate({
          ...validEnv,
          PROXY_SHARED_SECRET: `${long},corto`,
        }).error?.message,
      ).toContain('PROXY_SHARED_SECRET');
    });

    it('límites y duraciones numéricos', () => {
      expect(
        envValidationSchema.validate({
          ...validEnv,
          RATE_LIMIT_GLOBAL_PER_MINUTE: 0,
        }).error,
      ).toBeDefined();
      expect(
        envValidationSchema.validate({
          ...validEnv,
          SESSION_TTL_STAFF_DAYS: '7',
          REFRESH_GRACE_SECONDS: '20',
          FEATURE_ENFORCE_ACTIVE_ORG: 'false',
        }).error,
      ).toBeUndefined();
    });
  });

  describe('CORS_ALLOWED_ORIGINS', () => {
    it('should reject a wildcard', () => {
      const { error } = envValidationSchema.validate({
        ...validEnv,
        CORS_ALLOWED_ORIGINS: '*',
      });
      expect(error?.message).toContain('is not allowed');
    });

    it('should reject a wildcard in production', () => {
      const { error } = envValidationSchema.validate({
        ...validEnv,
        NODE_ENV: 'production',
        CORS_ALLOWED_ORIGINS: 'https://erp.example.com,*',
      });
      expect(error?.message).toContain('is not allowed');
    });

    it('should be required in production', () => {
      const prod = {
        ...without('CORS_ALLOWED_ORIGINS'),
        NODE_ENV: 'production',
      };
      const { error } = envValidationSchema.validate(prod);
      expect(error?.message).toContain(
        'CORS_ALLOWED_ORIGINS is required in production',
      );

      const { error: emptyError } = envValidationSchema.validate({
        ...prod,
        CORS_ALLOWED_ORIGINS: '',
      });
      expect(emptyError?.message).toContain(
        'CORS_ALLOWED_ORIGINS is required in production',
      );
    });

    it('should accept an explicit list in production', () => {
      const { error } = envValidationSchema.validate({
        ...validEnv,
        NODE_ENV: 'production',
        CORS_ALLOWED_ORIGINS: 'https://erp.example.com,https://app.example.com',
      });
      expect(error).toBeUndefined();
    });
  });

  describe('cuenta, segundo factor e invitaciones (contrato O1)', () => {
    it('TURNSTILE_SECRET_KEY es obligatoria en producción', () => {
      const { error } = envValidationSchema.validate({
        ...without('TURNSTILE_SECRET_KEY'),
        NODE_ENV: 'production',
      });
      expect(error?.message).toContain(
        'TURNSTILE_SECRET_KEY is required in production',
      );
    });

    it('fuera de producción todo es opcional', () => {
      const { error } = envValidationSchema.validate(
        without('TURNSTILE_SECRET_KEY'),
      );
      expect(error).toBeUndefined();
    });

    it('MFA_ENCRYPTION_KEY exige 32 caracteres', () => {
      const { error } = envValidationSchema.validate({
        ...validEnv,
        MFA_ENCRYPTION_KEY: 'corta',
      });
      expect(error?.message).toContain('MFA_ENCRYPTION_KEY');
    });

    it('APP_URL_* deben ser URL http(s)', () => {
      expect(
        envValidationSchema.validate({
          ...validEnv,
          APP_URL_ERP: 'https://drinks-on-chain-erp.vercel.app',
        }).error,
      ).toBeUndefined();
      expect(
        envValidationSchema.validate({ ...validEnv, APP_URL_ERP: 'ftp://x' })
          .error,
      ).toBeDefined();
    });
  });
});
