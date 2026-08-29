export interface EnvironmentVariables {
  // Servidor HTTP
  NODE_ENV: 'development' | 'production' | 'test';
  PORT: number;
  APP_NAME: string;

  // Base de Datos PostgreSQL
  DATABASE_URL: string;

  // Redis (BullMQ)
  REDIS_URL: string;

  // JWT
  JWT_SECRET: string;
  JWT_EXPIRES_IN: string;
  JWT_REFRESH_SECRET: string;
  JWT_REFRESH_EXPIRES_IN: string;

  // Stellar / Soroban Blockchain
  STELLAR_NETWORK: 'testnet' | 'mainnet' | 'futurenet' | 'standalone';
  STELLAR_HORIZON_URL: string;
  STELLAR_SOROBAN_RPC_URL: string;
  STELLAR_RELAYER_SECRET_KEY: string;

  // Contratos Soroban
  CONTRACT_PRODUCER_REGISTRY: string;
  CONTRACT_BATCH_ANCHOR: string;
  CONTRACT_PRODUCT_NFT: string;
  CONTRACT_CLAIM_ESCROW: string;

  // Dynamic Wallets
  DYNAMIC_ENVIRONMENT_ID: string;
  DYNAMIC_API_KEY: string;

  // Supabase Storage
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;

  // Pasarela de Pagos (Banco API)
  PAYMENT_BANK_API_KEY: string;
  PAYMENT_BANK_API_SECRET: string;
  PAYMENT_BANK_BASE_URL: string;
  PAYMENT_BANK_WEBHOOK_SECRET: string;

  // Indexer
  STELLAR_INDEXER_POLL_INTERVAL_MS: number;
  STELLAR_INDEXER_START_LEDGER: number;

  // CORS
  CORS_ALLOWED_ORIGINS: string;
}
