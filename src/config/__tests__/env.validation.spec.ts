import { envValidationSchema } from '../env.validation';

describe('Environment Validation Schema (Joi)', () => {
  const validEnv = {
    NODE_ENV: 'development',
    PORT: 3000,
    APP_NAME: 'Drinks on Chain Backend',
    DATABASE_URL: 'postgresql://postgres:postgrespassword@localhost:5432/drinks_on_chain_db',
    REDIS_URL: 'redis://localhost:6379',
    JWT_SECRET: 'super-secret-key-drinks-on-chain-min-32-chars',
    JWT_EXPIRES_IN: '7d',
    JWT_REFRESH_SECRET: 'super-secret-refresh-key-min-32-chars',
    JWT_REFRESH_EXPIRES_IN: '30d',
    STELLAR_NETWORK: 'testnet',
    STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
    STELLAR_SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
    STELLAR_RELAYER_SECRET_KEY:
      'S0000000000000000000000000000000000000000000000000000000',
    CONTRACT_PRODUCER_REGISTRY:
      'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    CONTRACT_BATCH_ANCHOR:
      'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    CONTRACT_PRODUCT_NFT:
      'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    CONTRACT_CLAIM_ESCROW:
      'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    DYNAMIC_ENVIRONMENT_ID: 'dynamic-env-id-123',
    DYNAMIC_API_KEY: 'dynamic-api-key-456',
    SUPABASE_URL: 'https://test-project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-789',
    PAYMENT_BANK_API_KEY: 'bank-key',
    PAYMENT_BANK_API_SECRET: 'bank-secret',
    PAYMENT_BANK_BASE_URL: 'https://api.banco.bo/v1',
    PAYMENT_BANK_WEBHOOK_SECRET: 'bank-webhook-secret',
    STELLAR_INDEXER_POLL_INTERVAL_MS: 5000,
    STELLAR_INDEXER_START_LEDGER: 0,
    CORS_ALLOWED_ORIGINS: 'http://localhost:3000',
  };

  it('should validate a complete and correct environment configuration', () => {
    const { error, value } = envValidationSchema.validate(validEnv);
    expect(error).toBeUndefined();
    expect(value.PORT).toBe(3000);
    expect(value.NODE_ENV).toBe('development');
    expect(value.STELLAR_NETWORK).toBe('testnet');
  });

  it('should fail if DATABASE_URL is missing or invalid', () => {
    const invalid = { ...validEnv };
    delete (invalid as Record<string, unknown>).DATABASE_URL;

    const { error } = envValidationSchema.validate(invalid);
    expect(error).toBeDefined();
    expect(error?.message).toContain('DATABASE_URL is a required environment variable');
  });

  it('should fail if JWT_SECRET is less than 32 characters', () => {
    const invalid = { ...validEnv, JWT_SECRET: 'short-secret' };
    const { error } = envValidationSchema.validate(invalid);
    expect(error).toBeDefined();
    expect(error?.message).toContain('JWT_SECRET must be at least 32 characters long');
  });

  it('should fail if STELLAR_RELAYER_SECRET_KEY is not a valid 56-char seed starting with S', () => {
    const invalid = { ...validEnv, STELLAR_RELAYER_SECRET_KEY: 'INVALID_KEY' };
    const { error } = envValidationSchema.validate(invalid);
    expect(error).toBeDefined();
    expect(error?.message).toContain('STELLAR_RELAYER_SECRET_KEY must be a valid 56-character Stellar secret seed');
  });

  it('should fail if a Soroban contract address does not start with C or is not 56 chars', () => {
    const invalid = { ...validEnv, CONTRACT_PRODUCER_REGISTRY: 'G_INVALID_ADDRESS' };
    const { error } = envValidationSchema.validate(invalid);
    expect(error).toBeDefined();
    expect(error?.message).toContain('CONTRACT_PRODUCER_REGISTRY must be a valid 56-character Soroban contract address');
  });

  it('should apply default values for optional settings', () => {
    const minimal = { ...validEnv };
    delete (minimal as Record<string, unknown>).PORT;
    delete (minimal as Record<string, unknown>).NODE_ENV;
    delete (minimal as Record<string, unknown>).STELLAR_INDEXER_POLL_INTERVAL_MS;

    const { error, value } = envValidationSchema.validate(minimal);
    expect(error).toBeUndefined();
    expect(value.PORT).toBe(3000);
    expect(value.NODE_ENV).toBe('development');
    expect(value.STELLAR_INDEXER_POLL_INTERVAL_MS).toBe(5000);
  });
});
